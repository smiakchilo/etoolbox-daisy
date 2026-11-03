import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  JOURNAL_PARSE_CHUNK_LINES,
  readChatJournal,
  readChatJournalAsync,
  readChatSessionIds,
} from '../../../src/main/chatJournalReader';

/**
 * `chatJournalReader` is deliberately injectable (`readText`/`fileSize`), so
 * every branch - including the ones that only occur on a corrupt or missing
 * file - is exercised without touching the filesystem.
 */

const CHATS_DIR = 'C:/home/etoolbox-daisy/chats';

const header = {
  recordType: 'header',
  schemaVersion: 1,
  chatId: 'chat-1',
  sessionId: 'sdk-1',
  serverId: 'server-1',
  startedAt: 1,
};

const userPrompt = {
  recordType: 'user.prompt',
  at: 2,
  chatId: 'chat-1',
  turnId: 'turn-1',
  prompt: 'hello',
};

const assistantMessage = {
  recordType: 'agent.event',
  at: 3,
  event: {
    type: 'assistant.message.completed',
    chatId: 'chat-1',
    sequence: 0,
    turnId: 'turn-1',
    messageId: 'msg-1',
    content: 'hi there',
  },
};

const interruption = {
  recordType: 'interruption',
  at: 4,
  chatId: 'chat-1',
  reason: 'stopped',
};

const sessionOpened = {
  recordType: 'session.opened',
  at: 5,
  chatId: 'chat-1',
  sessionId: 'sdk-2',
};

function lines(...records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

describe('readChatJournal', () => {
  it('reads and validates every record, preserving order', () => {
    const outcome = readChatJournal(CHATS_DIR, 'chat-1', {
      fileSize: () => 100,
      readText: () => lines(header, userPrompt, assistantMessage, interruption),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.records.map((record) => record.recordType)).toEqual([
      'header',
      'user.prompt',
      'agent.event',
      'interruption',
    ]);
  });

  it('skips a torn or hand-edited line rather than failing the whole read', () => {
    const text = `${JSON.stringify(header)}\n{ this is not json\n${JSON.stringify(userPrompt)}\n`;
    const outcome = readChatJournal(CHATS_DIR, 'chat-1', {
      fileSize: () => 100,
      readText: () => text,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.records.map((record) => record.recordType)).toEqual(['header', 'user.prompt']);
  });

  it('ignores blank lines', () => {
    const outcome = readChatJournal(CHATS_DIR, 'chat-1', {
      fileSize: () => 100,
      readText: () => `${JSON.stringify(header)}\n\n\n`,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.records).toHaveLength(1);
  });

  it('reports not_found when the file does not exist', () => {
    const outcome = readChatJournal(CHATS_DIR, 'chat-1', {
      fileSize: () => {
        throw new Error('ENOENT');
      },
      readText: () => '',
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
  });

  it('reports unreadable when the file cannot be read', () => {
    const outcome = readChatJournal(CHATS_DIR, 'chat-1', {
      fileSize: () => 100,
      readText: () => {
        throw new Error('EACCES');
      },
    });
    expect(outcome).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('refuses an oversized file instead of parsing it', () => {
    const readText = vi.fn(() => lines(header));
    const outcome = readChatJournal(CHATS_DIR, 'chat-1', {
      maxBytes: 10,
      fileSize: () => 11,
      readText,
    });
    expect(outcome).toEqual({ ok: false, reason: 'too_large' });
    expect(readText).not.toHaveBeenCalled();
  });

  it.each(['', '.', '..', 'a/b', 'a\\b'])('refuses the unsafe id %j', (chatId) => {
    const readText = vi.fn(() => '');
    const outcome = readChatJournal(CHATS_DIR, chatId, {
      fileSize: () => 1,
      readText,
    });
    expect(outcome).toEqual({ ok: false, reason: 'invalid_chat_id' });
    expect(readText).not.toHaveBeenCalled();
  });

  it('reads the file named after the chat id', () => {
    const readText = vi.fn(() => lines(header));
    readChatJournal(CHATS_DIR, 'chat-1', { fileSize: () => 1, readText });
    expect(readText).toHaveBeenCalledWith(path.join(CHATS_DIR, 'chat-1.jsonl'));
  });
});

describe('readChatJournalAsync', () => {
  it('reads and validates every record, preserving order', async () => {
    const outcome = await readChatJournalAsync(CHATS_DIR, 'chat-1', {
      fileSize: () => Promise.resolve(100),
      readText: () => Promise.resolve(lines(header, userPrompt, assistantMessage, interruption)),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.records.map((record) => record.recordType)).toEqual([
      'header',
      'user.prompt',
      'agent.event',
      'interruption',
    ]);
  });

  it('skips a torn or hand-edited line rather than failing the whole read', async () => {
    const text = `${JSON.stringify(header)}\n{ this is not json\n${JSON.stringify(userPrompt)}\n`;
    const outcome = await readChatJournalAsync(CHATS_DIR, 'chat-1', {
      fileSize: () => Promise.resolve(100),
      readText: () => Promise.resolve(text),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.records.map((record) => record.recordType)).toEqual(['header', 'user.prompt']);
  });

  it('reports not_found, unreadable and too_large like the synchronous read', async () => {
    await expect(
      readChatJournalAsync(CHATS_DIR, 'chat-1', {
        fileSize: () => Promise.reject(new Error('ENOENT')),
        readText: () => Promise.resolve(''),
      }),
    ).resolves.toEqual({ ok: false, reason: 'not_found' });

    await expect(
      readChatJournalAsync(CHATS_DIR, 'chat-1', {
        fileSize: () => Promise.resolve(100),
        readText: () => Promise.reject(new Error('EACCES')),
      }),
    ).resolves.toEqual({ ok: false, reason: 'unreadable' });

    const readText = vi.fn(() => Promise.resolve(lines(header)));
    await expect(
      readChatJournalAsync(CHATS_DIR, 'chat-1', {
        maxBytes: 10,
        fileSize: () => Promise.resolve(11),
        readText,
      }),
    ).resolves.toEqual({ ok: false, reason: 'too_large' });
    expect(readText).not.toHaveBeenCalled();
  });

  it('refuses an unsafe id without touching the file', async () => {
    const readText = vi.fn(() => Promise.resolve(''));
    await expect(
      readChatJournalAsync(CHATS_DIR, '../escape', {
        fileSize: () => Promise.resolve(1),
        readText,
      }),
    ).resolves.toEqual({ ok: false, reason: 'invalid_chat_id' });
    expect(readText).not.toHaveBeenCalled();
  });

  it('yields between chunks without dropping a record', async () => {
    const count = JOURNAL_PARSE_CHUNK_LINES * 2 + 7;
    const text = Array.from({ length: count }, (_, index) =>
      JSON.stringify({ ...userPrompt, at: index, turnId: `turn-${index}` }),
    ).join('\n');

    const outcome = await readChatJournalAsync(CHATS_DIR, 'chat-1', {
      fileSize: () => Promise.resolve(text.length),
      readText: () => Promise.resolve(text),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.records).toHaveLength(count);
    expect(outcome.records.at(-1)).toMatchObject({ recordType: 'user.prompt' });
  });
});

describe('readChatSessionIds', () => {
  it('returns the header session first, then one id per session.opened record', () => {
    const ids = readChatSessionIds(CHATS_DIR, 'chat-1', {
      fileSize: () => 100,
      readText: () =>
        lines(header, userPrompt, sessionOpened, {
          ...sessionOpened,
          sessionId: 'sdk-3',
        }),
    });
    expect(ids).toEqual(['sdk-1', 'sdk-2', 'sdk-3']);
  });

  it('reads an old journal with a header only as a single id', () => {
    const ids = readChatSessionIds(CHATS_DIR, 'chat-1', {
      fileSize: () => 100,
      readText: () => lines(header, userPrompt),
    });
    expect(ids).toEqual(['sdk-1']);
  });

  it('returns no ids for an unreadable, oversized or missing file', () => {
    expect(
      readChatSessionIds(CHATS_DIR, 'chat-1', {
        fileSize: () => {
          throw new Error('ENOENT');
        },
        readText: () => '',
      }),
    ).toEqual([]);
    expect(
      readChatSessionIds(CHATS_DIR, 'chat-1', {
        maxBytes: 10,
        fileSize: () => 11,
        readText: () => lines(header),
      }),
    ).toEqual([]);
    expect(readChatSessionIds(CHATS_DIR, '../escape', { fileSize: () => 1 })).toEqual([]);
  });
});
