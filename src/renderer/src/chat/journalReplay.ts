import type { ChatJournalRecord } from '../../../shared';
import { toolRendererRegistry } from './toolRegistry';
import type { TranscriptStore } from './transcriptStore';

/**
 * Rebuilds a conversation's on-screen transcript from its append-only journal
 * (`chatJournal.ts`), so a chat resumed after a restart shows what was said
 * instead of an empty pane over a model that still remembers it.
 *
 * This is a *projection*, per implementation-plan.md step 09: the journal is
 * the UI record, the SDK session (restored by `resume`) is the model's context.
 * Only the record kinds that have a transcript representation are replayed:
 *
 *  - `user.prompt` - there is no `AgentEvent` for a user's own message, so this
 *    maps to {@link TranscriptStore.applyUserPrompt};
 *  - `agent.event` - a normalized event, fed back through the very same
 *    {@link TranscriptStore.applyEvent} the live stream uses;
 *  - `interruption` - a durable "Session stopped" notice (see `chatJournal.ts`).
 *    It is replayed as a *historical* notice (`resumable: false`), so a resumed
 *    chat shows it without offering the Resume action the live pane does.
 *
 * Deliberately ignored:
 *  - `header`, `chat.closed` and `turn.summary` - journal bookkeeping /
 *    diagnostics, no visual;
 *  - `assistant.message.partial` - a stopped turn's salvaged text; rendering it
 *    as a completed message would misrepresent the interrupted turn, so it is
 *    dropped rather than shown as something it was not;
 *  - `tool.call.abandoned` - an unresolved tool call. The record is not consumed
 *    directly: the final {@link TranscriptStore.abandonRunningToolCalls} settles
 *    *every* call the replay left running, which is the same set (and also
 *    covers a hard exit that never wrote the record), so the record needs no
 *    handler of its own. A turn that ended while a question was on screen is the
 *    one exception: its unfinished calls were not interrupted, so they settle
 *    with no status word (see that method's `awaitingInput`).
 */
export function replayJournalIntoTranscript(
  records: readonly ChatJournalRecord[],
  transcriptStore: TranscriptStore,
  shouldSuppressTurn: (prompt: string) => boolean = () => false,
): void {
  for (const record of records) {
    switch (record.recordType) {
      case 'user.prompt':
        transcriptStore.applyUserPrompt(record.turnId, record.prompt);
        // The suppression decision is re-derived from the replayed prompt, so a
        // search turn's prose stays hidden after a restart exactly as it was
        // live. Done here (between the prompt and its events) so no message
        // item is ever created for a suppressed turn.
        if (shouldSuppressTurn(record.prompt)) {
          transcriptStore.markTurnSuppressed(record.turnId);
        }
        break;
      case 'agent.event':
        transcriptStore.applyEvent(record.event);
        break;
      case 'interruption':
        transcriptStore.addInterruption(record.reason, false);
        break;
      case 'header':
      case 'session.opened':
      case 'assistant.message.partial':
      case 'tool.call.abandoned':
      case 'chat.closed':
      case 'turn.summary':
        break;
    }
  }
  // A rebuilt transcript has no live turn, so nothing can still be running: a
  // call the journal left without a result renders as an honest non-spinning
  // "Interrupted" billet instead of a spinner that will never stop.
  //
  // The one exception is a turn that ended **waiting on the user**: a still-
  // running call whose tool renders as a conversation (`ask_user`) means a
  // question was on screen when the app closed. Nothing was in flight and
  // nothing was interrupted, so those calls settle as `abandonedAwaitingInput` -
  // no status word at all - rather than "Interrupted" (see
  // `transcriptStore.ts`'s `abandonRunningToolCalls`).
  const awaitingInput = transcriptStore.items().some((item) => {
    if (item.kind !== 'toolCall') return false;
    const view = transcriptStore.toolCallFor(item.toolCallId);
    return (
      view !== undefined &&
      (view.status.kind === 'requested' || view.status.kind === 'approved') &&
      toolRendererRegistry.presentationOf(view.toolName) === 'conversation'
    );
  });
  transcriptStore.abandonRunningToolCalls(awaitingInput);
  // Likewise, a `format_table` call the journal left mid-count (`totalPending`)
  // shows its fallback total with no spinner - the count died with the process.
  transcriptStore.settlePendingTotals();
}
