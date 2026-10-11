import type { ChatJournal } from './chatJournal';
import type { Logger } from './logger';
import {
  type AgentChatByIdRequest,
  type AgentChatError,
  type AgentChatOpenConversationRequest,
  type AgentChatOpenResult,
  type AgentChatRespondToInputRequest,
  type AgentChatSendMessageRequest,
  type AgentChatSendResult,
  type AgentChatStatus,
  type AgentChatVoidResult,
  type AgentEvent,
  type AgentService,
  type AgentServiceError,
  type CanSendBlockReason,
  type ChatId,
  type CurrentAemToolContext,
  type IdGenerator,
  type JsonValue,
  type MessageId,
  type RequiredAction,
  type Result,
  type ServerId,
  type SessionStatus,
  type ToolCallId,
  type ToolError,
  type ToolErrorCode,
  type TurnId,
  type UserInputAnswer,
  type UserInputRequest,
  agentEventSchema,
  applyAgentEvent,
  canSendMessage,
  err,
  newTurnId,
  ok,
} from '../shared';

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
  /**
   * The model-facing "where the browser pane is" block the application
   * prepends to every user prompt - or `undefined` when there is nothing safe
   * to say (no active server, or the pane is not on that server's origin).
   * Read fresh at send time, never cached, so a navigation between turns is
   * reflected in the very next prompt. The controller treats this as opaque
   * text: it never inspects a URL itself.
   */
  readonly currentPageContext: () => string | undefined;
  /**
   * Optional append-only chat journal (implementation-plan.md step 09). When
   * supplied, every accepted chat's open/prompt/events/close are mirrored to
   * `<home>/etoolbox-daisy/chats`. Optional so a unit test can construct a
   * controller with no journal - the journal is a recording concern, never a
   * gate on the conversation itself.
   */
  readonly chatJournal?: ChatJournal;
  /**
   * Cancels every in-flight/queued AEM bridge request. Called whenever the
   * current turn is cancelled - Stop, an AEM-context change, a chat switch, or
   * closing - so a stopped tool call releases the bridge's single concurrency
   * slot immediately instead of occupying it until its 90 s deadline. Optional
   * so a unit test can construct a controller without a bridge.
   */
  readonly cancelAemRequests?: () => void;
  /**
   * Rewrites a user prompt that begins with a bundled-skill reference (e.g.
   * `/search ...`) into the model-facing text that makes the agent load that
   * skill, returning the prompt unchanged for anything else. Optional
   * so a unit test can construct a controller with no skill catalogue.
   *
   * Only the text the model reads is rewritten - the display prompt and the
   * journal always keep the user's own text (see `sendMessage` below).
   */
  readonly resolveSkillPrompt?: (prompt: string) => string;
}

export interface AgentChatController {
  getStatus(): AgentChatStatus;
  openConversation(request: AgentChatOpenConversationRequest): Promise<AgentChatOpenResult>;
  sendMessage(request: AgentChatSendMessageRequest): Promise<AgentChatSendResult>;
  abort(request: AgentChatByIdRequest): Promise<AgentChatVoidResult>;
  closeConversation(request: AgentChatByIdRequest): Promise<AgentChatVoidResult>;
  /**
   * Puts an interactive question to the user on the active conversation and
   * resolves with their answer. This is the tool host's `requestUserInput`
   * capability; it is called from inside a tool executor, not over IPC.
   * Refused when no conversation is open.
   */
  requestUserInput(request: UserInputRequest): Promise<Result<UserInputAnswer, AgentChatError>>;
  /**
   * Delivers the renderer's answer to an outstanding question over IPC
   * (`agent-chat:respond-to-input`), releasing the turn waiting on it.
   */
  respondToInput(request: AgentChatRespondToInputRequest): Promise<AgentChatVoidResult>;
  /**
   * Feeds a tool call one tool made through `ToolHost.invokeTool` into the
   * event stream - journal, ownership guard, reducer, listeners - so it shows
   * in the transcript like a model-made call. Ignored with no turn in flight.
   */
  recordNestedToolCall(event: NestedToolCallEvent): void;
  /** Notifies `listener` of every `AgentEvent` that survives the ownership guard, in order. */
  onEvent(listener: (event: AgentEvent) => void): () => void;
  /**
   * Notifies `listener` whenever the value `getStatus()` would return may have
   * changed *without* an `AgentEvent`: the live auth state changed, or - on the
   * startup-gated controller - the delegate was replaced. This is what lets the
   * renderer learn of a runtime recycle (proxy/active-provider change,
   * sign-in/out, token set/clear) immediately instead of waiting for its
   * periodic status poll, so its composer gate never lags behind reality.
   */
  onStatusChanged(listener: () => void): () => void;
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
    `"${chatId}" is not the currently open conversation`,
  );
}

/**
 * The outcome of an `openConversation` request that a newer request superseded
 * before it resolved. This controller already set `activeChatId` to the newer
 * chat, so this request's own result no longer describes the active
 * conversation - the caller must treat it as "not applicable", never as a
 * failure of the conversation now in force.
 */
function supersededOpenError(): AgentChatError {
  return createAgentChatError(
    'PRECONDITION_FAILED',
    'A newer conversation was requested before this one finished opening',
  );
}

const BLOCK_REASON_MESSAGES: Readonly<Record<CanSendBlockReason, string>> = {
  session_closed: 'This conversation is closed',
  not_authenticated: 'Sign in to the agent to send a message',
  session_error: 'Dismiss the current error first',
  turn_in_progress: 'A response is already in progress',
};

function blockReasonError(reason: CanSendBlockReason): AgentChatError {
  if (reason === 'not_authenticated') {
    return createAgentChatError(
      'AGENT_UNAVAILABLE',
      BLOCK_REASON_MESSAGES[reason],
      'sign_in_to_agent',
    );
  }
  return createAgentChatError('PRECONDITION_FAILED', BLOCK_REASON_MESSAGES[reason]);
}

/**
 * Prepends the application-supplied page context to the user's own prompt.
 *
 * The context rides in `prompt` - the text the model actually reads - while
 * the separate `displayPrompt` argument keeps the user's own message (and the
 * SDK's timeline) showing only what they typed. The controller treats the
 * context as opaque: `agentComposition.ts` owns turning the browser's URL into
 * safe, model-facing text.
 */
export function composeModelPrompt(pageContext: string | undefined, prompt: string): string {
  return pageContext === undefined || pageContext.length === 0
    ? prompt
    : `${pageContext}\n\n${prompt}`;
}

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly messageIds: Set<MessageId>;
  readonly toolCallIds: Set<ToolCallId>;
}

/**
 * One phase of a tool call a tool made through `ToolHost.invokeTool` (see
 * `src/main/tools/registry.ts`). Agent-agnostic: no SDK sees these calls.
 */
export type NestedToolCallEvent =
  | {
      readonly phase: 'started';
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
      readonly args: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly phase: 'settled';
      readonly toolCallId: ToolCallId;
      readonly outcome: Result<JsonValue, ToolError>;
    };

export function createAgentChatController(deps: AgentChatControllerDeps): AgentChatController {
  const { agentService, idGenerator, logger } = deps;
  const chatJournal = deps.chatJournal;
  const cancelAemRequests = deps.cancelAemRequests;

  let activeChatId: ChatId | undefined;
  let activeTurn: ActiveTurn | undefined;
  /**
   * Single-flight for `openConversation`. At most one
   * `agentService.openConversation` call may be in flight at a time, and
   * `openSequence` is bumped for every request so a request that a newer one
   * superseded can be recognised after its await.
   *
   * This is what keeps the service's own "open conversation" in step with this
   * controller's `activeChatId`. Without it, two opens for different chats
   * could run concurrently and complete out of order - the slower, *earlier*
   * one finishing last and leaving the service on the wrong chat while this
   * controller had already moved on - so the very next send was refused by the
   * service with `"<chatId>" is not the open conversation` (the agent pane
   * showed that as its banner). One open at a time removes the interleaving by
   * construction; the sequence number is the second, independent guard against
   * a superseded request mutating state after the fact.
   */
  let openChain: Promise<void> = Promise.resolve();
  let openSequence = 0;
  let sessionStatus: SessionStatus = {
    state: 'idle',
    authenticated: agentService.getAuthState().isAuthenticated,
    browserReady: true,
  };

  const forwardListeners = new Set<(event: AgentEvent) => void>();
  const statusListeners = new Set<() => void>();

  /**
   * Fires every `onStatusChanged` listener. Called from the two places a
   * `getStatus()` read can change with no accompanying `AgentEvent`: a live
   * auth change here, and a delegate swap in the gated controller below.
   */
  function notifyStatusChanged(): void {
    for (const listener of [...statusListeners]) listener();
  }

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
      case 'assistant.reasoning.delta':
      case 'assistant.reasoning.completed':
        // Reasoning is turn-scoped exactly like assistant text; it is not
        // tracked in `recordTurnMembership` because nothing downstream keys on
        // a reasoning id, only on the current turn.
        return activeTurn !== undefined && event.turnId === activeTurn.turnId;
      case 'tool.call.requested':
        return activeTurn !== undefined;
      case 'tool.call.approved':
      case 'tool.call.rejected':
      case 'tool.result':
        return activeTurn !== undefined && activeTurn.toolCallIds.has(event.toolCallId);
      case 'user.input.requested':
        // Turn-scoped: a question is only meaningful for the turn that is
        // actually in flight, so a late one from an abandoned turn is dropped
        // exactly like a late assistant delta.
        return activeTurn !== undefined && event.turnId === activeTurn.turnId;
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
    notifyStatusChanged();
  });

  const unsubscribeEvents = agentService.onEvent((event) => {
    // Journaled before the ownership guard: a chat's own teardown events (a
    // switch to another chat tears the previous one down first) must still be
    // recorded, even though they are correctly never forwarded to the
    // renderer. The journal routes by `event.chatId` and drops events for a
    // chat it has no open file for.
    chatJournal?.recordEvent(event);
    ingestOwnedEvent(event, false);
  });

  /** The ownership-guarded half of the event pipe, shared by service events and nested tool calls. */
  function ingestOwnedEvent(event: AgentEvent, nested: boolean): void {
    if (!isOwnedEvent(event)) return; // Late/foreign event - dropped, never forwarded, never queued.
    const applied = applyAgentEvent(sessionStatus, event);
    if (!applied.ok) {
      // A nested call settling after Stop moved the chat to `cancelling` is
      // expected (the composite tool is still unwinding) and dropped quietly.
      if (nested) return;
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
  }

  /**
   * Shows a tool call one tool made through `ToolHost.invokeTool` exactly like
   * a call the model made: the same journal record, ownership guard, reducer
   * and listeners. The agent never sees these events - its SDK did not make
   * the call - so this controller is where they enter the stream.
   */
  function recordNestedToolCall(event: NestedToolCallEvent): void {
    if (activeChatId === undefined || activeTurn === undefined) return;
    const parsed = agentEventSchema.safeParse(
      event.phase === 'started'
        ? {
            type: 'tool.call.requested',
            chatId: activeChatId,
            sequence: 0,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            arguments: event.args,
          }
        : {
            type: 'tool.result',
            chatId: activeChatId,
            sequence: 0,
            toolCallId: event.toolCallId,
            outcome: event.outcome.ok
              ? { ok: true, data: event.outcome.value }
              : { ok: false, error: event.outcome.error },
          },
    );
    if (!parsed.success) {
      logger.error('AGENT_CHAT_NESTED_TOOL_EVENT_INVALID', { ids: { chatId: activeChatId } });
      return;
    }
    chatJournal?.recordEvent(parsed.data);
    ingestOwnedEvent(parsed.data, true);
  }

  function getStatus(): AgentChatStatus {
    return {
      apiVersion: 1,
      auth: agentService.getAuthState(),
      activeChatId: activeChatId ?? null,
      sdkSessionId: agentService.getOpenSessionId() ?? null,
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
    const sequence = ++openSequence;
    const isSameChat = activeChatId === request.chatId;
    const previousChatId = activeChatId;
    // Ownership flips BEFORE calling into the service: any teardown event
    // the service emits synchronously for the previous chat during this call
    // is tagged with the previous chatId, which by then no longer matches
    // `activeChatId` - `isOwnedEvent` above excludes it without a race.
    activeChatId = request.chatId;
    if (!isSameChat) {
      activeTurn = undefined;
      sessionStatus = { ...sessionStatus, state: 'idle' };
    }

    // Single-flight: wait for any earlier open to settle before asking the
    // service to open this one, so the service is never mid-open for two chats
    // at once (see `openChain`'s doc comment). `release` resolves this call's
    // own link in the chain once its service call is done.
    const prior = openChain;
    let release: () => void = () => undefined;
    openChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;

    let result: Result<ChatId, AgentServiceError>;
    try {
      result = await agentService.openConversation(
        request.resume === undefined
          ? { chatId: request.chatId }
          : { chatId: request.chatId, resume: request.resume },
      );
    } finally {
      release();
    }

    // A newer open was requested while this one was in flight: this request is
    // superseded. It no longer describes the active conversation (the newer
    // open owns, or is opening, that now), so leave every piece of state, the
    // journal and the turn bookkeeping untouched and report it as
    // no-longer-applicable rather than as a failure of the current chat.
    if (sequence !== openSequence) {
      return { ok: false, error: supersededOpenError() };
    }

    // The previous chat is gone either way (the service tears it down before
    // attempting the new one), so its journal is closed - after the await, so
    // its teardown events above are still recorded.
    if (previousChatId !== undefined && previousChatId !== request.chatId) {
      // The service has torn the previous chat down by now, so any AEM request
      // it still had in flight is cancelled into an abandoned record rather
      // than left to occupy the bridge until its deadline.
      cancelAemRequests?.();
      chatJournal?.closeChat(previousChatId);
    }
    if (!result.ok) {
      // Mirrors both `AgentService` implementations: a failed open leaves no
      // conversation open at all (not the previous one, which was already
      // torn down as part of the attempt).
      activeChatId = undefined;
      activeTurn = undefined;
      return { ok: false, error: toAgentChatError(result.error) };
    }
    const sdkSessionId = agentService.getOpenSessionId();
    if (sdkSessionId !== undefined) {
      const server = deps.currentAemServerContext();
      chatJournal?.openChat({
        chatId: request.chatId,
        sdkSessionId,
        ...(server !== undefined ? { serverId: server.serverId } : {}),
      });
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
    const pageContext = deps.currentPageContext();
    // The user's own text is kept for display and the journal; only the prompt
    // the model reads is rewritten for a leading `/skillname`.
    const modelPrompt = deps.resolveSkillPrompt?.(request.prompt) ?? request.prompt;
    // Staged, not written: the journal flushes it immediately before the
    // turn's first event (the service emits `session.state.changed: sending`
    // synchronously inside `sendPrompt`), so the prompt precedes the turn's
    // events on disk - and a prompt whose turn never starts is discarded below
    // and never written at all.
    chatJournal?.recordUserPrompt({ chatId: request.chatId, turnId, prompt: request.prompt });
    const result = await agentService.sendPrompt({
      chatId: request.chatId,
      turnId,
      prompt: composeModelPrompt(pageContext, modelPrompt),
      displayPrompt: request.prompt,
    });
    if (!result.ok) {
      chatJournal?.discardUserPrompt(request.chatId, turnId);
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
    //
    // The AEM bridge is cancelled first. `agentService.abort` clears its
    // `currentTurn` synchronously before it awaits, so the bridge's resolved
    // tool promises settle *after* that clear and their results are suppressed -
    // the same "no result for a cancelled turn" rule, now also freeing the
    // bridge's single concurrency slot instead of waiting out the deadline.
    const hadTurn = activeTurn !== undefined;
    cancelAemRequests?.();
    const result = await agentService.abort(request.chatId);
    if (!result.ok) return { ok: false, error: toAgentChatError(result.error) };
    // After the await, so the turn's own `cancelling`/`idle` events (and any
    // partial/abandoned bookkeeping they finalize) are already journaled and
    // this notice lands after them. A Stop with no turn in flight records
    // nothing - mirroring the renderer, which only paints a notice for an
    // observed `cancelling`.
    if (hadTurn) chatJournal?.recordInterruption({ chatId: request.chatId, reason: 'stopped' });
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
    // The service's teardown has already cleared its turn, so a cancelled
    // bridge request settles with its result suppressed - recorded as an
    // abandoned tool call rather than a late success.
    cancelAemRequests?.();
    chatJournal?.closeChat(request.chatId);
    return { ok: true };
  }

  async function requestUserInput(
    request: UserInputRequest,
  ): Promise<Result<UserInputAnswer, AgentChatError>> {
    if (activeChatId === undefined) {
      return err(createAgentChatError('PRECONDITION_FAILED', 'No conversation is open'));
    }
    const result = await agentService.requestUserInput(activeChatId, request);
    return result.ok ? ok(result.value) : err(toAgentChatError(result.error));
  }

  async function respondToInput(
    request: AgentChatRespondToInputRequest,
  ): Promise<AgentChatVoidResult> {
    if (activeChatId === undefined || request.chatId !== activeChatId) {
      return { ok: false, error: notOpenConversationError(request.chatId) };
    }
    const result = await agentService.respondToInput(
      request.chatId,
      request.requestId,
      request.answer,
    );
    if (!result.ok) return { ok: false, error: toAgentChatError(result.error) };
    return { ok: true };
  }

  function onEvent(listener: (event: AgentEvent) => void): () => void {
    forwardListeners.add(listener);
    return () => {
      forwardListeners.delete(listener);
    };
  }

  function onStatusChanged(listener: () => void): () => void {
    statusListeners.add(listener);
    return () => {
      statusListeners.delete(listener);
    };
  }

  function currentAemToolContext(): CurrentAemToolContext {
    // Read fresh on every call - see this function's doc comment on
    // `AgentChatController` for why capturing any of this once would be
    // wrong.
    const server = deps.currentAemServerContext();
    if (server === undefined) {
      throw new Error('AemToolContext requested with no AEM server currently selected');
    }
    if (activeChatId === undefined || activeTurn === undefined) {
      throw new Error('AemToolContext requested with no active chat/turn to bind to');
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
    // Logged *before* aborting so an automatic cancellation is distinguishable
    // from a user Stop in `logs/app.log`: a Stop leaves no such line.
    logger.info('AGENT_CHAT_ABORT_ON_CONTEXT_CHANGE', { ids: { chatId } });
    cancelAemRequests?.();
    const result = await agentService.abort(chatId);
    if (!result.ok) {
      logger.error('AGENT_CHAT_ABORT_ON_CONTEXT_CHANGE_FAILED', { ids: { chatId } });
      return;
    }
    // Recorded after the turn's own `cancelling`/`idle` events (see `abort`
    // above for why), so a resumed chat replays the notice in order. The reason
    // is the one fact only this path knows: an application abort, not a Stop.
    chatJournal?.recordInterruption({ chatId, reason: 'navigation' });
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
    requestUserInput,
    respondToInput,
    recordNestedToolCall,
    onEvent,
    onStatusChanged,
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
 * (not `AGENT_UNAVAILABLE`) is deliberate: this is not a claim about the
 * user's Copilot entitlement or sign-in state - main has not even asked yet -
 * it is "the session is not in a state that permits the operation, and the
 * identical request may succeed once the blocking condition clears" (see
 * that code's own doc comment in `errors.ts`), exactly the same category
 * `blockReasonError` already uses for `turn_in_progress`/`session_closed`
 * above. `requiredAction` is omitted (defaults to none in the renderer):
 * nothing the user does makes this resolve faster except waiting.
 */
function agentServiceStartingError(): AgentChatError {
  return createAgentChatError('PRECONDITION_FAILED', 'The agent service is still starting');
}

/**
 * The refusal while no agent exists at all (every agent folder removed or
 * disabled, or the configured one failed to load). Unlike the starting error,
 * waiting does not help, so it names the state instead of asking to retry.
 */
function agentUnavailableError(): AgentChatError {
  return createAgentChatError('AGENT_UNAVAILABLE', 'No agent is available');
}

/**
 * Returned by `createStartupGatedAgentChatController` in addition to the
 * full `AgentChatController` surface: `replaceDelegate` is how the composition
 * root swaps in a fully-initialized controller - first once the background
 * agent startup finishes, and again whenever the agent runtime is recycled
 * (a proxy or active-provider change; see `agents/copilot/runtimeManager.ts`) -
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
   * bug: recycling the agent runtime necessarily replaces the
   * `AgentService` (and so the chat controller built from it) while the
   * request never moves off this one long-lived gated object. The previous
   * delegate is disposed *after* the new one is installed, so a listener
   * registered at any point sees no gap in coverage.
   */
  replaceDelegate(controller: AgentChatController): Promise<void>;
  /**
   * Reports that no agent can serve the chat: `getStatus` answers
   * `serviceState: "unavailable"`, writes are refused with an explicit error,
   * and any installed delegate is disposed. A later `replaceDelegate` clears
   * the state again.
   */
  markUnavailable(): Promise<void>;
}

/**
 * Optional hooks for {@link createStartupGatedAgentChatController}.
 */
export interface StartupGatedAgentChatControllerDeps {
  /**
   * Awaited before a prompt is dispatched to the delegate. The composition root
   * uses it to apply any deferred runtime recycle - a proxy, token or
   * active-provider change made while a previous turn was live (see
   * `agentComposition.ts`'s deferred recycler) - so a prompt can never race an
   * unapplied recycle. Recycling replaces the delegate, so the gated controller
   * re-reads `real` after the hook resolves rather than calling into a disposed
   * one.
   */
  readonly beforeSendMessage?: () => Promise<void>;
}

/**
 * Registering the `agent-chat:*` IPC handlers (`ipc/agentChat.ts`) requires
 * an `AgentChatController` to exist *before* the real one can - building the
 * real one needs an `AgentService`, and building that needs
 * the agent runtime starting (seconds, on the real path; see this module's own
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
export function createStartupGatedAgentChatController(
  deps: StartupGatedAgentChatControllerDeps = {},
): StartupGatedAgentChatController {
  let real: AgentChatController | undefined;
  let unavailable = false;
  let unsubscribeRealEvents: (() => void) | undefined;
  let unsubscribeRealStatus: (() => void) | undefined;
  const forwardListeners = new Set<(event: AgentEvent) => void>();
  const statusListeners = new Set<() => void>();

  function notifyStatusChanged(): void {
    for (const listener of [...statusListeners]) listener();
  }

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
      sdkSessionId: null,
      sessionState: 'idle',
      serviceState: unavailable ? 'unavailable' : 'starting',
    };
  }

  function notReadyError(): AgentChatError {
    return unavailable ? agentUnavailableError() : agentServiceStartingError();
  }

  async function openConversation(
    request: AgentChatOpenConversationRequest,
  ): Promise<AgentChatOpenResult> {
    if (!real) return { ok: false, error: notReadyError() };
    return real.openConversation(request);
  }

  async function sendMessage(request: AgentChatSendMessageRequest): Promise<AgentChatSendResult> {
    if (!real) return { ok: false, error: notReadyError() };
    // Applying a deferred runtime recycle here (rather than only on turn end)
    // is what makes "the change takes effect on the next turn" exact: the hook
    // may replace `real`, so it is re-read afterwards.
    await deps.beforeSendMessage?.();
    if (!real) return { ok: false, error: notReadyError() };
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

  async function requestUserInput(
    request: UserInputRequest,
  ): Promise<Result<UserInputAnswer, AgentChatError>> {
    if (!real) return err(notReadyError());
    return real.requestUserInput(request);
  }

  async function respondToInput(
    request: AgentChatRespondToInputRequest,
  ): Promise<AgentChatVoidResult> {
    // No delegate: there is by construction no conversation, so no question can
    // be outstanding - "already in the state you asked for" is the honest
    // answer, exactly as `abort`/`closeConversation` treat it.
    if (!real) return { ok: true };
    return real.respondToInput(request);
  }

  function recordNestedToolCall(event: NestedToolCallEvent): void {
    real?.recordNestedToolCall(event);
  }

  function onEvent(listener: (event: AgentEvent) => void): () => void {
    forwardListeners.add(listener);
    return () => {
      forwardListeners.delete(listener);
    };
  }

  function onStatusChanged(listener: () => void): () => void {
    statusListeners.add(listener);
    return () => {
      statusListeners.delete(listener);
    };
  }

  function currentAemToolContext(): CurrentAemToolContext {
    if (!real) {
      throw new Error('AemToolContext requested before the agent service finished starting up');
    }
    return real.currentAemToolContext();
  }

  async function handleAemContextInvalidated(): Promise<void> {
    if (!real) return;
    return real.handleAemContextInvalidated();
  }

  async function dispose(): Promise<void> {
    unsubscribeRealEvents?.();
    unsubscribeRealStatus?.();
    forwardListeners.clear();
    statusListeners.clear();
    if (real) await real.dispose();
  }

  function replaceDelegate(controller: AgentChatController): Promise<void> {
    const previous = real;
    const previousUnsubscribe = unsubscribeRealEvents;
    const previousStatusUnsubscribe = unsubscribeRealStatus;
    // New delegate first, old listener second: between these two statements a
    // listener registered on this gated object is genuinely fanned out to the
    // new controller, and the old delegate's teardown (emitted by `dispose`
    // below) is excluded by its own now-detached subscription.
    real = controller;
    unavailable = false;
    unsubscribeRealEvents = controller.onEvent((event) => {
      for (const listener of [...forwardListeners]) listener(event);
    });
    unsubscribeRealStatus = controller.onStatusChanged(notifyStatusChanged);
    // A replacement changes which conversation main owns (the fresh controller
    // starts with none) and its auth resolution - both are exactly what a
    // renderer reading `getStatus()` must hear about, immediately.
    notifyStatusChanged();
    if (previous === undefined) return Promise.resolve();
    previousUnsubscribe?.();
    previousStatusUnsubscribe?.();
    return previous.dispose();
  }

  async function markUnavailable(): Promise<void> {
    const previous = real;
    unsubscribeRealEvents?.();
    unsubscribeRealStatus?.();
    unsubscribeRealEvents = undefined;
    unsubscribeRealStatus = undefined;
    real = undefined;
    unavailable = true;
    notifyStatusChanged();
    if (previous !== undefined) await previous.dispose();
  }

  return {
    getStatus,
    openConversation,
    sendMessage,
    abort,
    closeConversation,
    requestUserInput,
    respondToInput,
    recordNestedToolCall,
    onEvent,
    onStatusChanged,
    currentAemToolContext,
    handleAemContextInvalidated,
    dispose,
    replaceDelegate,
    markUnavailable,
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
