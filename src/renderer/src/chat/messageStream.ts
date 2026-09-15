import {
  createDeltaFoldState,
  foldTextDelta,
  renderFoldedText,
  type AgentEvent,
  type DeltaFoldState,
  type MessageId,
} from '../../../shared';

/**
 * Renderer-side view state for the chat transcript: given the normalized
 * agent event stream (`src/shared/contracts/agentEvents.ts`), tracks the
 * current best-known text of every in-flight or completed assistant message
 * and an edge-triggered "something changed" flag for a throttled repaint
 * loop.
 *
 * This is deliberately a THIN layer on top of the shared contract layer, not
 * a second implementation of it. `src/shared/contracts/agentEvents.ts`
 * already owns delta accumulation end to end:
 *
 * - `DeltaFoldState`/`createDeltaFoldState`/`foldTextDelta` store deltas
 *   keyed by `sequence`, not by arrival order, so redelivery of the same
 *   `sequence` overwrites its own slot instead of duplicating text, and
 *   deltas that arrive out of order (other events for the same chat can be
 *   interleaved between two deltas of the same message) still reassemble
 *   correctly.
 * - `assistant.message.completed`'s `content` field is documented there as
 *   REPLACING delta-accumulated text, never appending to it.
 *
 * Re-deriving any of that here would create a second place that could drift
 * from the contract every other part of the app relies on. What is missing
 * from the shared layer - and what this module adds - is purely
 * view-state bookkeeping: routing an incoming `AgentEvent` to the right
 * message's fold state, remembering the `assistant.message.completed`
 * override once one arrives, and telling a throttled renderer when it needs
 * to repaint.
 */
export interface MessageStream {
  /**
   * Feeds one normalized agent event into the view state. Takes the full
   * `AgentEvent` union (not just the two variants this module cares about)
   * so a caller can pipe the whole event stream through unfiltered; event
   * types other than `assistant.text.delta` and `assistant.message.completed`
   * do not affect message text and are ignored here.
   */
  applyEvent(event: AgentEvent): void;

  /**
   * The current best-known text for `messageId`: the folded deltas while the
   * message is still streaming, or the `assistant.message.completed`
   * override once one has arrived for it. Returns `""` for a `messageId`
   * this stream has not observed any event for yet.
   */
  textFor(messageId: MessageId): string;

  /**
   * Edge-triggered change flag a throttled renderer polls instead of
   * re-diffing every message's text on every tick: `true` at most once per
   * actual text change (across any message), then `false` until the next
   * one. Reading it clears it - see `streamAccumulator.ts`'s `takeDirty` for
   * the same rationale, which this mirrors.
   */
  takeDirty(): boolean;
}

/**
 * One message's view state. A discriminated union - rather than an
 * `completed: boolean` field plus an always-present-but-sometimes-unused
 * `finalText: string` - so that "completed" and "has a final override text"
 * can never disagree, and so `finalText` is never a placeholder value that
 * happens to not be read yet.
 */
type MessageViewState =
  | { readonly completed: false; readonly fold: DeltaFoldState }
  | { readonly completed: true; readonly fold: DeltaFoldState; readonly finalText: string };

/** The text `state` currently renders as, per the same rule `textFor` documents. */
function textOf(state: MessageViewState): string {
  return state.completed ? state.finalText : renderFoldedText(state.fold);
}

/** Creates an empty message stream view with no messages observed yet. */
export function createMessageStream(): MessageStream {
  const states = new Map<MessageId, MessageViewState>();
  let dirty = false;

  /** Records `next` for `messageId` and marks dirty iff its rendered text actually changed. */
  function setState(messageId: MessageId, previousText: string, next: MessageViewState): void {
    states.set(messageId, next);
    if (textOf(next) !== previousText) dirty = true;
  }

  return {
    applyEvent(event) {
      switch (event.type) {
        case 'assistant.text.delta': {
          const existing = states.get(event.messageId);
          // A delta for a message that has already completed belongs to a
          // turn the UI has already rendered and recorded as final
          // (implementation-plan.md step 06 persists completed text as
          // authoritative); applying it now would silently reopen and
          // mutate a message the rest of the app already treats as done.
          // `foldTextDelta` itself has no way to know a message is "closed"
          // (it only knows about the fold state, not completion), so this
          // check has to live here.
          if (existing?.completed === true) return;

          const previousText = existing ? textOf(existing) : '';
          const fold = foldTextDelta(
            existing?.fold ?? createDeltaFoldState(event.messageId),
            event,
          );
          setState(event.messageId, previousText, { completed: false, fold });
          return;
        }
        case 'assistant.message.completed': {
          const existing = states.get(event.messageId);
          const previousText = existing ? textOf(existing) : '';
          // Preserve whatever fold state exists (or start an empty one) so a
          // message that never received any deltas still has a well-formed
          // `DeltaFoldState` on record - `fold` is not read again once
          // `completed` is `true`, but keeping the union's shape uniform
          // avoids a third, completed-with-no-fold variant that nothing
          // needs.
          const fold = existing?.fold ?? createDeltaFoldState(event.messageId);
          setState(event.messageId, previousText, {
            completed: true,
            fold,
            finalText: event.content,
          });
          return;
        }
        default:
          // Every other normalized event (message-started, tool events,
          // session-state, error) carries no message text of its own; this
          // view exists only to answer "what does message X currently
          // read", so there is nothing for it to record.
          return;
      }
    },
    textFor(messageId) {
      const state = states.get(messageId);
      return state === undefined ? '' : textOf(state);
    },
    takeDirty() {
      const wasDirty = dirty;
      dirty = false;
      return wasDirty;
    },
  };
}
