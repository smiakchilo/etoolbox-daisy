/**
 * The one place a `ChatId` becomes a journal file name. Kept apart from both the
 * writer (`chatJournal.ts`) and the reader (`chatJournalReader.ts`) so each can
 * apply the identical guard without importing the other - the writer also reads
 * a chat's already-recorded session ids at open time (`chatJournal.ts`), and a
 * read path built from an attacker-influenced id is the same hazard as a write
 * path.
 *
 * `ChatId`s are validated to be free of control characters but are not
 * otherwise constrained, so this rejects path separators explicitly rather than
 * trusting the id's provenance - the journal must never be steerable to an
 * arbitrary file by a crafted id.
 */
export function toChatFileName(chatId: string): string {
  if (
    chatId.length === 0 ||
    chatId === '.' ||
    chatId === '..' ||
    chatId.includes('/') ||
    chatId.includes('\\')
  ) {
    throw new Error(`Refusing to derive a chat journal file name from unsafe chatId "${chatId}"`);
  }
  return `${chatId}.jsonl`;
}
