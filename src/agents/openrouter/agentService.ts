import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  type AgentAuthState,
  type AgentEvent,
  type AgentService,
  type AgentServiceError,
  type AuthStatus,
  type CanSendBlockReason,
  type ChatId,
  type IdGenerator,
  type JsonValue,
  type MessageId,
  type ModelPreference,
  type OpenConversationRequest,
  type Result,
  type SdkSessionId,
  type SendPromptRequest,
  type SessionStatus,
  type SessionStreamState,
  type ToolCallId,
  type ToolError,
  type TurnId,
  type Unsubscribe,
  agentEventSchema,
  applyAgentEvent,
  canSendMessage,
  createAgentServiceError,
  createToolError,
  err,
  jsonValueSchema,
  messageIdSchema,
  newRequestId,
  ok,
  parseAuthStatus,
  reasoningIdSchema,
  renderToolFailureForModel,
  sdkSessionIdSchema,
  toolCallIdSchema,
} from '../../shared';
import type { OpenRouterCall, OpenRouterClient, RunTool, ToolCallContext, ToolSpec } from './types';

/**
 * The OpenRouter-backed `AgentService`.
 *
 * Behaviourally interchangeable with the Copilot adapter and the deterministic
 * fake: the same one-active-conversation rule, the same refuse-not-queue turn
 * handling, and the same self-checking coherence - every event is validated by
 * `agentEventSchema.parse` and applied through `applyAgentEvent` before any
 * listener sees it.
 *
 * The SDK is reached only through the structural {@link OpenRouterClient} and
 * the injected `buildTools` factory, so this module (and its unit tests) never
 * import `@openrouter/agent`. Tool execution is handed back to this service's
 * `runTool`, which emits the `tool.call.*`/`tool.result` events the SDK's own
 * auto-execution would otherwise leave invisible.
 *
 * Conversation history is held for the lifetime of the open conversation (an
 * in-memory `ConversationState` handle the SDK persists between turns via the
 * injected state accessor). There is deliberately no cross-restart resume:
 * `resume` starts a fresh conversation, and the service mints its own session
 * id so `getOpenSessionId()` has a value to journal - documented at
 * {@link createOpenRouterAgentService}'s call site.
 */

/** The router model `(Auto)` maps to: let OpenRouter choose. */
export const AUTO_MODEL = 'openrouter/auto';

const TURN_IN_FLIGHT_STATES: ReadonlySet<SessionStreamState> = new Set([
  'sending',
  'streaming',
  'runningTool',
]);

const toolArgumentsSchema = z.record(z.string(), jsonValueSchema);

/** Validates an SDK-supplied arguments value; falls back to `{}` rather than throwing. */
function toToolArguments(value: unknown): Record<string, JsonValue> {
  const parsed = toolArgumentsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * Maps a `canSendMessage` refusal to an `AgentServiceError`. Kept in step with
 * `fakeAgentService.ts`/Copilot's adapter so all three agree.
 */
function blockReasonToError(reason: CanSendBlockReason): AgentServiceError {
  switch (reason) {
    case 'session_closed':
      return createAgentServiceError('PRECONDITION_FAILED', 'This conversation has been closed.');
    case 'not_authenticated':
      return createAgentServiceError(
        'AGENT_UNAVAILABLE',
        'No OpenRouter API key is set.',
        'sign_in_to_agent',
      );
    case 'session_error':
      return createAgentServiceError(
        'PRECONDITION_FAILED',
        'The previous turn ended in an error; it must be dismissed before sending another prompt.',
      );
    case 'turn_in_progress':
      return createAgentServiceError(
        'PRECONDITION_FAILED',
        'A turn is already in progress on this conversation.',
      );
    default: {
      return reason;
    }
  }
}

/**
 * Maps a rejected model run to application-authored text safe to show in the
 * chat banner. The raw SDK/remote error is logged by the caller and never
 * forwarded: it can carry remote content and, for a rejected request, echo the
 * request body. The status code is the one piece worth acting on, so it is
 * translated to the user's next step.
 */
function describeOpenRouterFailure(error: unknown): string {
  const status =
    typeof error === 'object' && error !== null
      ? ((error as { statusCode?: unknown }).statusCode ?? (error as { status?: unknown }).status)
      : undefined;
  switch (status) {
    case 401:
    case 403:
      return 'OpenRouter rejected the API key. Check the token in Settings.';
    case 402:
      return 'OpenRouter refused the request for lack of credits or quota.';
    case 404:
      return 'The selected OpenRouter model is not available to this key. Choose another model in Settings.';
    case 408:
      return 'OpenRouter timed out the request. Try again.';
    case 429:
      return 'OpenRouter is rate-limiting this key. Wait a moment and try again.';
    default:
      return typeof status === 'number' && status >= 500
        ? 'OpenRouter reported a server error. Try again in a moment.'
        : 'The OpenRouter request failed.';
  }
}

export interface OpenRouterAgentServiceOptions {
  readonly client: OpenRouterClient;
  /** The sign-in state this service reports; rebuilt by the runtime on a key change. */
  readonly authStatus: AuthStatus;
  /** The composed assistant instructions (the host toolkit's). */
  readonly instructions: string;
  /** Builds the SDK tools, closing over this service's `runTool`. Injected by the runtime. */
  readonly buildTools: (runTool: RunTool) => readonly unknown[];
  /** Read fresh on every prompt, so a Settings model change reaches an open chat. */
  readonly modelPreferences?: () => ModelPreference;
  readonly idGenerator?: IdGenerator;
}

interface CurrentTurn {
  readonly turnId: TurnId;
  readonly messageIds: Set<string>;
  readonly toolCallIds: Set<ToolCallId>;
}

export function createOpenRouterAgentService(options: OpenRouterAgentServiceOptions): AgentService {
  const { client } = options;
  const idGenerator = options.idGenerator ?? (() => randomUUID());
  const readModelPreference: () => ModelPreference =
    options.modelPreferences ?? (() => ({ model: null, reasoningEffort: null }));

  let authState: AgentAuthState = parseAuthStatus(options.authStatus);
  const eventListeners = new Set<(event: AgentEvent) => void>();
  const authListeners = new Set<(state: AgentAuthState) => void>();
  const sequenceByChatId = new Map<ChatId, number>();

  let openChatId: ChatId | undefined;
  let openState: unknown;
  let openSessionId: SdkSessionId | undefined;
  let streamState: SessionStreamState = 'idle';
  let currentTurn: CurrentTurn | undefined;
  /** Bumped to invalidate a completion path superseded by abort/teardown. */
  let generation = 0;
  let currentAbort: AbortController | undefined;

  const runTool: RunTool = (spec, rawArgs, context) => executeTool(spec, rawArgs, context);

  function nextSequence(chatId: ChatId): number {
    const sequence = sequenceByChatId.get(chatId) ?? 0;
    sequenceByChatId.set(chatId, sequence + 1);
    return sequence;
  }

  function currentStatus(): SessionStatus {
    return {
      state: streamState,
      authenticated: authState.isAuthenticated,
      browserReady: true,
    };
  }

  function applyAndEmit(event: AgentEvent): void {
    const validated = agentEventSchema.parse(event);
    const applied = applyAgentEvent(currentStatus(), validated);
    if (!applied.ok) {
      throw new Error(
        `openrouter agent service produced an illegal event sequence (${applied.error.message}). ` +
          'This is a bug in this adapter, not in the caller.',
      );
    }
    streamState = applied.value.state;
    for (const listener of eventListeners) listener(validated);
    // `error`'s only defined recovery is a clean `idle` (see
    // `sessionState.ts`'s transition table). Perform that recovery here, on
    // the user's behalf, so a failed turn can never leave the composer
    // permanently disabled: the `error` event is still delivered (and
    // journaled, and shown in the pane's banner) for display, and the
    // follow-up `idle` is chat-scoped (no `turnId`) so the controller's
    // ownership guard still forwards it once it has dropped the errored turn.
    if (validated.type === 'error') recoverToIdle(validated.chatId);
  }

  /**
   * Returns the session to `idle` after a terminal `error`, if the state
   * machine permits it (it always does from `error`; a no-op otherwise). The
   * recovery event carries no `turnId` deliberately - see {@link applyAndEmit}.
   */
  function recoverToIdle(chatId: ChatId): void {
    const idle: AgentEvent = {
      type: 'session.state.changed',
      chatId,
      sequence: nextSequence(chatId),
      state: 'idle',
    };
    const applied = applyAgentEvent(currentStatus(), idle);
    if (!applied.ok) return;
    streamState = applied.value.state;
    for (const listener of eventListeners) listener(idle);
  }

  /** Emits one turn-scoped `error` event (which also recovers the session - see {@link applyAndEmit}). */
  function emitTurnError(chatId: ChatId, turnId: TurnId, message: string): void {
    applyAndEmit({
      type: 'error',
      chatId,
      sequence: nextSequence(chatId),
      turnId,
      error: createToolError('AGENT_UNAVAILABLE', message, newRequestId(idGenerator)),
    });
  }

  function makeSessionStateEvent(
    chatId: ChatId,
    state: SessionStreamState,
    turnId?: TurnId,
  ): AgentEvent {
    const sequence = nextSequence(chatId);
    return turnId === undefined
      ? { type: 'session.state.changed', chatId, sequence, state }
      : { type: 'session.state.changed', chatId, sequence, turnId, state };
  }

  /**
   * Runs one tool call: emits `tool.call.requested`/`approved`, executes the
   * host executor, emits `tool.result` from the executor's own settle, and
   * returns the model-facing value (the executor's data on success, or the
   * shared failure rendering so the model reads the same error the UI shows).
   *
   * Guarded by the turn the call started in: a settle after abort/teardown
   * emits nothing, mirroring the Copilot adapter's late-result rule.
   */
  async function executeTool(
    spec: ToolSpec,
    rawArgs: unknown,
    context: ToolCallContext,
  ): Promise<unknown> {
    const turn = currentTurn;
    const chatId = openChatId;
    const parsedCallId =
      context.callId === undefined ? undefined : toolCallIdSchema.safeParse(context.callId);
    const toolCallId: ToolCallId =
      parsedCallId?.success === true ? parsedCallId.data : toolCallIdSchema.parse(idGenerator());
    const args = toToolArguments(rawArgs);

    if (turn !== undefined && chatId !== undefined) {
      applyAndEmit({
        type: 'tool.call.requested',
        chatId,
        sequence: nextSequence(chatId),
        toolCallId,
        toolName: spec.name,
        arguments: args,
      });
      applyAndEmit({
        type: 'tool.call.approved',
        chatId,
        sequence: nextSequence(chatId),
        toolCallId,
      });
    }

    let outcome: Result<JsonValue, ToolError>;
    try {
      outcome = await spec.executor(args, {
        toolCallId,
        signal: context.signal,
      });
    } catch (caught) {
      outcome = {
        ok: false as const,
        error: createToolError(
          'UNEXPECTED_RESPONSE',
          caught instanceof Error ? caught.message.slice(0, 500) : 'Tool execution failed.',
          newRequestId(idGenerator),
        ),
      };
    }

    if (
      turn !== undefined &&
      chatId !== undefined &&
      currentTurn === turn &&
      openChatId === chatId
    ) {
      applyAndEmit({
        type: 'tool.result',
        chatId,
        sequence: nextSequence(chatId),
        toolCallId,
        outcome: outcome.ok
          ? { ok: true, data: outcome.value }
          : { ok: false, error: outcome.error },
      });
    }

    if (!outcome.ok) {
      return {
        textResultForLlm: renderToolFailureForModel(outcome.error),
        resultType: 'failure',
      };
    }
    return outcome.value;
  }

  const tools = options.buildTools(runTool);

  /**
   * Streams assistant text deltas, opening one message lazily on the first
   * delta. Returns the message and its full text so the caller can emit the
   * authoritative `completed` event, or `undefined` when the model emitted no
   * text at all.
   */
  async function consumeText(
    call: OpenRouterCall,
    chatId: ChatId,
    turnId: TurnId,
  ): Promise<{ readonly messageId: MessageId; readonly content: string } | undefined> {
    let messageId: MessageId | undefined;
    let content = '';
    for await (const delta of call.getTextStream()) {
      if (delta.length === 0) continue;
      if (messageId === undefined) {
        messageId = messageIdSchema.parse(idGenerator());
        currentTurn?.messageIds.add(messageId);
        applyAndEmit({
          type: 'assistant.message.started',
          chatId,
          sequence: nextSequence(chatId),
          turnId,
          messageId,
        });
      }
      applyAndEmit({
        type: 'assistant.text.delta',
        chatId,
        sequence: nextSequence(chatId),
        turnId,
        messageId,
        delta,
      });
      content += delta;
    }
    return messageId === undefined ? undefined : { messageId, content };
  }

  /**
   * Streams reasoning deltas into one transient block; absent when the model
   * emits none. Returns the block's id and text, or `undefined`.
   */
  async function consumeReasoning(
    call: OpenRouterCall,
    chatId: ChatId,
    turnId: TurnId,
  ): Promise<{ readonly reasoningId: string; readonly content: string } | undefined> {
    let reasoningId: string | undefined;
    let content = '';
    for await (const delta of call.getReasoningStream()) {
      if (delta.length === 0) continue;
      if (reasoningId === undefined) reasoningId = reasoningIdSchema.parse(idGenerator());
      applyAndEmit({
        type: 'assistant.reasoning.delta',
        chatId,
        sequence: nextSequence(chatId),
        turnId,
        reasoningId: reasoningIdSchema.parse(reasoningId),
        delta,
      });
      content += delta;
    }
    return reasoningId === undefined ? undefined : { reasoningId, content };
  }

  /**
   * Opens an (empty) assistant message when a turn produced neither text nor a
   * tool, so the session can return to `idle` legally: `sending`/`runningTool`
   * cannot transition straight to `idle`. Returns the placeholder's id, or
   * `undefined` when the session is already in a state that can go idle.
   */
  function ensureStreaming(chatId: ChatId, turnId: TurnId): MessageId | undefined {
    if (streamState !== 'sending' && streamState !== 'runningTool') return undefined;
    const messageId = messageIdSchema.parse(idGenerator());
    currentTurn?.messageIds.add(messageId);
    applyAndEmit({
      type: 'assistant.message.started',
      chatId,
      sequence: nextSequence(chatId),
      turnId,
      messageId,
    });
    return messageId;
  }

  function performAbort(chatId: ChatId, turnId: TurnId): void {
    currentTurn = undefined;
    const controller = currentAbort;
    currentAbort = undefined;
    try {
      controller?.abort();
    } catch {
      // Abort is advisory; the state machine below is what matters.
    }
    applyAndEmit(makeSessionStateEvent(chatId, 'cancelling', turnId));
    applyAndEmit(makeSessionStateEvent(chatId, 'idle', turnId));
  }

  function teardown(chatId: ChatId): void {
    if (TURN_IN_FLIGHT_STATES.has(streamState) && currentTurn !== undefined) {
      const turnId = currentTurn.turnId;
      generation += 1;
      performAbort(chatId, turnId);
    }
    applyAndEmit(makeSessionStateEvent(chatId, 'closed'));
    openState = undefined;
    openSessionId = undefined;
    currentAbort = undefined;
    if (openChatId === chatId) openChatId = undefined;
  }

  /**
   * Drives one already-started model run to completion, streaming its text and
   * reasoning and emitting the terminal state. Detached from `sendPrompt` (see
   * its call site) so the turn does not block the IPC reply, exactly like the
   * Copilot adapter's `session.send`. A run superseded by abort/teardown/open
   * of another chat emits nothing: that path has already emitted the terminal
   * state, and `generation` is bumped there.
   */
  async function runTurn(
    chatId: ChatId,
    turnId: TurnId,
    call: OpenRouterCall,
    myGeneration: number,
  ): Promise<void> {
    const settled = await Promise.allSettled([
      // `getResponse` drives the run to completion (and rejects on failure or
      // abort); the two consumers only render its stream.
      Promise.resolve().then(() => call.getResponse()),
      consumeText(call, chatId, turnId),
      consumeReasoning(call, chatId, turnId),
    ]);

    // Superseded by abort/teardown/open of another chat: that path already
    // emitted the terminal state, so emit nothing here.
    if (myGeneration !== generation) return;

    currentTurn = undefined;
    currentAbort = undefined;

    if (settled[0]?.status === 'rejected') {
      // The raw rejection is the only place the real cause is visible; the
      // user-facing line stays application-authored (see
      // `describeOpenRouterFailure`).
      console.error('openrouter: model run failed', settled[0].reason);
      emitTurnError(chatId, turnId, describeOpenRouterFailure(settled[0].reason));
      return;
    }

    const text = settled[1]?.status === 'fulfilled' ? settled[1].value : undefined;
    const reasoning = settled[2]?.status === 'fulfilled' ? settled[2].value : undefined;
    if (text !== undefined) {
      applyAndEmit({
        type: 'assistant.message.completed',
        chatId,
        sequence: nextSequence(chatId),
        turnId,
        messageId: text.messageId,
        content: text.content,
      });
    } else {
      // No text: close the empty placeholder `ensureStreaming` opened, if any.
      const placeholderId = ensureStreaming(chatId, turnId);
      if (placeholderId !== undefined) {
        applyAndEmit({
          type: 'assistant.message.completed',
          chatId,
          sequence: nextSequence(chatId),
          turnId,
          messageId: placeholderId,
          content: '',
        });
      }
    }
    if (reasoning !== undefined) {
      applyAndEmit({
        type: 'assistant.reasoning.completed',
        chatId,
        sequence: nextSequence(chatId),
        turnId,
        reasoningId: reasoningIdSchema.parse(reasoning.reasoningId),
        content: reasoning.content,
      });
    }
    applyAndEmit(makeSessionStateEvent(chatId, 'idle', turnId));
  }

  return {
    initialize: (): Promise<Result<void, AgentServiceError>> => {
      authState = parseAuthStatus(options.authStatus);
      return Promise.resolve(ok(undefined));
    },

    getAuthState(): AgentAuthState {
      return authState;
    },

    getOpenSessionId(): SdkSessionId | undefined {
      return openSessionId;
    },

    onAuthStateChanged(listener: (state: AgentAuthState) => void): Unsubscribe {
      authListeners.add(listener);
      return () => authListeners.delete(listener);
    },

    onEvent(listener: (event: AgentEvent) => void): Unsubscribe {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },

    openConversation: (
      request: OpenConversationRequest,
    ): Promise<Result<ChatId, AgentServiceError>> => {
      if (openChatId === request.chatId) return Promise.resolve(ok(request.chatId));
      if (openChatId !== undefined) teardown(openChatId);
      try {
        // A resumed chat starts fresh by design (no cross-restart state); the
        // SDK's own in-memory state carries history across turns within this
        // open conversation.
        openState = client.createConversationState();
        openSessionId = sdkSessionIdSchema.parse(idGenerator());
        openChatId = request.chatId;
        streamState = 'idle';
        currentTurn = undefined;
        currentAbort = undefined;
        generation += 1;
        return Promise.resolve(ok(request.chatId));
      } catch (error) {
        console.error('openrouter: failed to open conversation', error);
        return Promise.resolve(
          err(
            createAgentServiceError('AGENT_UNAVAILABLE', 'Could not start an OpenRouter session.'),
          ),
        );
      }
    },

    sendPrompt(request: SendPromptRequest): Promise<Result<void, AgentServiceError>> {
      if (openChatId === undefined || openChatId !== request.chatId) {
        return Promise.resolve(
          err(
            createAgentServiceError(
              'INVALID_ARGUMENT',
              `"${request.chatId}" is not the open conversation.`,
            ),
          ),
        );
      }

      const gate = canSendMessage({
        state: streamState,
        authenticated: authState.isAuthenticated,
        browserReady: true,
      });
      if (!gate.canSend) return Promise.resolve(err(blockReasonToError(gate.reason)));

      if (!client.hasApiKey) {
        return Promise.resolve(
          err(
            createAgentServiceError(
              'AGENT_UNAVAILABLE',
              'No OpenRouter API key is set. Add one in Settings.',
              'sign_in_to_agent',
            ),
          ),
        );
      }
      if (openState === undefined) {
        return Promise.resolve(
          err(createAgentServiceError('PRECONDITION_FAILED', 'No active OpenRouter session.')),
        );
      }

      const preference = readModelPreference();
      const model = preference.model ?? AUTO_MODEL;
      const controller = new AbortController();
      const myGeneration = ++generation;
      const turnId = request.turnId;
      currentAbort = controller;
      currentTurn = { turnId, messageIds: new Set(), toolCallIds: new Set() };

      // Applied synchronously so a second send before any SDK event already
      // sees "turn_in_progress", mirroring the other adapters.
      applyAndEmit(makeSessionStateEvent(request.chatId, 'sending', turnId));

      let call: OpenRouterCall;
      try {
        call = client.callModel({
          model,
          reasoningEffort: preference.reasoningEffort,
          instructions: options.instructions,
          input: request.prompt,
          tools,
          state: openState,
          signal: controller.signal,
        });
      } catch (error) {
        currentTurn = undefined;
        currentAbort = undefined;
        console.error('openrouter: callModel threw synchronously', error);
        emitTurnError(request.chatId, turnId, 'Could not start the OpenRouter request.');
        return Promise.resolve(
          err(
            createAgentServiceError('AGENT_UNAVAILABLE', 'Could not start the OpenRouter request.'),
          ),
        );
      }

      // Return as soon as the turn has been accepted, exactly like the Copilot
      // adapter's `session.send`. The run's events stream in afterwards;
      // awaiting it here would hold the renderer's `sendMessage` reply until
      // the model finished, so the user's own prompt would not appear in the
      // transcript until the answer did.
      void runTurn(request.chatId, turnId, call, myGeneration).catch((error: unknown) => {
        console.error('openrouter: detached turn failed unexpectedly', error);
      });
      return Promise.resolve(ok(undefined));
    },

    abort: (chatId: ChatId): Promise<Result<void, AgentServiceError>> => {
      if (openChatId === undefined || openChatId !== chatId) {
        return Promise.resolve(
          err(
            createAgentServiceError(
              'INVALID_ARGUMENT',
              `"${chatId}" is not the open conversation.`,
            ),
          ),
        );
      }
      if (!TURN_IN_FLIGHT_STATES.has(streamState) || currentTurn === undefined) {
        return Promise.resolve(ok(undefined));
      }
      const turnId = currentTurn.turnId;
      generation += 1;
      performAbort(chatId, turnId);
      return Promise.resolve(ok(undefined));
    },

    closeConversation: (chatId: ChatId): Promise<Result<void, AgentServiceError>> => {
      if (openChatId === undefined || openChatId !== chatId) {
        return Promise.resolve(
          err(
            createAgentServiceError(
              'INVALID_ARGUMENT',
              `"${chatId}" is not the open conversation.`,
            ),
          ),
        );
      }
      teardown(chatId);
      return Promise.resolve(ok(undefined));
    },

    dispose: (): Promise<void> => {
      eventListeners.clear();
      authListeners.clear();
      currentTurn = undefined;
      currentAbort?.abort();
      currentAbort = undefined;
      openChatId = undefined;
      openState = undefined;
      openSessionId = undefined;
      streamState = 'closed';
      generation += 1;
      return Promise.resolve();
    },
  };
}
