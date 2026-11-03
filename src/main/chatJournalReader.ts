import { readFileSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { chatJournalRecordSchema, type ChatJournalRecord, type SessionId } from '../shared';
import { toChatFileName } from './chatJournalPaths';

/**
 * Reads one chat's append-only journal (`chatJournal.ts`), the UI projection a
 * renderer repaints a resumed conversation from. Kept Electron-free - the
 * directory is a plain injected string - so it is unit-testable under plain
 * vitest, exactly like the writer.
 *
 * Deliberately tolerant, in the same spirit as `normalizeSettingsDocument`: a
 * line that does not parse (a torn final line from a crash mid-append, a
 * hand-edited file) is skipped rather than failing the whole read. A reader
 * that showed no transcript because the last line was truncated would be
 * strictly worse than one that shows every complete record.
 */

export type ChatJournalReadFailureReason =
  /** The id could not safely be turned into a file name. */
  | 'invalid_chat_id'
  /** No journal file exists for this chat. */
  | 'not_found'
  /** The file exists but could not be read. */
  | 'unreadable'
  /** The file exceeds {@link DEFAULT_CHAT_JOURNAL_MAX_BYTES}. */
  | 'too_large';

export type ChatJournalReadOutcome =
  | { readonly ok: true; readonly records: readonly ChatJournalRecord[] }
  | { readonly ok: false; readonly reason: ChatJournalReadFailureReason };

export interface ChatJournalReaderOptions {
  /** Injectable text read, so tests need no real file. Defaults to `readFileSync(path, 'utf8')`. */
  readonly readText?: (filePath: string) => string;
  /** Injectable size probe, so tests need no real file. Defaults to `statSync(path).size`. */
  readonly fileSize?: (filePath: string) => number;
  /** Upper bound on a single read; a larger file is refused rather than parsed. */
  readonly maxBytes?: number;
}

/** The asynchronous sibling's seams; every default reads the real file. */
export interface AsyncChatJournalReaderOptions {
  /** Injectable text read, so tests need no real file. Defaults to `readFile(path, 'utf8')`. */
  readonly readText?: (filePath: string) => Promise<string>;
  /** Injectable size probe, so tests need no real file. Defaults to `stat(path)`'s size. */
  readonly fileSize?: (filePath: string) => Promise<number>;
  /** Upper bound on a single read; a larger file is refused rather than parsed. */
  readonly maxBytes?: number;
}

/**
 * Lines one task parses before the asynchronous reader yields to the event
 * loop, so a large journal cannot monopolise the main process while the page
 * it was restored alongside is still loading.
 */
export const JOURNAL_PARSE_CHUNK_LINES = 512;

/**
 * Bounds one read so a corrupt or enormous file cannot be slurped into memory
 * and parsed synchronously on the startup path. Comfortably above any plausible
 * hand-authored conversation.
 */
export const DEFAULT_CHAT_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;

/** One journal line as a record, or `undefined` for a blank/torn/hand-edited one. */
function parseJournalLine(line: string): ChatJournalRecord | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let parsedLine: unknown;
  try {
    parsedLine = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const record = chatJournalRecordSchema.safeParse(parsedLine);
  return record.success ? record.data : undefined;
}

/**
 * Resolves the journal path for an id, or reports `invalid_chat_id` without
 * touching the filesystem.
 */
function journalPath(chatsDir: string, chatId: string): string | undefined {
  try {
    return path.join(chatsDir, toChatFileName(chatId));
  } catch {
    return undefined;
  }
}

export function readChatJournal(
  chatsDir: string,
  chatId: string,
  options: ChatJournalReaderOptions = {},
): ChatJournalReadOutcome {
  const maxBytes = options.maxBytes ?? DEFAULT_CHAT_JOURNAL_MAX_BYTES;
  const readText = options.readText ?? ((filePath: string) => readFileSync(filePath, 'utf8'));
  const fileSize = options.fileSize ?? ((filePath: string) => statSync(filePath).size);

  const filePath = journalPath(chatsDir, chatId);
  if (filePath === undefined) return { ok: false, reason: 'invalid_chat_id' };

  try {
    if (fileSize(filePath) > maxBytes) return { ok: false, reason: 'too_large' };
  } catch {
    return { ok: false, reason: 'not_found' };
  }

  let text: string;
  try {
    text = readText(filePath);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  const records: ChatJournalRecord[] = [];
  for (const line of text.split('\n')) {
    const record = parseJournalLine(line);
    if (record !== undefined) records.push(record);
  }
  return { ok: true, records };
}

/**
 * Same read, never blocking the event loop: the file is read with `fs/promises`
 * and the lines are parsed in chunks, yielding between them. This is what the
 * `agent-chat:read-journal` handler uses for the startup restore, so the local
 * read cannot starve the browser restore (a navigation IPC, a page's state
 * push) that is in flight at the same time. Everything else - the injected
 * seams, the failure taxonomy, the tolerant per-line parsing - matches
 * {@link readChatJournal}.
 */
export async function readChatJournalAsync(
  chatsDir: string,
  chatId: string,
  options: AsyncChatJournalReaderOptions = {},
): Promise<ChatJournalReadOutcome> {
  const maxBytes = options.maxBytes ?? DEFAULT_CHAT_JOURNAL_MAX_BYTES;
  const readText = options.readText ?? ((filePath: string) => readFile(filePath, 'utf8'));
  const fileSize = options.fileSize ?? (async (filePath: string) => (await stat(filePath)).size);

  const filePath = journalPath(chatsDir, chatId);
  if (filePath === undefined) return { ok: false, reason: 'invalid_chat_id' };

  try {
    if ((await fileSize(filePath)) > maxBytes) return { ok: false, reason: 'too_large' };
  } catch {
    return { ok: false, reason: 'not_found' };
  }

  let text: string;
  try {
    text = await readText(filePath);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  const lines = text.split('\n');
  const records: ChatJournalRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const record = parseJournalLine(lines[index] ?? '');
    if (record !== undefined) records.push(record);
    if ((index + 1) % JOURNAL_PARSE_CHUNK_LINES === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return { ok: true, records };
}

/**
 * Every SDK session id a chat's journal recorded, in order: the `header`'s
 * first session followed by one id per later `session.opened` record (a runtime
 * recycle). This is what makes deleting a chat remove the SDK's stored data for
 * *every* session it ever minted - an old journal with a header only (written
 * before `session.opened` existed) reads as a single id rather than failing.
 *
 * Tolerant like {@link readChatJournal}: an unreadable or oversized file yields
 * no ids rather than throwing, so the caller's deletion still proceeds.
 */
export function readChatSessionIds(
  chatsDir: string,
  chatId: string,
  options: ChatJournalReaderOptions = {},
): readonly SessionId[] {
  const outcome = readChatJournal(chatsDir, chatId, options);
  if (!outcome.ok) return [];
  const ids: SessionId[] = [];
  for (const record of outcome.records) {
    if (record.recordType === 'header' || record.recordType === 'session.opened') {
      ids.push(record.sessionId);
    }
  }
  return ids;
}
