import { err, ok, type Result } from '../result';
import { type AgentEvent, SESSION_STREAM_STATES, type SessionStreamState } from './agentEvents';

/**
 * The chat session state machine (implementation-plan.md step 03).
 *
 * `SessionStreamState` (the idle/sending/streaming/... enum) lives in
 * `agentEvents.ts`, not here: it is the payload of that module's
 * `session.state.changed` event, and this module imports it from there so
 * the two modules depend on each other in one direction only.
 *
 * Two concerns are handled here that must NOT be folded into
 * `SessionStreamState` itself:
 *
 * - Whether the user is signed in to Copilot.
 * - Whether the browser pane is currently on the active server and ready
 *   for a tool call to target it.
 *
 * Both can be true or false in combination with *any* streaming state - the
 * user can lose their browser session mid-stream, or the browser can be mid
 * server-switch while a chat sits idle. Adding "notSignedIn" or
 * "browserNotReady" as extra members of the streaming enum would multiply
 * the state space by every combination of the two, most of them unreachable
 * or meaningless, and would force the UI to infer "am I blocked, and why?"
 * from which of a dozen enum members it is looking at. Keeping them as
 * separate fields on `SessionStatus` means each condition is set by the part
 * of the app that actually knows about it (auth flow, browser navigation)
 * independently of the agent event stream. `canSendMessage` and
 * `canRunTool` below each combine the fields relevant to the question
 * they answer into a single yes/no-with-reason result - deliberately two
 * functions, not one, because the two questions have different answers: see
 * their doc comments for why `browserReady` gates only the second.
 */

/**
 * Legal transitions, expressed as data rather than scattered `if` checks, so
 * `canTransition`/`applyTransition` cannot silently drift from what the rest
 * of this module assumes. `closed` has no outgoing entries at all - not even
 * to itself - because the plan requires it to be terminal.
 *
 * Every non-closed state may transition to itself (a no-op event does not
 * need special-casing by callers) and to `closed` (a chat can be deleted or
 * shut down from any in-flight state) and to `error` (an unexpected failure
 * can occur at any point before the session is closed).
 *
 * `sending` is reachable only from `idle`: a second prompt cannot be sent
 * over an unfinished turn (requirements-decisions.md section 7 / step 07).
 * `runningTool` is reachable from `sending` or `streaming`, and returns to
 * `streaming`: a tool call can be the very first activity of a turn. The SDK
 * can emit `external_tool.requested` with no preceding
 * `assistant.message_start` (observed live - a turn whose first action is a
 * tool call, with no prose before it), so `sending` -> `runningTool` must be
 * legal. The older assumption that a tool call always follows an assistant
 * message start was false. `streaming` may also go straight to
 * `idle`: a turn ends once the assistant's final message completes, which
 * happens while still `streaming`, not while `runningTool`. `cancelling` is
 * reachable from every state that represents outstanding work (`sending`,
 * `streaming`, `runningTool`) but not from `idle` - there is nothing in
 * flight to cancel.
 *
 * `error`'s only recovery path is to `idle`. This is a deliberate choice:
 * silently resuming `streaming`/`runningTool` after an error would let a
 * broken turn continue as if nothing happened. Recovery is only ever to a
 * clean `idle`, standing in for the user (or the UI on their behalf)
 * dismissing the error before the composer becomes usable again; starting a
 * new turn from there is an ordinary `idle` -> `sending` transition.
 */
const LEGAL_TRANSITIONS: Readonly<Record<SessionStreamState, readonly SessionStreamState[]>> = {
  idle: ['idle', 'sending', 'error', 'closed'],
  sending: ['sending', 'streaming', 'runningTool', 'cancelling', 'error', 'closed'],
  streaming: ['streaming', 'runningTool', 'idle', 'cancelling', 'error', 'closed'],
  runningTool: ['runningTool', 'streaming', 'cancelling', 'error', 'closed'],
  cancelling: ['cancelling', 'idle', 'error', 'closed'],
  error: ['error', 'idle', 'closed'],
  closed: [],
};

export function canTransition(from: SessionStreamState, to: SessionStreamState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export interface IllegalTransitionError {
  readonly from: SessionStreamState;
  readonly to: SessionStreamState;
  readonly message: string;
}

/**
 * Attempts a transition, reporting rather than throwing on an illegal one:
 * an illegal transition means the caller (agent adapter, UI, or a reducer
 * below) disagreed with this module about what state the session is in,
 * which is a bug worth surfacing at the call site rather than a crash or a
 * silently-ignored no-op.
 */
export function applyTransition(
  from: SessionStreamState,
  to: SessionStreamState,
): Result<SessionStreamState, IllegalTransitionError> {
  if (!canTransition(from, to)) {
    return err({
      from,
      to,
      message: `Illegal session state transition from "${from}" to "${to}"`,
    });
  }
  return ok(to);
}

// --- Authentication / browser readiness, kept orthogonal ------------------

export interface SessionStatus {
  readonly state: SessionStreamState;
  /** Whether the user currently has a usable Copilot sign-in. */
  readonly authenticated: boolean;
  /** Whether the browser pane is on the active server and ready for a tool call. */
  readonly browserReady: boolean;
}

export const CAN_SEND_BLOCK_REASONS = [
  'session_closed',
  'not_authenticated',
  'session_error',
  'turn_in_progress',
] as const;

export type CanSendBlockReason = (typeof CAN_SEND_BLOCK_REASONS)[number];

export type CanSendResult =
  { readonly canSend: true } | { readonly canSend: false; readonly reason: CanSendBlockReason };

/**
 * Derives whether the user may send a message right now, and - when they
 * cannot - why, so the UI can explain the block instead of merely disabling
 * the composer. Checks a fixed priority order (closed, then auth, then
 * error, then in-flight work) so exactly one reason is ever reported even
 * when several conditions are simultaneously true.
 *
 * Deliberately does NOT check `browserReady`. requirements-decisions.md
 * section 3 says "the bridge is unavailable during navigation, server
 * switching, or while the browser is on another origin" - that describes the
 * *tool bridge*, not the composer, and nothing in the docs disables the
 * message input for it. navigation happens constantly; gating sending on
 * it would disable the composer mid-sentence and would also stop the user
 * asking Copilot something that needs no browser access at all. `browserReady`
 * still answers a real question - see `canRunTool` below - it just is not
 * this one.
 */
export function canSendMessage(status: SessionStatus): CanSendResult {
  if (status.state === 'closed') return { canSend: false, reason: 'session_closed' };
  if (!status.authenticated) return { canSend: false, reason: 'not_authenticated' };
  if (status.state === 'error') return { canSend: false, reason: 'session_error' };
  if (status.state !== 'idle') return { canSend: false, reason: 'turn_in_progress' };
  return { canSend: true };
}

export const TOOL_BLOCK_REASONS = [
  'session_closed',
  'session_error',
  'cancelling',
  'browser_not_ready',
] as const;

export type ToolBlockReason = (typeof TOOL_BLOCK_REASONS)[number];

export type CanRunToolResult =
  { readonly canRun: true } | { readonly canRun: false; readonly reason: ToolBlockReason };

/**
 * Derives whether a tool call that targets the browser pane may run right
 * now - the question requirements-decisions.md section 3 is actually about.
 * Separate from `canSendMessage`: authentication to Copilot and the
 * conversational turn state are irrelevant to whether the bridge can reach
 * the browser, and folding this into the composer's own answer would block
 * sending for a reason the user cannot see or act on from the composer.
 * Consumed by the tool-call adapter (step 06/07), not the composer.
 *
 * `cancelling` blocks with its own named reason, not folded into
 * `session_closed`: requirements-decisions.md line 167 ("Cancel queued
 * requests when stopping or switching context") and lines 200-201
 * ("Selecting another chat/server or New chat stops the current response
 * and cancels application-side requests") both describe `cancelling` as
 * exactly the state whose entire purpose is tearing down in-flight bridge work.
 * Starting a *new* request while that teardown is happening is the
 * opposite of the requirement. The reason is distinct from
 * `session_closed` because the caller needs to tell "this session is over"
 * (permanent) apart from "we are stopping current work" (transient -
 * `cancelling` always resolves to `idle`, `error`, or `closed`).
 *
 * `error` also blocks, for the same reason `canSendMessage` blocks on
 * `session_error`: this module's only defined recovery path out of `error`
 * is to `idle` (see the transition table above), specifically so a broken
 * turn cannot be resumed as if nothing happened. An tool call that
 * reaches this gate is part of that same turn machinery (requested and
 * approved via the `tool.call.*` events, which only fire while
 * `streaming`/`runningTool`); letting it start anyway after the turn has
 * already errored would resume exactly the broken turn the `error` state
 * exists to stop. The two functions are deliberately symmetric here, unlike
 * their disagreement over `browserReady`.
 *
 * `idle` is deliberately left permissive: nothing in requirements-decisions.md
 * restricts tool calls to a particular streaming state, and a tool call
 * is not necessarily driven by the current chat turn - the browser pane itself
 * can originate a read independently of whether a chat happens to be mid
 * turn. Note this does surface a real seam: `nextStreamStateForEvent` only
 * ever reaches `runningTool` *from* `sending` or `streaming` (see its doc
 * comment above), so a tool call approved while `idle` executes without the
 * state machine ever recording `runningTool` for it. That is a gap between this gate and
 * the reducer's bookkeeping, not a bug in either half considered alone; it
 * is left open deliberately rather than closed by guessing which side should
 * change, and is worth the next reader's attention if `idle`-time tool calls
 * turn out to need their own tracked state.
 */
export function canRunTool(status: SessionStatus): CanRunToolResult {
  if (status.state === 'closed') return { canRun: false, reason: 'session_closed' };
  if (status.state === 'error') return { canRun: false, reason: 'session_error' };
  if (status.state === 'cancelling') return { canRun: false, reason: 'cancelling' };
  if (!status.browserReady) return { canRun: false, reason: 'browser_not_ready' };
  return { canRun: true };
}

// --- Applying agent events --------------------------------------------------

/**
 * Maps a normalized `AgentEvent` to the streaming state it implies, given the
 * state the chat is currently in.
 *
 * Most variants map to a fixed target regardless of the current state -
 * `applyTransition` is what rejects an event that arrives in a state it
 * cannot legally apply to (for example, a late `tool.result` delivered after
 * the chat has already moved to `cancelling`). `session.state.changed`
 * carries its own target explicitly, because it normalizes several distinct
 * SDK signals (`session.start`/`idle`/`resume`/`shutdown`,
 * `assistant.turn_start`/`turn_end`) whose target state only the adapter
 * that emitted the event actually knows.
 *
 * Entering `cancelling` is deliberately never produced here: cancellation is
 * initiated by the application (the user pressing Stop), not learned from the
 * SDK's event stream, so it is reached only through a direct
 * `applyTransition(current, "cancelling")` call, not through this reducer.
 */
function nextStreamStateForEvent(
  current: SessionStreamState,
  event: AgentEvent,
): SessionStreamState {
  switch (event.type) {
    case 'assistant.message.started':
      return 'streaming';
    case 'tool.call.requested':
      return 'runningTool';
    case 'tool.call.rejected':
    case 'tool.result':
      return 'streaming';
    case 'error':
      return 'error';
    case 'session.state.changed':
      return event.state;
    // An ask-user question is emitted mid-`runningTool` and does not itself
    // move the turn: the tool call that requested it already did, and the
    // answer arrives as that call's `tool.result`. A tool-call progress note is
    // likewise a status update for a turn the `tool.call.requested` event
    // already moved to `runningTool`. The `model.*` events are
    // diagnostics-only: observing which model ran never moves the turn.
    case 'assistant.text.delta':
    case 'assistant.message.completed':
    case 'assistant.reasoning.delta':
    case 'assistant.reasoning.completed':
    case 'tool.call.approved':
    case 'tool.call.progress':
    case 'user.input.requested':
    case 'user.input.actions.added':
    case 'model.changed':
    case 'model.usage':
    case 'context.usage':
    case 'model.call.failed':
      return current;
    default: {
      return event;
    }
  }
}

/**
 * Applies one `AgentEvent` to a `SessionStatus`, so the renderer and main
 * process derive the same next state from the same event instead of each
 * maintaining their own interpretation. Pure: returns a new `SessionStatus`
 * (or the same reference when the event does not change the streaming
 * state) and never mutates its input. `authenticated`/`browserReady` are
 * left untouched - the agent event stream never carries them, by design
 * (see the module doc above).
 */
export function applyAgentEvent(
  status: SessionStatus,
  event: AgentEvent,
): Result<SessionStatus, IllegalTransitionError> {
  const target = nextStreamStateForEvent(status.state, event);
  if (target === status.state) return ok(status);

  const transitioned = applyTransition(status.state, target);
  if (!transitioned.ok) return transitioned;
  return ok({ ...status, state: transitioned.value });
}

export { SESSION_STREAM_STATES };
export type { SessionStreamState };
