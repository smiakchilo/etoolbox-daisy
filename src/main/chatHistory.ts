import { readdirSync, rmSync } from 'node:fs';
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
 * The browsable chat history, derived on demand from the append-only journals
 * under `<home>/etoolbox-daisy/chats` (implementation-plan.md step 09's
 * "History contains a title derived from the beginning of the first user
 * message ... start date, server"). Kept Electron-free - the directory is a
 * plain injected string - so it is unit-testable under plain vitest, exactly
 * like the writer and reader beside it.
 *
 * THERE IS NO SECOND METADATA STORE. The journal already holds everything the
 * list needs - the header's `startedAt`/`sdkSessionId`, the chat's host (the
 * header's `serverId`, or the first prompt's when the header names none) and the
 * first `user.prompt` - so an index would only be a second thing to keep in sync
 * with the file it summarizes. The cost is reading each (bounded, small) journal
 * on every open; the alternative, a store that can drift from the journals it
 * describes, is strictly worse for a local single-user app.
 *
 * A journal that cannot be read (missing, unreadable, too large, torn) is
 * simply omitted from the list rather than failing the whole listing: one bad
 * file must never hide every conversation.
 */

const CHAT_FILE_SUFFIX = '.jsonl';

/** The schema's own bound (`chatTitleSchema`); a longer first prompt is truncated, never rejected. */
const TITLE_MAX_LENGTH = 200;

export interface ChatHistoryListOptions {
  /** Injectable directory read; defaults to `readdirSync(dir)`. */
  readonly readDirectory?: (dir: string) => readonly string[];
  /** Injectable single-journal read; defaults to `readChatJournal`. */
  readonly readJournal?: (chatsDir: string, chatId: string) => ChatJournalReadOutcome;
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
    ...(header.sdkSessionId !== undefined ? { sdkSessionId: header.sdkSessionId } : {}),
  };
}

/**
 * Lists every readable stored conversation, most recently used first. Ties
 * (equal `updatedAt`, e.g. two chats that resumed at the same millisecond) are
 * broken by `chatId` so the order is stable across calls.
 */
export function listChatHistory(
  chatsDir: string,
  options: ChatHistoryListOptions = {},
): readonly AgentChatHistoryEntry[] {
  const readDirectory = options.readDirectory ?? ((dir: string) => readdirSync(dir));
  const readJournal = options.readJournal ?? readChatJournal;

  let names: readonly string[];
  try {
    names = readDirectory(chatsDir);
  } catch {
    // No chats directory yet (a profile that never stored a conversation): an
    // empty history, not an error.
    return [];
  }

  const entries: AgentChatHistoryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(CHAT_FILE_SUFFIX)) continue;
    const chatId = name.slice(0, name.length - CHAT_FILE_SUFFIX.length);
    if (!chatIdSchema.safeParse(chatId).success) continue;
    const outcome = readJournal(chatsDir, chatId);
    if (!outcome.ok) continue;
    const entry = entryFromRecords(chatId as ChatId, outcome.records);
    if (entry !== undefined) entries.push(entry);
  }

  entries.sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
    return left.chatId < right.chatId ? -1 : left.chatId > right.chatId ? 1 : 0;
  });
  return entries;
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
