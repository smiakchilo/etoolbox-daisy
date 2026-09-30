import {
  type AgentAuthState,
  type AgentEvent,
  type AgentService,
  type AgentServiceError,
  type CanSendBlockReason,
  type ChatId,
  type IdGenerator,
  type JsonValue,
  type MessageId,
  type OpenConversationRequest,
  type ReasoningId,
  type RequiredAction,
  type Result,
  type SdkSessionId,
  type SendPromptRequest,
  type SessionStatus,
  type SessionStreamState,
  type ToolCallId,
  type ToolErrorCode,
  type TurnId,
  type Unsubscribe,
  applyAgentEvent,
  canSendMessage,
  createToolError,
  err,
  newMessageId,
  newReasoningId,
  newRequestId,
  newToolCallId,
  ok,
  sdkSessionIdSchema,
  createAgentServiceError,
} from '../../shared';

/**
 * A deterministic, scriptable `AgentService` (implementation-plan.md step 07:
 * "Deterministic E2E uses the fake AgentService."). Every id, sequence
 * number, and event this module produces is a pure function of what a test
 * scripted and when it chose to call `advance()`/`flush()` - there are no
 * timers, no `Date.now()`, and no `Math.random()`/`crypto.randomUUID()`
 * anywhere in this file, so the exact same test run produces byte-identical
 * output every time.
 *
 * DRIVEN, NOT TIMED: `sendPrompt` does not itself emit the deltas/tool
 * calls/completion a scripted turn describes - it only computes them, in
 * full, up front. Delivery happens one event at a time, only when the test
 * calls `advance()` (or `flush()` to drain everything at once). This is what
 * lets a test assert on state *between* two events of the same turn (for
 * example: after the first delta but before the tool call starts) without
 * racing a `setTimeout`. The one exception is the turn's very first event
 * (`session.state.changed` to `"sending"`), which is applied synchronously
 * inside `sendPrompt` itself - see that method's own comment for why.
 *
 * SELF-CHECKING COHERENCE: this fake never decides for itself what the "next
 * legal state" is. Every event it is about to hand to a listener is first
 * run through `sessionState.ts`'s own `applyAgentEvent` against this fake's
 * internally tracked `SessionStreamState`; an illegal transition throws
 * immediately, as a bug in this file, rather than shipping a bad event to a
 * caller. That is what makes "every scripted scenario produces a legal event
 * sequence" a property of *this implementation*, not merely something a test
 * happens to also assert afterward (`fakeAgentService.test.ts` asserts it
 * from the outside too, as the plan requires, but the guarantee starts
 * here).
 */

// ---------------------------------------------------------------------------
// Scripting API
// ---------------------------------------------------------------------------

/** One chunk of assistant text, delivered as an `assistant.text.delta`. */
export interface ScriptedDeltaStep {
  readonly kind: 'delta';
  /** Must be non-empty - `assistant.text.delta.delta` is `min(1)` (agentEvents.ts). */
  readonly text: string;
}

/**
 * One chunk of extended-thinking text, delivered as an
 * `assistant.reasoning.delta`. Consecutive `reasoning` steps form a single
 * reasoning block; the block's `assistant.reasoning.completed` event (carrying
 * the concatenation) is emitted as soon as a non-reasoning step follows, or at
 * the turn's end - mirroring how the SDK closes a block before the model moves
 * on to text or a tool call.
 */
export interface ScriptedReasoningStep {
  readonly kind: 'reasoning';
  /** Must be non-empty - `assistant.reasoning.delta.delta` is `min(1)` (agentEvents.ts). */
  readonly text: string;
}

/**
 * The outcome a scripted tool call reports once "executed". Modelled after
 * `tool.result`'s own `{ ok: true, data } | { ok: false, error }` shape
 * (`toolResultEventSchema`, agentEvents.ts), except the failure arm here
 * takes only what `createToolError` (`src/shared/contracts/errors.ts`) does
 * not already derive by default - `code`, `message`, and an optional
 * `requiredAction` override - so a test does not have to hand-compute
 * `retryable` or mint a `RequestId` itself.
 */
export type ScriptedToolOutcome =
  | { readonly ok: true; readonly data: JsonValue }
  | {
      readonly ok: false;
      readonly code: ToolErrorCode;
      readonly message: string;
      readonly requiredAction?: RequiredAction;
    };

/**
 * How a scripted tool call is resolved: either the application's policy
 * approved it and it ran (`tool.call.approved` then `tool.result`), or the
 * policy rejected it outright (`tool.call.rejected`, with no `tool.result`
 * at all) - the same two-shape distinction `agentEvents.ts` itself draws.
 */
export type ScriptedToolDecision =
  | { readonly kind: 'approved'; readonly outcome: ScriptedToolOutcome }
  | { readonly kind: 'rejected'; readonly reason: string };

export interface ScriptedToolCall {
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly decision: ScriptedToolDecision;
}

/** One step of a scripted turn, emitted in the order the script lists them. */
export type ScriptedStep =
  | ScriptedDeltaStep
  | ScriptedReasoningStep
  | { readonly kind: 'toolCall'; readonly call: ScriptedToolCall };

/**
 * A full scripted response to one `sendPrompt` call.
 *
 * `finalContentOverride` exists solely to test the *disagreement* case (a
 * scenario that deliberately makes `assistant.message.completed.content`
 * differ from the folded deltas, to prove a consumer notices real drift
 * rather than one that only ever happens to match because this fake always
 * makes it match). Leaving it unset is the default and common case: the
 * completed content is the concatenation of every `delta` step's `text`, in
 * order, matching `renderFoldedText`'s own join rule
 * (`src/shared/contracts/agentEvents.ts`) - `assistant.message.completed`'s
 * `content` is documented there as replacing folded delta text, and here the
 * replacement is simply engineered to equal it by default.
 */
export interface ScriptedTurn {
  readonly steps?: readonly ScriptedStep[];
  readonly finalContentOverride?: string;
}

export interface FakeAgentServiceOptions {
  /**
   * Mints every `messageId`/`toolCallId`/`requestId` this fake needs to
   * generate on its own (never `chatId`/`turnId` - those are always supplied
   * by the caller; see `agentService.ts`'s `SendPromptRequest` doc). Defaults
   * to a plain incrementing counter, which is sufficient and fully
   * deterministic for a fake that never runs two instances concurrently in
   * one test.
   */
  readonly idGenerator?: IdGenerator;
  readonly initialAuthState?: AgentAuthState;
}

export interface FakeAgentService extends AgentService {
  /**
   * Queues `turn` to be the response to the *next* `sendPrompt` call.
   * Scripted turns are consumed in FIFO order; a `sendPrompt` call with
   * nothing queued gets a turn with no steps and empty completed content,
   * rather than an error - most tests care only about the lifecycle
   * (state machine, one-turn-at-a-time), not the content of every call.
   */
  scriptNextResponse(turn: ScriptedTurn): void;

  /**
   * Delivers exactly the next queued event for the in-flight turn, if any.
   * Returns `false` (and does nothing) once the turn's events are exhausted
   * or there is no turn in flight.
   */
  advance(): boolean;

  /** Calls `advance()` until it returns `false`. Returns how many events were delivered. */
  flush(): number;

  /**
   * Sets the sign-in status `getAuthState()` reports from now on and
   * notifies every `onAuthStateChanged` listener, unconditionally (this is
   * a test driver deliberately setting a new value, not an internal
   * dedup-worthy re-observation, so there is no equality check here).
   */
  setAuthState(state: AgentAuthState): void;
}

// ---------------------------------------------------------------------------
// Event construction helpers
// ---------------------------------------------------------------------------

/**
 * Everything the fake accumulates about the one turn currently in flight.
 * `queue` holds every event still to be delivered, in delivery order,
 * already sequence-numbered - `advance()` only ever shifts off the front.
 */
interface PendingTurn {
  readonly chatId: ChatId;
  readonly turnId: TurnId;
  readonly queue: AgentEvent[];
}

/**
 * The states in which some turn is in flight and therefore has a
 * `PendingTurn`. Used only to make `abort()`'s "nothing to cancel" check
 * read as a closed set rather than three loose string comparisons.
 */
const TURN_IN_FLIGHT_STATES: ReadonlySet<SessionStreamState> = new Set([
  'sending',
  'streaming',
  'runningTool',
]);

function defaultIdGenerator(): IdGenerator {
  let counter = 0;
  return () => `fake-id-${String(counter++)}`;
}

/**
 * Maps a `canSendMessage` refusal reason (`sessionState.ts`) to an
 * `AgentServiceError`. `session_closed` reuses `STALE_CONTEXT` ("issued
 * against configuration that has since changed" fits a request aimed at a
 * conversation that has since been closed). `not_authenticated` reuses
 * `AGENT_UNAVAILABLE` with its already-defined `sign_in_to_agent`
 * required action (`errors.ts`'s `REQUIRED_ACTION_BY_CODE`), since that is
 * exactly what being signed out of Copilot means at this boundary.
 * `session_error` and `turn_in_progress` both reuse `ACCESS_DENIED` - "The
 * application's own policy refused the request before it was sent" - because
 * in both cases nothing was ever sent anywhere; this service's own state
 * machine refused to forward the prompt at all. This mapping is a judgement
 * call: none of `ToolErrorCode`'s members were written with this boundary in
 * mind, and a reviewer may prefer different picks - see the session report.
 */
function blockReasonToError(reason: CanSendBlockReason): AgentServiceError {
  switch (reason) {
    case 'session_closed':
      return createAgentServiceError('PRECONDITION_FAILED', 'This conversation has been closed.');
    case 'not_authenticated':
      return createAgentServiceError(
        'AGENT_UNAVAILABLE',
        'Not signed in to Copilot.',
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * The sign-in status a fake reports unless a test says otherwise.
 *
 * Exported rather than inlined because it is also the answer the *auth* surface
 * must give while the deterministic fake is selected (`src/main/index.ts`'s
 * `getFakeAuthStatus`): the fake is the authority on "signed in" in that mode -
 * it already answers `agentChat.getStatus().authenticated` - so a second,
 * hand-written copy of this default would be free to drift from it.
 */
export const DEFAULT_FAKE_AUTH_STATE: AgentAuthState = {
  apiVersion: 1,
  isAuthenticated: true,
};

/**
 * Creates a fresh `FakeAgentService`. Every instance is independent: no
 * module-level state is shared between two fakes created in the same
 * process (important for parallel test files).
 */
export function createFakeAgentService(options: FakeAgentServiceOptions = {}): FakeAgentService {
  const idGenerator = options.idGenerator ?? defaultIdGenerator();
  let authState: AgentAuthState = options.initialAuthState ?? { ...DEFAULT_FAKE_AUTH_STATE };

  const eventListeners = new Set<(event: AgentEvent) => void>();
  const authListeners = new Set<(state: AgentAuthState) => void>();
  const scriptedTurns: ScriptedTurn[] = [];
  /** Sequence counters persist across close/reopen of the same `chatId` - see agentEvents.ts's module doc: sequence is a per-chat lifetime counter, not reset by this fake's own bookkeeping. */
  const sequenceByChatId = new Map<ChatId, number>();

  let openChatId: ChatId | undefined;
  /** Only meaningful while `openChatId !== undefined`; reset to `"idle"` each time a new chat opens. */
  let streamState: SessionStreamState = 'idle';
  let pendingTurn: PendingTurn | undefined;

  function nextSequence(chatId: ChatId): number {
    const sequence = sequenceByChatId.get(chatId) ?? 0;
    sequenceByChatId.set(chatId, sequence + 1);
    return sequence;
  }

  /**
   * Applies `event` to this fake's own tracked state via `applyAgentEvent`
   * (throwing if that reports an illegal transition - see the module doc's
   * "self-checking coherence" section) and only then hands it to every
   * subscribed listener.
   */
  function applyAndEmit(event: AgentEvent): void {
    const before: SessionStatus = {
      state: streamState,
      authenticated: authState.isAuthenticated,
      browserReady: true,
    };
    const applied = applyAgentEvent(before, event);
    if (!applied.ok) {
      throw new Error(
        `FakeAgentService produced an illegal event sequence (${applied.error.message}). ` +
          'This is a bug in fakeAgentService.ts, not in the caller.',
      );
    }
    streamState = applied.value.state;
    for (const listener of eventListeners) listener(event);
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

  function makeMessageStartedEvent(
    chatId: ChatId,
    turnId: TurnId,
    messageId: MessageId,
  ): AgentEvent {
    return {
      type: 'assistant.message.started',
      chatId,
      sequence: nextSequence(chatId),
      turnId,
      messageId,
    };
  }

  function makeDeltaEvent(
    chatId: ChatId,
    turnId: TurnId,
    messageId: MessageId,
    delta: string,
  ): AgentEvent {
    return {
      type: 'assistant.text.delta',
      chatId,
      sequence: nextSequence(chatId),
      turnId,
      messageId,
      delta,
    };
  }

  function makeReasoningDeltaEvent(
    chatId: ChatId,
    turnId: TurnId,
    reasoningId: ReasoningId,
    delta: string,
  ): AgentEvent {
    return {
      type: 'assistant.reasoning.delta',
      chatId,
      sequence: nextSequence(chatId),
      turnId,
      reasoningId,
      delta,
    };
  }

  function makeReasoningCompletedEvent(
    chatId: ChatId,
    turnId: TurnId,
    reasoningId: ReasoningId,
    content: string,
  ): AgentEvent {
    return {
      type: 'assistant.reasoning.completed',
      chatId,
      sequence: nextSequence(chatId),
      turnId,
      reasoningId,
      content,
    };
  }

  function makeMessageCompletedEvent(
    chatId: ChatId,
    turnId: TurnId,
    messageId: MessageId,
    content: string,
  ): AgentEvent {
    return {
      type: 'assistant.message.completed',
      chatId,
      sequence: nextSequence(chatId),
      turnId,
      messageId,
      content,
    };
  }

  function makeToolRequestedEvent(
    chatId: ChatId,
    toolCallId: ToolCallId,
    call: ScriptedToolCall,
  ): AgentEvent {
    return {
      type: 'tool.call.requested',
      chatId,
      sequence: nextSequence(chatId),
      toolCallId,
      toolName: call.toolName,
      arguments: call.arguments,
    };
  }

  function makeToolApprovedEvent(chatId: ChatId, toolCallId: ToolCallId): AgentEvent {
    return { type: 'tool.call.approved', chatId, sequence: nextSequence(chatId), toolCallId };
  }

  function makeToolRejectedEvent(
    chatId: ChatId,
    toolCallId: ToolCallId,
    reason: string,
  ): AgentEvent {
    return {
      type: 'tool.call.rejected',
      chatId,
      sequence: nextSequence(chatId),
      toolCallId,
      reason,
    };
  }

  function makeToolResultEvent(
    chatId: ChatId,
    toolCallId: ToolCallId,
    outcome: ScriptedToolOutcome,
  ): AgentEvent {
    const resolvedOutcome = outcome.ok
      ? { ok: true as const, data: outcome.data }
      : {
          ok: false as const,
          error: createToolError(
            outcome.code,
            outcome.message,
            newRequestId(idGenerator),
            outcome.requiredAction === undefined ? {} : { requiredAction: outcome.requiredAction },
          ),
        };
    return {
      type: 'tool.result',
      chatId,
      sequence: nextSequence(chatId),
      toolCallId,
      outcome: resolvedOutcome,
    };
  }

  /**
   * The full, already sequence-numbered event plan for one scripted turn.
   * `sendingEvent` is delivered synchronously by `sendPrompt` itself, before
   * this turn is even recorded as pending; `rest` is delivered only by
   * later `advance()`/`flush()` calls. Split into two fields - rather than
   * one array `sendPrompt` would `shift()` once and assume non-empty -
   * because "the first element always exists" would otherwise be an
   * invariant enforced only by convention between this function and its one
   * caller.
   */
  interface TurnPlan {
    readonly sendingEvent: AgentEvent;
    readonly rest: AgentEvent[];
  }

  /**
   * Builds the event plan for a scripted turn, in one pass, so sequence
   * numbers are assigned in true eventual delivery order regardless of when
   * each event actually gets delivered.
   */
  function buildTurnPlan(chatId: ChatId, turnId: TurnId, turn: ScriptedTurn): TurnPlan {
    const messageId = newMessageId(idGenerator);
    const steps = turn.steps ?? [];
    const sendingEvent = makeSessionStateEvent(chatId, 'sending', turnId);
    const queue: AgentEvent[] = [];
    queue.push(makeMessageStartedEvent(chatId, turnId, messageId));

    const deltaTexts: string[] = [];
    let activeReasoningId: ReasoningId | undefined;
    let reasoningText = '';

    /** Closes the current reasoning block, if any, with its completed event. */
    function closeReasoningBlock(): void {
      if (activeReasoningId === undefined) return;
      queue.push(makeReasoningCompletedEvent(chatId, turnId, activeReasoningId, reasoningText));
      activeReasoningId = undefined;
      reasoningText = '';
    }

    for (const step of steps) {
      if (step.kind === 'reasoning') {
        if (step.text.length === 0) {
          throw new Error(
            'ScriptedTurn contains an empty reasoning step; assistant.reasoning.delta.delta ' +
              'must be non-empty (agentEvents.ts).',
          );
        }
        activeReasoningId ??= newReasoningId(idGenerator);
        reasoningText += step.text;
        queue.push(makeReasoningDeltaEvent(chatId, turnId, activeReasoningId, step.text));
        continue;
      }
      // Any non-reasoning step ends the block that preceded it, exactly as the
      // SDK closes a reasoning block before the model produces text or calls a
      // tool.
      closeReasoningBlock();
      if (step.kind === 'delta') {
        if (step.text.length === 0) {
          throw new Error(
            'ScriptedTurn contains an empty delta step; assistant.text.delta.delta must be ' +
              'non-empty (agentEvents.ts).',
          );
        }
        deltaTexts.push(step.text);
        queue.push(makeDeltaEvent(chatId, turnId, messageId, step.text));
        continue;
      }
      const toolCallId = newToolCallId(idGenerator);
      queue.push(makeToolRequestedEvent(chatId, toolCallId, step.call));
      if (step.call.decision.kind === 'approved') {
        queue.push(makeToolApprovedEvent(chatId, toolCallId));
        queue.push(makeToolResultEvent(chatId, toolCallId, step.call.decision.outcome));
      } else {
        queue.push(makeToolRejectedEvent(chatId, toolCallId, step.call.decision.reason));
      }
    }
    closeReasoningBlock();

    const finalContent = turn.finalContentOverride ?? deltaTexts.join('');
    queue.push(makeMessageCompletedEvent(chatId, turnId, messageId, finalContent));
    queue.push(makeSessionStateEvent(chatId, 'idle', turnId));
    return { sendingEvent, rest: queue };
  }

  /**
   * Cancels the turn in flight on `chatId`: discards every event still
   * queued for it (so `advance()`/`flush()` can never deliver them - "must
   * NOT emit further events for the aborted turn afterwards") and instead
   * emits exactly two `session.state.changed` events: `"cancelling"`, then
   * `"idle"`.
   *
   * This is deliberately NOT an `error` event. A user pressing Stop is not a
   * failure - modelling it as one would make the UI show a failure banner
   * for a successful, deliberate action. It would also force a `ToolError`
   * onto the event, which needs a `RequestId` documented
   * (`src/shared/contracts/ids.ts`) as "One application-issued AEM request,
   * used end to end for correlation": a user-initiated Stop is not an AEM
   * request, and inventing one only to satisfy the schema would be a
   * correlation id pointing at nothing. `cancelling` exists in
   * `sessionState.ts` for exactly this: "cancellation is initiated by the
   * application (the user pressing Stop), not learned from the SDK's event
   * stream" - it is reached here as a `session.state.changed` event carrying
   * `state: "cancelling"`, which `nextStreamStateForEvent` passes straight
   * through to `applyTransition`, the same path a direct
   * `applyTransition(current, "cancelling")` call would take.
   *
   * `LEGAL_TRANSITIONS` (`sessionState.ts`) allows `sending`/`streaming`/
   * `runningTool` to all transition directly to `cancelling`, and
   * `cancelling` itself may only ever recover to `idle` (or `error`/`closed`,
   * neither of which applies to a plain user-initiated Stop). So regardless
   * of whether the turn had not yet produced its first delta, was
   * mid-stream, or was waiting on a tool result, exactly this same
   * two-event sequence is legal - there is no need to branch on which of the
   * three in-flight states the turn was cancelled from.
   */
  function performAbort(chatId: ChatId): void {
    const turn = pendingTurn;
    if (turn === undefined) {
      throw new Error(
        'FakeAgentService.performAbort called with no turn in flight - internal invariant violated.',
      );
    }
    pendingTurn = undefined;
    applyAndEmit(makeSessionStateEvent(chatId, 'cancelling', turn.turnId));
    applyAndEmit(makeSessionStateEvent(chatId, 'idle', turn.turnId));
  }

  /**
   * Aborts the in-flight turn on `chatId` (if any) and emits the terminal
   * `session.state.changed` to `"closed"`. Shared by `closeConversation` and
   * by `openConversation`'s implicit replacement of a different, already-open
   * chat - see `agentService.ts`'s `OpenConversationRequest` doc for why
   * opening a second chat tears the first down this same way instead of
   * refusing.
   */
  function teardown(chatId: ChatId): void {
    if (TURN_IN_FLIGHT_STATES.has(streamState)) {
      performAbort(chatId);
    }
    applyAndEmit(makeSessionStateEvent(chatId, 'closed'));
    if (openChatId === chatId) openChatId = undefined;
  }

  /**
   * Defined as a standalone closure - not a method read off the returned
   * object via `this` - so `flush` below can call it directly. The returned
   * `FakeAgentService` is a plain object literal, not a class instance, and
   * a caller is free to destructure `{ advance }` off it; relying on `this`
   * inside another method would silently break the moment that happens.
   */
  function advanceOnce(): boolean {
    const turn = pendingTurn;
    if (turn === undefined) return false;
    const next = turn.queue.shift();
    if (next === undefined) {
      pendingTurn = undefined;
      return false;
    }
    applyAndEmit(next);
    if (turn.queue.length === 0) pendingTurn = undefined;
    return true;
  }

  function flushAll(): number {
    let delivered = 0;
    while (advanceOnce()) delivered++;
    return delivered;
  }

  return {
    initialize(): Promise<Result<void, AgentServiceError>> {
      return Promise.resolve(ok(undefined));
    },

    getAuthState(): AgentAuthState {
      return authState;
    },

    getOpenSessionId(): SdkSessionId | undefined {
      if (openChatId === undefined) return undefined;
      // Deterministic, derived from the chat id: this fake has no real SDK
      // session, but the journal's header still needs a stable id. Truncated to
      // the identifier schema's bound so a very long chat id cannot make it
      // unparseable.
      return sdkSessionIdSchema.parse(`fake-session-${openChatId}`.slice(0, 200));
    },

    onAuthStateChanged(listener: (state: AgentAuthState) => void): Unsubscribe {
      authListeners.add(listener);
      return () => authListeners.delete(listener);
    },

    onEvent(listener: (event: AgentEvent) => void): Unsubscribe {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },

    openConversation(request: OpenConversationRequest): Promise<Result<ChatId, AgentServiceError>> {
      // Already open: a documented no-op, not a restart - see the rule in
      // agentService.ts's OpenConversationRequest doc comment.
      if (openChatId === request.chatId) {
        return Promise.resolve(ok(request.chatId));
      }
      // A different chat is open: tear it down first (aborting its in-flight
      // turn, if any) so this fake never tracks more than one open chat.
      // `request.resume` is accepted for type-compatibility with a real SDK
      // adapter but is otherwise inert here - this fake has no SDK session to
      // resume.
      if (openChatId !== undefined) {
        teardown(openChatId);
      }
      openChatId = request.chatId;
      streamState = 'idle';
      return Promise.resolve(ok(request.chatId));
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

      const status: SessionStatus = {
        state: streamState,
        authenticated: authState.isAuthenticated,
        browserReady: true,
      };
      const gate = canSendMessage(status);
      if (!gate.canSend) {
        return Promise.resolve(err(blockReasonToError(gate.reason)));
      }

      const turn = scriptedTurns.shift() ?? {};
      const plan = buildTurnPlan(request.chatId, request.turnId, turn);
      pendingTurn = { chatId: request.chatId, turnId: request.turnId, queue: plan.rest };

      // Delivered synchronously, unlike every later event in this turn: a
      // second sendPrompt() called before the caller ever calls advance()
      // must already see "turn_in_progress" - see agentService.ts's
      // sendPrompt doc and the module doc above.
      applyAndEmit(plan.sendingEvent);

      return Promise.resolve(ok(undefined));
    },

    abort(chatId: ChatId): Promise<Result<void, AgentServiceError>> {
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
      if (!TURN_IN_FLIGHT_STATES.has(streamState)) {
        // idle/error/closed: nothing in flight for this method to cancel.
        return Promise.resolve(ok(undefined));
      }
      performAbort(chatId);
      return Promise.resolve(ok(undefined));
    },

    closeConversation(chatId: ChatId): Promise<Result<void, AgentServiceError>> {
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

    dispose(): Promise<void> {
      eventListeners.clear();
      authListeners.clear();
      scriptedTurns.length = 0;
      pendingTurn = undefined;
      openChatId = undefined;
      streamState = 'closed';
      return Promise.resolve();
    },

    scriptNextResponse(turn: ScriptedTurn): void {
      scriptedTurns.push(turn);
    },

    advance: advanceOnce,

    flush: flushAll,

    setAuthState(state: AgentAuthState): void {
      authState = state;
      for (const listener of authListeners) listener(state);
    },
  };
}
