import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  type AgentChatHistoryEntry,
  type ChatId,
  type ChatJournalRecord,
  chatIdSchema,
} from '../shared';
import { toChatFileName } from './chatJournalPaths';
import { readChatJournal, type ChatJournalReadOutcome } from './chatJournalReader';

/**
 * The browsable History list, derived on demand from the append-only journals
 * under `<home>/etoolbox-daisy/chats` (implementation-plan.md step 09's
 * "History contains a title derived from the beginning of the first user
 * message ... start date, server"). Kept Electron-free - the directory is a
 * plain injected string - so it is unit-testable under plain vitest, exactly
 * like the writer and reader beside it.
 *
 * THERE IS NO SECOND METADATA STORE. The journal already holds everything the
 * list needs - the header's `startedAt`/`sessionId`, the chat's host (the
 * header's `serverId`, or the first prompt's when the header names none) and the
 * first `user.prompt` - so an index would only be a second thing to keep in sync
 * with the file it summarizes. The cost is reading each (bounded, small) journal
 * on every open; the alternative, a store that can drift from the journals it
 * describes, is strictly worse for a local single-user app.
 *
 * That cost is paid a page at a time (`snapshotChatHistoryIds` +
 * `readChatHistoryPage`, assembled by `chatHistoryPager.ts`): a large or
 * slow-disk history still returns its first rows quickly enough for the panel
 * to paint while the rest loads. The page order follows each journal's
 * modification time - when a chat was last written is when its newest record
 * was appended, so this matches the honest per-entry `updatedAt` ordering
 * without having to read every journal to know it.
 *
 * A journal that cannot be read (missing, unreadable, too large, torn) is
 * simply omitted from the list rather than failing the whole listing: one bad
 * file must never hide every conversation.
 */

const CHAT_FILE_SUFFIX = '.jsonl';

/** The schema's own bound (`chatTitleSchema`); a longer first prompt is truncated, never rejected. */
const TITLE_MAX_LENGTH = 200;

/** Names in the chats directory that are not history at all. */
function isChatFileName(name: string): boolean {
  return (
    name.endsWith(CHAT_FILE_SUFFIX) &&
    chatIdSchema.safeParse(name.slice(0, name.length - CHAT_FILE_SUFFIX.length)).success
  );
}

export interface ChatHistorySnapshotOptions {
  /** Injectable directory read; defaults to `readdirSync(dir)`. */
  readonly readDirectory?: (dir: string) => readonly string[];
  /**
   * Injectable per-file modification time; defaults to `statSync`'s `mtimeMs`.
   * A file that cannot be stat'ed yields no scan entry at all - the journal is
   * gone or unreadable, which the per-page reader would have skipped anyway.
   */
  readonly statMtimeMs?: (chatsDir: string, name: string) => number | undefined;
}

/**
 * The chat whose journals can produce history entries, in panel order: most
 * recently written first (a journal's write time is when its newest record was
 * appended), ties broken by chat id so the order is stable across calls.
 * Reading the *names* is cheap; each journal's contents are only read for the
 * page that needs them.
 */
export function snapshotChatHistoryIds(
  chatsDir: string,
  options: ChatHistorySnapshotOptions = {},
): readonly string[] {
  const readDirectory = options.readDirectory ?? ((dir: string) => readdirSync(dir));
  const statMtimeMs =
    options.statMtimeMs ??
    ((dir: string, name: string) => {
      try {
        return statSync(path.join(dir, name)).mtimeMs;
      } catch {
        return undefined;
      }
    });

  let names: readonly string[];
  try {
    names = readDirectory(chatsDir);
  } catch {
    // No chats directory yet (a profile that never stored a conversation): an
    // empty history, not an error.
    return [];
  }

  const ids = [
    ...new Set(
      names
        .filter(isChatFileName)
        .map((name) => name.slice(0, name.length - CHAT_FILE_SUFFIX.length)),
    ),
  ];
  const withTimes: { readonly id: string; readonly mtimeMs: number }[] = ids.flatMap((id) => {
    const mtimeMs = statMtimeMs(chatsDir, `${id}${CHAT_FILE_SUFFIX}`);
    return mtimeMs === undefined ? [] : [{ id, mtimeMs }];
  });
  withTimes.sort((left, right) => {
    if (right.mtimeMs !== left.mtimeMs) return right.mtimeMs - left.mtimeMs;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return withTimes.map((item) => item.id);
}

/**
 * One page of history entries. Unreadable journals and journals with no
 * describable content are skipped silently - one bad file must not hide every
 * conversation - and `hasMore` says whether a further page exists, based on
 * the ids the snapshot named (no matter how many entries this page produced).
 */
export interface ChatHistoryPage {
  readonly entries: readonly AgentChatHistoryEntry[];
  readonly hasMore: boolean;
}

export function readChatHistoryPage(
  chatsDir: string,
  ids: readonly string[],
  offset: number,
  limit: number,
  readJournal: (chatsDir: string, chatId: string) => ChatJournalReadOutcome = readChatJournal,
): ChatHistoryPage {
  const end = Math.min(offset + limit, ids.length);
  const entries: AgentChatHistoryEntry[] = [];
  for (let index = offset; index < end; index += 1) {
    const chatId = ids[index];
    if (chatId === undefined) continue;
    const outcome = readJournal(chatsDir, chatId);
    if (!outcome.ok) continue;
    const entry = entryFromRecords(chatId as ChatId, outcome.records);
    if (entry !== undefined) entries.push(entry);
  }
  return { entries, hasMore: end < ids.length };
}

/**
 * The history title for a chat: the beginning of the first user message, with
 * runs of whitespace collapsed and the result truncated to the title bound.
 * `undefined` when there is no user prompt or it is effectively blank - the UI
 * then shows its own "untitled" fallback rather than an empty label.
 */
export function deriveChatTitle(prompt: string): string | undefined {
  const collapsed = prompt.replace(/\s+/gu, ' ').trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > TITLE_MAX_LENGTH ? collapsed.slice(0, TITLE_MAX_LENGTH) : collapsed;
}

/** Every record with an `at`, except the header (which carries `startedAt` instead) - see the contract. */
function recordAt(record: ChatJournalRecord): number | undefined {
  return record.recordType === 'header' ? undefined : record.at;
}

function entryFromRecords(
  chatId: ChatId,
  records: readonly ChatJournalRecord[],
): AgentChatHistoryEntry | undefined {
  const header = records.find((record) => record.recordType === 'header');
  // Without a header there is no startedAt/server/session to describe, and a
  // header is the first line of every journal the writer produces - so a file
  // lacking one is not a journal this app wrote (or is torn past the header).
  if (header === undefined) return undefined;

  const firstPrompt = records.find((record) => record.recordType === 'user.prompt');
  const title = firstPrompt === undefined ? undefined : deriveChatTitle(firstPrompt.prompt);

  // The host the chat belongs to. The header names the host active when the chat
  // *opened*, which for the startup chat (opened before any page was restored) is
  // none. The first prompt that named one is the host it was first *used* on, so
  // it is the fallback - first known host wins.
  let serverId = header.serverId;
  if (serverId === undefined) {
    for (const record of records) {
      if (record.recordType === 'user.prompt' && record.serverId !== undefined) {
        serverId = record.serverId;
        break;
      }
    }
  }

  let updatedAt = header.startedAt;
  for (const record of records) {
    const at = recordAt(record);
    if (at !== undefined && at > updatedAt) updatedAt = at;
  }

  return {
    chatId,
    ...(title !== undefined ? { title } : {}),
    startedAt: header.startedAt,
    updatedAt,
    ...(serverId !== undefined ? { serverId } : {}),
    ...(header.sessionId !== undefined ? { sessionId: header.sessionId } : {}),
  };
}

/**
 * Removes one chat's journal file. Idempotent: a chat whose file is already
 * gone is a success, so a deletion that reached the disk once can be retried
 * without special-casing the second attempt. Returns `false` only when the file
 * could not be removed (e.g. it is locked), which the caller reports as a
 * partial failure rather than declaring the chat gone.
 */
export function removeChatJournal(chatsDir: string, chatId: ChatId): boolean {
  let filePath: string;
  try {
    filePath = path.join(chatsDir, toChatFileName(chatId));
  } catch {
    return false;
  }
  try {
    rmSync(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}
