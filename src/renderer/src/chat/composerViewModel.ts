import {
  type AgentServiceLifecycleState,
  type CanSendBlockReason,
  canSendMessage,
  type SessionStatus,
  type SessionStreamState,
} from '../../../shared';

/**
 * Everything the composer's button/notice state depends on: the agent
 * service's own startup lifecycle (`AgentChatStatus.serviceState`) plus the
 * chat's `SessionStatus` (streaming state + auth), kept as two separate
 * fields for the same reason `sessionState.ts` keeps `SessionStatus`'s own
 * fields separate - see `computeComposerButtonState` below for why
 * `serviceState` is checked first and short-circuits everything else.
 */
export interface ComposerStatus {
  readonly serviceState: AgentServiceLifecycleState;
  readonly session: SessionStatus;
  /**
   * Whether an agent is actually active right now (see
   * `resolveEffectiveActiveAgentId` in `src/shared/contracts/agents.ts`): the
   * configured provider when it is eligible, else none.
   * When false, the chat pane shows its own "activate an agent" banner instead
   * of the composer's inline notice, so this state disables Send silently.
   */
  readonly agentActive: boolean;
}

export type ComposerButtonState =
  | { readonly kind: 'connecting' }
  /** No agent exists to serve the chat; the pane's banner says so. */
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'send-enabled' }
  | { readonly kind: 'send-disabled'; readonly reason: CanSendBlockReason }
  /** No usable agent is selected: Send is disabled, and the chat pane's own banner explains why. */
  | { readonly kind: 'agent-inactive' };

/**
 * Streaming states with a turn actually in flight, i.e. exactly the states
 * for which a Stop button (calling `abort`) is the correct affordance
 * instead of Send. Deliberately excludes `closed`/`error`: those are
 * terminal/broken, not "something is running that Stop could cancel".
 */
const IN_FLIGHT_STATES: ReadonlySet<SessionStreamState> = new Set([
  'sending',
  'streaming',
  'runningTool',
  'cancelling',
]);

/**
 * Whether `state` is one of the in-flight states, i.e. a turn is running that
 * Stop (`abort`) could cancel. Exposed so the transcript's own "Thinking"
 * indicator (`transcriptStore.ts`'s `setTurnInFlight`) is driven by the exact
 * same set the composer's Stop button is - the two must appear and disappear
 * together (implementation-plan.md step 10).
 */
export function isTurnInFlight(state: SessionStreamState): boolean {
  return IN_FLIGHT_STATES.has(state);
}

/**
 * Derives what the composer's Send/Stop button should show right now.
 *
 * Checked in this order, each one short-circuiting the rest:
 *
 * 1. `serviceState === "starting"` - `agent-chat-ipc.ts`'s doc comment on
 *    `AgentChatStatus` is explicit that `auth`/`sessionState` are
 *    placeholder values while starting; running `canSendMessage` against
 *    them here would misreport "not authenticated" for a user who is merely
 *    a few seconds early, which is exactly the conflation the plan forbids.
 * 2. A turn in flight - `canSendMessage` has no notion of "Stop" at all (see
 *    below), so this composer-only concept has to be decided before
 *    delegating to it, not folded into its reason codes.
 * 3. No usable agent selected (`agentActive` false) - nothing can be sent at
 *    all. This is checked before `canSendMessage` because the chat pane owns
 *    the message for it (its own banner), not the composer's inline notice;
 *    returning a distinct state lets the composer stay silent while still
 *    looking disabled. It still comes *after* the in-flight check so a turn
 *    already running can always be stopped.
 * 4. Otherwise, `src/shared/contracts/sessionState.ts`'s own gate, called
 *    verbatim - this is the exact rule `agentChatController.ts`'s
 *    `sendMessage` enforces:
 *
 *      const gate = canSendMessage(sessionStatus);
 *      if (!gate.canSend) return { ok: false, error: blockReasonError(gate.reason) };
 *
 *    Reusing the function itself (not re-deriving its logic) is what
 *    guarantees the composer and main can never disagree about whether a
 *    send would be accepted.
 */
export function computeComposerButtonState(status: ComposerStatus): ComposerButtonState {
  if (status.serviceState === 'unavailable') return { kind: 'unavailable' };
  if (status.serviceState === 'starting') return { kind: 'connecting' };
  if (isTurnInFlight(status.session.state)) return { kind: 'stop' };
  if (!status.agentActive) return { kind: 'agent-inactive' };

  const gate = canSendMessage(status.session);
  if (!gate.canSend) return { kind: 'send-disabled', reason: gate.reason };
  return { kind: 'send-enabled' };
}

/** Human-readable text for a `send-disabled` reason, shown next to the composer. */
export function describeCanSendBlockReason(reason: CanSendBlockReason): string {
  switch (reason) {
    case 'session_closed':
      return 'This conversation is closed';
    case 'not_authenticated':
      return 'Sign in to the agent to send a message';
    case 'session_error':
      return 'The last turn ended in an error';
    case 'turn_in_progress':
      return 'A response is already in progress';
    default: {
      return reason;
    }
  }
}

export interface SubmitOnEnterInput {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  /**
   * Whether an IME composition session is currently open on the field. Must
   * come from tracking `compositionstart`/`compositionend` and/or the
   * triggering `KeyboardEvent.isComposing` - never assumed `false`.
   */
  readonly isComposing: boolean;
}

/**
 * Whether a `keydown` should submit the composer. Only a plain Enter
 * submits; any modifier (Shift, Ctrl, Alt or Meta) inserts a newline via the
 * field's own default multiline behaviour, left untouched here.
 *
 * Enter fired while `isComposing` is `true` must never submit: many IMEs
 * report `key: "Enter"` for the very keystroke that only confirms a
 * candidate, indistinguishable from an ordinary Enter press by `key` alone.
 * Submitting on that keystroke would send text the user had not finished
 * composing.
 */
export function shouldSubmitOnEnter(input: SubmitOnEnterInput): boolean {
  if (input.key !== 'Enter') return false;
  if (input.shiftKey || input.ctrlKey || input.altKey || input.metaKey) return false;
  return !input.isComposing;
}
