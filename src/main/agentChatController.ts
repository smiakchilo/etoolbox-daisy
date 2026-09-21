import type { AgentService, AgentServiceError } from '../agent/agentService';
import type { CurrentAemToolContext } from '../agent/aemTool';
import type {
  AgentChatByIdRequest,
  AgentChatError,
  AgentChatOpenConversationRequest,
  AgentChatOpenResult,
  AgentChatSendMessageRequest,
  AgentChatSendResult,
  AgentChatStatus,
  AgentChatVoidResult,
  AgentEvent,
  RequiredAction,
  SessionStatus,
  ToolErrorCode,
} from '../shared';
import {
  applyAgentEvent,
  type CanSendBlockReason,
  canSendMessage,
  type ChatId,
  type IdGenerator,
  type MessageId,
  newTurnId,
  type ServerId,
  type ToolCallId,
  type TurnId,
} from '../shared';
import type { Logger } from './logger';

/**
 * Puts the application-owned `AgentService` (implementation-plan.md step 07)
 * behind a plain, Electron-free controller: `src/main/ipc/agentChat.ts` is a
 * thin `ipcMain`/`sender.send` wrapper around this, following the same split
 * `browserController.ts`/`ipc/browser.ts` already use. Kept Electron-light
 * so it is unit-testable directly against `fakeAgentService.ts` with no
 * Electron runtime.
 *
 * ONE ACTIVE CONVERSATION - the core job of this module.
 *
 * `AgentService` itself already enforces one active conversation
 * (`agentService.ts`'s `OpenConversationRequest`/`SendPromptRequest` docs):
 * opening a different chat implicitly tears the previous one down, and a
 * second prompt over an unfinished turn is refused, not queued. This
 * controller adds a *second, independent* guard at the IPC-forwarding
 * boundary, deliberately mirroring `sdkAgentService.ts`'s own
 * `wrapToolExecutor` pattern (`currentTurn === turnAtInvocation`): every
 * event this controller receives from `agentService.onEvent` is checked
 * against its own `activeChatId`/`activeTurn` bookkeeping before being
 * forwarded to `onEvent` listeners (ultimately the renderer). A late event
 * from a turn this controller no longer recognises as current - for example
 * one still in flight from a chat the caller has since switched away from -
 * is dropped silently: never forwarded, never queued for later delivery.
 * This is defense-in-depth on top of the service's own guarantee, not a
 * replacement for it; the two are independent, exactly like
 * `fakeAgentService.test.ts`'s outside-in `applyAgentEvent` replay is
 * independent of the fake's own internal self-check.
 *
 * Opening a new conversation, closing one, and pressing Stop all reset this
 * controller's own `activeChatId`/`activeTurn` *before* calling into
 * `agentService` (see `openConversation`/`closeConversation` below) so that
 * any event the service emits synchronously during that call - most notably
 * the previous chat's own teardown sequence - is already excluded by the
 * ownership guard rather than raced against it.
 *
 * Abort is deliberately not treated as an error: `abort` only ever delegates
 * to `agentService.abort`, and the resulting `cancelling` -> `idle`
 * `session.state.changed` events flow through the exact same ownership-
 * checked pipe as any other event. This controller never synthesises an
 * `error` `AgentEvent` for a user-initiated Stop.
 */

/**
 * The AEM server context this controller needs to bind
 * `CurrentAemToolContext.origin`/`serverId`/`serverRevision` - a superset of
 * `bridgeBroker.ts`'s `CurrentAemContext`, adding the two identity fields
 * that module does not carry. Supplied by the composition root
 * (`src/main/index.ts`), sourced from the same settings/browser state the
 * bridge broker itself reads - not a second, competing notion of "the
 * current server".
 */
export interface AemServerContext {
  readonly origin: string;
  readonly serverId: ServerId;
  readonly serverRevision: number;
}

export interface AgentChatControllerDeps {
  readonly agentService: AgentService;
  readonly logger: Logger;
  /** Mints every `TurnId` this controller needs (never `ChatId` - always caller-supplied, per `agentService.ts`). */
  readonly idGenerator: IdGenerator;
  /**
   * The currently selected AEM server, or `undefined` if none is selected.
   * Called fresh every time `currentAemToolContext()` is invoked - never
   * cached by this controller - so a server switch mid-turn is reflected in
   * the very next tool call.
   */
  readonly currentAemServerContext: () => AemServerContext | undefined;
  /** `NavigationEpochTracker.current`, read fresh for the same reason as `currentAemServerContext`. */
  readonly navigationEpoch: () => number;
}

export interface AgentChatController {
  getStatus(): AgentChatStatus;
  openConversation(request: AgentChatOpenConversationRequest): Promise<AgentChatOpenResult>;
  sendMessage(request: AgentChatSendMessageRequest): Promise<AgentChatSendResult>;
  abort(request: AgentChatByIdRequest): Promise<AgentChatVoidResult>;
  closeConversation(request: AgentChatByIdRequest): Promise<AgentChatVoidResult>;
  /** Notifies `listener` of every `AgentEvent` that survives the ownership guard, in order. */
  onEvent(listener: (event: AgentEvent) => void): () => void;
  /**
   * Builds the `currentContext` provider `createAemGetJsonExecutor` needs.
   * Reads the AEM server context and the active chat/turn fresh on every
   * call - never captured once - so a server switch or a chat switch mid-turn
   * is reflected in the very next tool call. Throws if there is currently no
   * AEM server selected or no active chat/turn to bind to; the SDK adapter's
   * `wrapToolExecutor` catches an executor-level failure and renders it as an
   * ordinary tool error, so failing loudly here is safe.
   */
  currentAemToolContext(): CurrentAemToolContext;
  /**
   * Cancels the in-flight turn on the active chat, if any. Wired by the
   * composition root to the browser's `NavigationEpochTracker` subscription
   * (server switch, navigation, render-process-gone, view-destroyed all bump
   * it) so AEM-context-invalidating events cancel in-flight agent work the
   * same way pressing Stop does, per implementation-plan.md's "switching AEM
   * server" criterion. A no-op when no turn is in flight.
   */
  handleAemContextInvalidated(): Promise<void>;
  dispose(): Promise<void>;
}

function createAgentChatError(
  code: ToolErrorCode,
  message: string,
  requiredAction?: RequiredAction,
): AgentChatError {
  return requiredAction === undefined ? { code, message } : { code, message, requiredAction };
}

/** `AgentServiceError` and `AgentChatError` are structurally identical by design (see `agent-chat-ipc.ts`'s doc comment) - this just crosses the type boundary explicitly rather than relying on structural assignability. */
function toAgentChatError(error: AgentServiceError): AgentChatError {
  return createAgentChatError(error.code, error.message, error.requiredAction);
}

function notOpenConversationError(chatId: ChatId): AgentChatError {
  return createAgentChatError(
    'PRECONDITION_FAILED',
    `"${chatId}" is not the currently open conversation.`,
  );
}

const BLOCK_REASON_MESSAGES: Readonly<Record<CanSendBlockReason, string>> = {
  session_closed: 'This conversation is closed',
  not_authenticated: 'Sign in to Copilot before sending a message',
  session_error: 'Dismiss the current error before sending another message.',
  turn_in_progress:
    'Wait for the current response to finish (or press Stop) before sending another message.',
};

function blockReasonError(reason: CanSendBlockReason): AgentChatError {
  if (reason === 'not_authenticated') {
    return createAgentChatError(
      'COPILOT_UNAVAILABLE',
      BLOCK_REASON_MESSAGES[reason],
      'sign_in_to_copilot',
    );
  }
  return createAgentChatError('PRECONDITION_FAILED', BLOCK_REASON_MESSAGES[reason]);
}

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly messageIds: Set<MessageId>;
  readonly toolCallIds: Set<ToolCallId>;
}

export function createAgentChatController(deps: AgentChatControllerDeps): AgentChatController {
  const { agentService, idGenerator, logger } = deps;

  let activeChatId: ChatId | undefined;
  let activeTurn: ActiveTurn | undefined;
  let sessionStatus: SessionStatus = {
    state: 'idle',
    authenticated: agentService.getAuthState().isAuthenticated,
    browserReady: true,
  };

  const forwardListeners = new Set<(event: AgentEvent) => void>();

  /**
   * THE OWNERSHIP GUARD. Decides whether `event` - already known to have
   * come from `agentService.onEvent` - belongs to the chat/turn this
   * controller currently considers active. Everything this controller
   * forwards to the renderer passes through here first; anything that does
   * not match is dropped right here, not forwarded and not queued.
   */
  function isOwnedEvent(event: AgentEvent): boolean {
    if (activeChatId === undefined || event.chatId !== activeChatId) return false;
    switch (event.type) {
      case 'assistant.message.started':
      case 'assistant.text.delta':
      case 'assistant.message.completed':
        return activeTurn !== undefined && event.turnId === activeTurn.turnId;
      case 'tool.call.requested':
        return activeTurn !== undefined;
      case 'tool.call.approved':
      case 'tool.call.rejected':
      case 'tool.result':
        return activeTurn !== undefined && activeTurn.toolCallIds.has(event.toolCallId);
      case 'error':
      case 'session.state.changed':
        // Both variants carry `turnId` optionally (e.g. the terminal
        // "closed" `session.state.changed` has none): absent means the event
        // is chat-scoped, not turn-scoped, and chat membership was already
        // checked above.
        return (
          event.turnId === undefined ||
          (activeTurn !== undefined && event.turnId === activeTurn.turnId)
        );
      default: {
        return event;
      }
    }
  }

  /** Grows `activeTurn`'s membership sets from an event already accepted by `isOwnedEvent`, mirroring `sdkAgentService.ts`'s `CurrentTurn` bookkeeping. */
  function recordTurnMembership(event: AgentEvent): void {
    if (activeTurn === undefined) return;
    if (event.type === 'assistant.message.started') activeTurn.messageIds.add(event.messageId);
    if (event.type === 'tool.call.requested') activeTurn.toolCallIds.add(event.toolCallId);
  }

  function clearTurnIfTerminal(): void {
    if (
      sessionStatus.state === 'idle' ||
      sessionStatus.state === 'closed' ||
      sessionStatus.state === 'error'
    ) {
      activeTurn = undefined;
    }
  }

  const unsubscribeAuth = agentService.onAuthStateChanged((state) => {
    sessionStatus = { ...sessionStatus, authenticated: state.isAuthenticated };
  });

  const unsubscribeEvents = agentService.onEvent((event) => {
    if (!isOwnedEvent(event)) return; // Late/foreign event - dropped, never forwarded, never queued.
    const applied = applyAgentEvent(sessionStatus, event);
    if (!applied.ok) {
      // Unreachable if `isOwnedEvent` is correct: an event just accepted as
      // belonging to the active turn that the shared reducer still refuses
      // is a bug worth surfacing, not silently forwarding a bad transition.
      logger.error(
        'AGENT_CHAT_ILLEGAL_TRANSITION',
        activeChatId === undefined ? undefined : { ids: { chatId: activeChatId } },
      );
      return;
    }
    sessionStatus = applied.value;
    recordTurnMembership(event);
    clearTurnIfTerminal();
    for (const listener of [...forwardListeners]) listener(event);
  });

  function getStatus(): AgentChatStatus {
    return {
      apiVersion: 1,
      auth: agentService.getAuthState(),
      activeChatId: activeChatId ?? null,
      sessionState: sessionStatus.state,
      // This controller is only ever constructed once a real (or fake)
      // `AgentService` already exists and has been `initialize()`d - see
      // `createStartupGatedAgentChatController` below for the "still
      // starting" half of this lifecycle, which this controller is never
      // in.
      serviceState: 'ready',
    };
  }

  async function openConversation(
    request: AgentChatOpenConversationRequest,
  ): Promise<AgentChatOpenResult> {
    const isSameChat = activeChatId === request.chatId;
    // Ownership flips BEFORE calling into the service: any teardown event
    // the service emits synchronously for the previous chat during this call
    // is tagged with the previous chatId, which by then no longer matches
    // `activeChatId` - `isOwnedEvent` above excludes it without a race.
    activeChatId = request.chatId;
    if (!isSameChat) {
      activeTurn = undefined;
      sessionStatus = { ...sessionStatus, state: 'idle' };
    }
    const result = await agentService.openConversation(
      request.resume === undefined
        ? { chatId: request.chatId }
        : { chatId: request.chatId, resume: request.resume },
    );
    if (!result.ok) {
      // Mirrors both `AgentService` implementations: a failed open leaves no
      // conversation open at all (not the previous one, which was already
      // torn down as part of the attempt).
      activeChatId = undefined;
      activeTurn = undefined;
      return { ok: false, error: toAgentChatError(result.error) };
    }
    return { ok: true, chatId: result.value };
  }

  async function sendMessage(request: AgentChatSendMessageRequest): Promise<AgentChatSendResult> {
    if (activeChatId === undefined || request.chatId !== activeChatId) {
      return { ok: false, error: notOpenConversationError(request.chatId) };
    }
    // OWN pre-flight gate - defense-in-depth. `agentService.sendPrompt`
    // enforces this exact rule again on its own ("Do not send a second
    // prompt over an unfinished turn" is not left to only one layer to
    // remember); this check exists so a caller gets the same answer without
    // depending on that second layer alone.
    const gate = canSendMessage(sessionStatus);
    if (!gate.canSend) {
      return { ok: false, error: blockReasonError(gate.reason) };
    }
    const turnId = newTurnId(idGenerator);
    activeTurn = { turnId, messageIds: new Set(), toolCallIds: new Set() };
    const result = await agentService.sendPrompt({
      chatId: request.chatId,
      turnId,
      prompt: request.prompt,
    });
    if (!result.ok) {
      // The turn never actually started - nothing to keep tracking, unless
      // something else has already moved `activeTurn` on in the meantime.
      if (activeTurn.turnId === turnId) activeTurn = undefined;
      return { ok: false, error: toAgentChatError(result.error) };
    }
    return { ok: true, turnId };
  }

  async function abort(request: AgentChatByIdRequest): Promise<AgentChatVoidResult> {
    if (activeChatId === undefined || request.chatId !== activeChatId) {
      return { ok: false, error: notOpenConversationError(request.chatId) };
    }
    // No local state changes here beyond delegating: the resulting
    // `cancelling` -> `idle` events flow through the same ownership-checked
    // `onEvent` pipe as anything else. No `error` `AgentEvent` is ever
    // synthesised for a user-initiated Stop.
    const result = await agentService.abort(request.chatId);
    if (!result.ok) return { ok: false, error: toAgentChatError(result.error) };
    return { ok: true };
  }

  async function closeConversation(request: AgentChatByIdRequest): Promise<AgentChatVoidResult> {
    if (activeChatId === undefined || request.chatId !== activeChatId) {
      return { ok: false, error: notOpenConversationError(request.chatId) };
    }
    // Reset ownership BEFORE calling into the service, same reasoning as
    // `openConversation`: this chat's own trailing "closed" event no longer
    // matches `activeChatId` once it arrives, and is correctly dropped - the
    // resolved promise below is this call's actual acknowledgement.
    activeChatId = undefined;
    activeTurn = undefined;
    const result = await agentService.closeConversation(request.chatId);
    if (!result.ok) return { ok: false, error: toAgentChatError(result.error) };
    return { ok: true };
  }

  function onEvent(listener: (event: AgentEvent) => void): () => void {
    forwardListeners.add(listener);
    return () => {
      forwardListeners.delete(listener);
    };
  }

  function currentAemToolContext(): CurrentAemToolContext {
    // Read fresh on every call - see this function's doc comment on
    // `AgentChatController` for why capturing any of this once would be
    // wrong.
    const server = deps.currentAemServerContext();
    if (server === undefined) {
      throw new Error('AemToolContext requested with no AEM server currently selected.');
    }
    if (activeChatId === undefined || activeTurn === undefined) {
      throw new Error('AemToolContext requested with no active chat/turn to bind to.');
    }
    return {
      origin: server.origin,
      serverId: server.serverId,
      serverRevision: server.serverRevision,
      navigationEpoch: deps.navigationEpoch(),
      chatId: activeChatId,
      turnId: activeTurn.turnId,
    };
  }

  async function handleAemContextInvalidated(): Promise<void> {
    if (activeChatId === undefined || activeTurn === undefined) return;
    const chatId = activeChatId;
    const result = await agentService.abort(chatId);
    if (!result.ok) {
      logger.error('AGENT_CHAT_ABORT_ON_CONTEXT_CHANGE_FAILED', { ids: { chatId } });
    }
  }

  async function dispose(): Promise<void> {
    unsubscribeEvents();
    unsubscribeAuth();
    forwardListeners.clear();
    await agentService.dispose();
  }

  return {
    getStatus,
    openConversation,
    sendMessage,
    abort,
    closeConversation,
    onEvent,
    currentAemToolContext,
    handleAemContextInvalidated,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// Startup-gated controller: the honest "still starting" half of the chat
// surface's lifecycle
// ---------------------------------------------------------------------------

/**
 * The error every request this placeholder refuses carries. `PRECONDITION_FAILED`
 * (not `COPILOT_UNAVAILABLE`) is deliberate: this is not a claim about the
 * user's Copilot entitlement or sign-in state - main has not even asked yet -
 * it is "the session is not in a state that permits the operation, and the
 * identical request may succeed once the blocking condition clears" (see
 * that code's own doc comment in `errors.ts`), exactly the same category
 * `blockReasonError` already uses for `turn_in_progress`/`session_closed`
 * above. `requiredAction` is omitted (defaults to none in the renderer):
 * nothing the user does makes this resolve faster except waiting.
 */
function agentServiceStartingError(): AgentChatError {
  return createAgentChatError(
    'PRECONDITION_FAILED',
    'The Copilot agent service is still starting. Try again in a moment.',
  );
}

/**
 * Returned by `createStartupGatedAgentChatController` in addition to the
 * full `AgentChatController` surface: `replaceDelegate` is how the composition
 * root swaps in a fully-initialized controller - first once the background
 * Copilot startup finishes, and again whenever the Copilot runtime is recycled
 * (a proxy or active-provider change; see `copilotRuntimeManager.ts`) -
 * without the IPC handlers (`ipc/agentChat.ts`) or the tool-context binding
 * (`agentComposition.ts`'s `createLateBoundAemToolContext`) ever having to be
 * re-wired: they were already pointed at this same object.
 */
export interface StartupGatedAgentChatController extends AgentChatController {
  /**
   * Installs `controller` as the delegate for every call from this point on,
   * starts forwarding its events to any listener already registered via
   * `onEvent`, and - when it replaces an earlier delegate - unsubscribes and
   * disposes that previous one.
   *
   * Calling this more than once is a deliberate, supported operation, not a
   * bug: recycling the Copilot runtime necessarily replaces the
   * `AgentService` (and so the chat controller built from it) while the
   * request never moves off this one long-lived gated object. The previous
   * delegate is disposed *after* the new one is installed, so a listener
   * registered at any point sees no gap in coverage.
   */
  replaceDelegate(controller: AgentChatController): Promise<void>;
}

/**
 * Registering the `agent-chat:*` IPC handlers (`ipc/agentChat.ts`) requires
 * an `AgentChatController` to exist *before* the real one can - building the
 * real one needs an `AgentService`, and building that needs
 * `copilotClient.start()` (seconds, on the real path; see this module's own
 * top-of-file doc comment and `agentComposition.ts`'s
 * `startAgentServiceInBackground`). Registering the handlers late instead
 * would leave the `agent-chat:*` channels entirely unanswered for that same
 * window, which surfaces to a renderer `invoke` as a raw `Error: No handler
 * registered for '...'` - a strictly worse failure mode than an honest
 * "still starting" answer.
 *
 * Every read (`getStatus`) answers immediately and honestly with
 * `serviceState: "starting"`. Every write (`openConversation`/`sendMessage`)
 * is refused outright with `agentServiceStartingError()` rather than queued:
 * queuing would mean silently reordering or replaying a user's request
 * against whichever `AgentService`/policy/tool-handler set happens to exist
 * once `replaceDelegate` runs, for a window (a few seconds, once, at cold
 * start) where refusing and letting the caller retry is simple and
 * unsurprising instead. `abort`/`closeConversation` resolve `{ ok: true }` instead of
 * refusing: there is by construction no conversation open yet for either to
 * act on, so "already in the state you asked for" is the honest answer, not
 * a refusal.
 */
export function createStartupGatedAgentChatController(): StartupGatedAgentChatController {
  let real: AgentChatController | undefined;
  let unsubscribeRealEvents: (() => void) | undefined;
  const forwardListeners = new Set<(event: AgentEvent) => void>();

  function getStatus(): AgentChatStatus {
    if (real) return real.getStatus();
    return {
      apiVersion: 1,
      // Not a claim about the user's real sign-in state - see this
      // function's own doc comment and `agent-chat-ipc.ts`'s
      // `serviceState` doc comment: a caller must check `serviceState`
      // before trusting `auth` at all.
      auth: { apiVersion: 1, isAuthenticated: false },
      activeChatId: null,
      sessionState: 'idle',
      serviceState: 'starting',
    };
  }

  async function openConversation(
    request: AgentChatOpenConversationRequest,
  ): Promise<AgentChatOpenResult> {
    if (!real) return { ok: false, error: agentServiceStartingError() };
    return real.openConversation(request);
  }

  async function sendMessage(request: AgentChatSendMessageRequest): Promise<AgentChatSendResult> {
    if (!real) return { ok: false, error: agentServiceStartingError() };
    return real.sendMessage(request);
  }

  async function abort(request: AgentChatByIdRequest): Promise<AgentChatVoidResult> {
    if (!real) return { ok: true };
    return real.abort(request);
  }

  async function closeConversation(request: AgentChatByIdRequest): Promise<AgentChatVoidResult> {
    if (!real) return { ok: true };
    return real.closeConversation(request);
  }

  function onEvent(listener: (event: AgentEvent) => void): () => void {
    forwardListeners.add(listener);
    return () => {
      forwardListeners.delete(listener);
    };
  }

  function currentAemToolContext(): CurrentAemToolContext {
    if (!real) {
      throw new Error('AemToolContext requested before the agent service finished starting up.');
    }
    return real.currentAemToolContext();
  }

  async function handleAemContextInvalidated(): Promise<void> {
    if (!real) return;
    return real.handleAemContextInvalidated();
  }

  async function dispose(): Promise<void> {
    unsubscribeRealEvents?.();
    forwardListeners.clear();
    if (real) await real.dispose();
  }

  function replaceDelegate(controller: AgentChatController): Promise<void> {
    const previous = real;
    const previousUnsubscribe = unsubscribeRealEvents;
    // New delegate first, old listener second: between these two statements a
    // listener registered on this gated object is genuinely fanned out to the
    // new controller, and the old delegate's teardown (emitted by `dispose`
    // below) is excluded by its own now-detached subscription.
    real = controller;
    unsubscribeRealEvents = controller.onEvent((event) => {
      for (const listener of [...forwardListeners]) listener(event);
    });
    if (previous === undefined) return Promise.resolve();
    previousUnsubscribe?.();
    return previous.dispose();
  }

  return {
    getStatus,
    openConversation,
    sendMessage,
    abort,
    closeConversation,
    onEvent,
    currentAemToolContext,
    handleAemContextInvalidated,
    dispose,
    replaceDelegate,
  };
}

/**
 * Minimal shape this controller needs from an Electron `WebContents` to push
 * `AgentEvent`s to the renderer - duck-typed rather than importing
 * `electron`, so this stays testable with a plain object and no Electron
 * runtime. Mirrors `src/main/ipc/agent.ts`'s house style
 * (`sender.isDestroyed()` guard before `sender.send`).
 */
export interface AgentChatEventSink {
  isDestroyed(): boolean;
  send(channel: string, event: AgentEvent): void;
}

/**
 * Builds an `AgentChatController.onEvent` listener that forwards to `sink`,
 * skipping delivery entirely once `sink` is destroyed (a closed/destroyed
 * renderer window). Split out from `createAgentChatController` so it can be
 * unit-tested with a plain fake sink object, and so `src/main/ipc/agentChat.ts`
 * only has to wire it up, not reimplement the guard.
 */
export function createAgentChatEventForwarder(
  sink: AgentChatEventSink,
  channel: string,
): (event: AgentEvent) => void {
  return (event) => {
    if (sink.isDestroyed()) return;
    sink.send(channel, event);
  };
}
