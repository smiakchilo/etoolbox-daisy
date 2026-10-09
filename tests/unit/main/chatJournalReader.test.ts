import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readChatJournal } from '../../../src/main/chatJournalReader';

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
  sdkSessionId: 'sdk-1',
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
