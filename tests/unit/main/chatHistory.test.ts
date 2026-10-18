import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatId, ChatJournalRecord } from '../../../src/shared';
import {
  deriveChatTitle,
  readChatHistoryPage,
  removeChatJournal,
  snapshotChatHistoryIds,
} from '../../../src/main/chatHistory';
import type { ChatJournalReadOutcome } from '../../../src/main/chatJournalReader';

/**
 * `chatHistory` derives the browsable History list from the journals on disk,
 * one small page at a time: `snapshotChatHistoryIds` names the chats in panel
 * order (newest first, ties by chat id), `readChatHistoryPage` reads just the
 * journals one page covers. The logic is exercised through the injectable
 * directory/mtime/journal seams; the delete path uses a real scratch
 * directory, since `rmSync`'s idempotence is exactly the behaviour under test.
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
    sessionId: `sdk-${chatId}`,
    startedAt: 1000,
    ...(options.serverId !== undefined ? { serverId: options.serverId } : {}),
  } as unknown as ChatJournalRecord;
}

function userPrompt(
  chatId: string,
  prompt: string,
  options: { readonly at?: number; readonly serverId?: string } = {},
): ChatJournalRecord {
  return {
    recordType: 'user.prompt',
    at: options.at ?? 2000,
    chatId,
    turnId: `turn-${chatId}`,
    prompt,
    ...(options.serverId !== undefined ? { serverId: options.serverId } : {}),
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

describe('snapshotChatHistoryIds', () => {
  it('orders by most recently written, breaking ties by chat id', () => {
    const mtimes: Record<string, number> = {
      'a.jsonl': 100,
      'b.jsonl': 900,
      'c.jsonl': 900,
    };
    const ids = snapshotChatHistoryIds(CHATS_DIR, {
      readDirectory: () => ['a.jsonl', 'b.jsonl', 'c.jsonl', 'notes.txt'],
      statMtimeMs: (_dir, name) => mtimes[name],
    });
    expect(ids).toEqual(['b', 'c', 'a']);
  });

  it('ignores names that are no chat journal', () => {
    const ids = snapshotChatHistoryIds(CHATS_DIR, {
      readDirectory: () => ['chat-1.jsonl', 'notes.txt', '.jsonl'],
      statMtimeMs: () => 1,
    });
    expect(ids).toEqual(['chat-1']);
  });

  it('drops a file it cannot stat, without failing the snapshot', () => {
    const ids = snapshotChatHistoryIds(CHATS_DIR, {
      readDirectory: () => ['chat-1.jsonl', 'chat-2.jsonl'],
      statMtimeMs: (_dir, name) => (name === 'chat-1.jsonl' ? 100 : undefined),
    });
    expect(ids).toEqual(['chat-1']);
  });

  it('returns an empty snapshot when the directory cannot be read', () => {
    const ids = snapshotChatHistoryIds(CHATS_DIR, {
      readDirectory: () => {
        throw new Error('ENOENT');
      },
    });
    expect(ids).toEqual([]);
  });

  it('stats the default way against a real directory with real files', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'daisy-chats-'));
    try {
      writeFileSync(path.join(scratch, 'chat-1.jsonl'), '{}\n', 'utf8');
      writeFileSync(path.join(scratch, 'chat-2.jsonl'), '{}\n', 'utf8');
      writeFileSync(path.join(scratch, 'notes.txt'), 'x', 'utf8');
      // mtime ordering is not asserted (too fine for different hosts); the
      // default stat path succeeding on a real directory is the point.
      expect(snapshotChatHistoryIds(scratch)).toHaveLength(2);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('readChatHistoryPage', () => {
  it('derives title, dates, server and session from the records', () => {
    const page = readChatHistoryPage(
      CHATS_DIR,
      ['chat-1'],
      0,
      10,
      readerFor({
        'chat-1': [
          header('chat-1', { serverId: 'server-9' }),
          userPrompt('chat-1', 'Where is the media library?'),
          closed('chat-1', 5000),
        ],
      }),
    );

    expect(page.entries).toEqual([
      {
        chatId: 'chat-1',
        title: 'Where is the media library?',
        startedAt: 1000,
        updatedAt: 5000,
        serverId: 'server-9',
        sessionId: 'sdk-chat-1',
      },
    ]);
    expect(page.hasMore).toBe(false);
  });

  it('omits a title when the journal holds no user prompt', () => {
    const page = readChatHistoryPage(
      CHATS_DIR,
      ['chat-1'],
      0,
      10,
      readerFor({ 'chat-1': [header('chat-1')] }),
    );
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.title).toBeUndefined();
  });

  it('falls back to the first prompt that named a host when the header names none', () => {
    const page = readChatHistoryPage(
      CHATS_DIR,
      ['chat-1'],
      0,
      10,
      readerFor({
        'chat-1': [
          header('chat-1'),
          userPrompt('chat-1', 'plain'),
          userPrompt('chat-1', 'on a host', { at: 3000, serverId: 'server-p' }),
        ],
      }),
    );
    expect(page.entries[0]?.serverId).toBe('server-p');
  });

  it("prefers the header's host over a later prompt's", () => {
    const page = readChatHistoryPage(
      CHATS_DIR,
      ['chat-1'],
      0,
      10,
      readerFor({
        'chat-1': [
          header('chat-1', { serverId: 'server-9' }),
          userPrompt('chat-1', 'later', { serverId: 'server-p' }),
        ],
      }),
    );
    expect(page.entries[0]?.serverId).toBe('server-9');
  });

  it('stays host-less when neither the header nor any prompt named one', () => {
    const page = readChatHistoryPage(
      CHATS_DIR,
      ['chat-1'],
      0,
      10,
      readerFor({
        'chat-1': [header('chat-1'), userPrompt('chat-1', 'plain')],
      }),
    );
    expect(page.entries[0]?.serverId).toBeUndefined();
    expect(page.entries[0]).not.toHaveProperty('serverId');
  });

  it('reads only the journals the page covers, and reports hasMore honestly', () => {
    const read: string[] = [];
    const reader = (_dir: string, chatId: string): ChatJournalReadOutcome => {
      read.push(chatId);
      return { ok: true, records: [header(chatId)] };
    };
    const page = readChatHistoryPage(CHATS_DIR, ['chat-1', 'chat-2', 'chat-3'], 0, 2, reader);
    expect(read).toEqual(['chat-1', 'chat-2']);
    expect(page.entries.map((entry) => entry.chatId)).toEqual(['chat-1', 'chat-2']);
    expect(page.hasMore).toBe(true);
  });

  it('skips an unreadable journal without losing the rest of the page', () => {
    const page = readChatHistoryPage(
      CHATS_DIR,
      ['gone', 'chat-2'],
      0,
      10,
      readerFor({ 'chat-2': [header('chat-2')] }),
    );
    expect(page.entries.map((entry) => entry.chatId)).toEqual(['chat-2']);
  });

  it('skips a journal with no header', () => {
    const page = readChatHistoryPage(
      CHATS_DIR,
      ['chat-1'],
      0,
      10,
      readerFor({ 'chat-1': [userPrompt('chat-1', 'orphan')] }),
    );
    expect(page.entries).toEqual([]);
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
