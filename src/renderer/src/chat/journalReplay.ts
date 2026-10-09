import type { ChatJournalRecord } from '../../../shared';
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
 *  - `header` and `chat.closed` - journal bookkeeping, no visual;
 *  - `assistant.message.partial` and `tool.call.abandoned` - a stopped turn's
 *    salvaged text / an unresolved tool call. Neither has a `TranscriptStore`
 *    representation, and inventing one (e.g. rendering salvaged partial text as
 *    a completed message) would misrepresent an interrupted turn. They are
 *    dropped rather than shown as something they were not.
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
      case 'assistant.message.partial':
      case 'tool.call.abandoned':
      case 'chat.closed':
        break;
    }
  }
}
