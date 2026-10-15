import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatId, ChatJournalRecord } from '../../../src/shared';
import { deriveChatTitle, listChatHistory, removeChatJournal } from '../../../src/main/chatHistory';
import type { ChatJournalReadOutcome } from '../../../src/main/chatJournalReader';

/**
 * `chatHistory` derives the browsable History list from the journals on disk.
 * The list/title logic is exercised through the injectable directory/journal
 * seams; the delete path uses a real scratch directory, since `rmSync`'s
 * idempotence is exactly the behaviour under test.
 */

const CHATS_DIR = 'C:/home/etoolbox-daisy/chats';

/** Brands a raw string as a `ChatId`, as the writer/reader boundaries do. */
function cid(value: string): ChatId {
  return value as ChatId;
}

function header(chatId: string, options: { readonly serverId?: string } = {}): ChatJournalRecord {
  return {
    recordType: 'header',
    schemaVersion: 1,
    chatId,
    sdkSessionId: `sdk-${chatId}`,
    startedAt: 1000,
    ...(options.serverId !== undefined ? { serverId: options.serverId } : {}),
  } as unknown as ChatJournalRecord;
}

function userPrompt(chatId: string, prompt: string, at = 2000): ChatJournalRecord {
  return {
    recordType: 'user.prompt',
    at,
    chatId,
    turnId: `turn-${chatId}`,
    prompt,
  } as unknown as ChatJournalRecord;
}

function closed(chatId: string, at: number): ChatJournalRecord {
  return { recordType: 'chat.closed', at, chatId } as unknown as ChatJournalRecord;
}

/** An injectable reader backed by `files`, keyed by chat id. */
function readerFor(
  files: Readonly<Record<string, readonly ChatJournalRecord[]>>,
): (chatsDir: string, chatId: string) => ChatJournalReadOutcome {
  return (_dir, chatId) => {
    const records = files[chatId];
    if (records === undefined) return { ok: false, reason: 'not_found' };
    return { ok: true, records };
  };
}

describe('deriveChatTitle', () => {
  it('collapses whitespace and trims', () => {
    expect(deriveChatTitle('  find  the\n\nmedia   library ')).toBe('find the media library');
  });

  it('returns undefined for blank input', () => {
    expect(deriveChatTitle('   \n\t ')).toBeUndefined();
  });

  it('truncates to 200 characters', () => {
    const title = deriveChatTitle('x'.repeat(500));
    expect(title).toHaveLength(200);
  });
});

describe('listChatHistory', () => {
  it('derives title, dates, server and session from the records', () => {
    const entries = listChatHistory(CHATS_DIR, {
      readDirectory: () => ['chat-1.jsonl'],
      readJournal: readerFor({
        'chat-1': [
          header('chat-1', { serverId: 'server-9' }),
          userPrompt('chat-1', 'Where is the media library?'),
          closed('chat-1', 5000),
        ],
      }),
    });

    expect(entries).toEqual([
      {
        chatId: 'chat-1',
        title: 'Where is the media library?',
        startedAt: 1000,
        updatedAt: 5000,
        serverId: 'server-9',
        sdkSessionId: 'sdk-chat-1',
      },
    ]);
  });

  it('omits a title when the journal holds no user prompt', () => {
    const entries = listChatHistory(CHATS_DIR, {
      readDirectory: () => ['chat-1.jsonl'],
      readJournal: readerFor({ 'chat-1': [header('chat-1')] }),
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBeUndefined();
  });

  it('orders by most recently used, breaking ties by chat id', () => {
    const entries = listChatHistory(CHATS_DIR, {
      readDirectory: () => ['a.jsonl', 'b.jsonl', 'c.jsonl'],
      readJournal: readerFor({
        a: [header('a'), closed('a', 5000)],
        b: [header('b'), closed('b', 9000)],
        c: [header('c'), closed('c', 9000)],
      }),
    });
    expect(entries.map((entry) => entry.chatId)).toEqual(['b', 'c', 'a']);
  });

  it('ignores non-journal names and unreadable journals', () => {
    const entries = listChatHistory(CHATS_DIR, {
      readDirectory: () => ['chat-1.jsonl', 'notes.txt', 'chat-2.jsonl'],
      readJournal: readerFor({ 'chat-1': [header('chat-1')] }),
    });
    expect(entries.map((entry) => entry.chatId)).toEqual(['chat-1']);
  });

  it('skips a journal with no header', () => {
    const entries = listChatHistory(CHATS_DIR, {
      readDirectory: () => ['chat-1.jsonl'],
      readJournal: readerFor({ 'chat-1': [userPrompt('chat-1', 'orphan')] }),
    });
    expect(entries).toEqual([]);
  });

  it('returns an empty list when the directory cannot be read', () => {
    const entries = listChatHistory(CHATS_DIR, {
      readDirectory: () => {
        throw new Error('ENOENT');
      },
    });
    expect(entries).toEqual([]);
  });
});

describe('removeChatJournal', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('removes the chat file and is idempotent', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'daisy-chats-'));
    writeFileSync(path.join(dir, 'chat-1.jsonl'), 'x\n', 'utf8');

    expect(removeChatJournal(dir, cid('chat-1'))).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    // A second removal of a file that is already gone still succeeds.
    expect(removeChatJournal(dir, cid('chat-1'))).toBe(true);
  });

  it('refuses an id that is not safe as a file name', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'daisy-chats-'));
    expect(removeChatJournal(dir, cid('../escape'))).toBe(false);
  });
});
