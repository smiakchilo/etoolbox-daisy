import { describe, expect, it } from 'vitest';
import { newChatId, newServerId, sdkSessionIdSchema } from '../../../../src/shared/contracts/ids';
import {
  CHAT_STATUSES,
  chatMetadataSchema,
  isChatServerRevisionStale,
} from '../../../../src/shared/contracts/chatMetadata';

const chatId = newChatId(() => 'chat-1');
const sdkSessionId = sdkSessionIdSchema.parse('sdk-session-1');
const serverId = newServerId(() => 'server-1');

function validChat() {
  return {
    chatId,
    sdkSessionId,
    serverId,
    startedAt: 1_700_000_000_000,
    title: 'Investigating a broken component',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    lastKnownServerRevision: 2,
    status: 'active' as const,
  };
}

describe('chatMetadataSchema', () => {
  it('round-trips a valid chat: parsing and re-serializing produces the same value', () => {
    const input = validChat();
    const parsed = chatMetadataSchema.parse(input);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(input);
  });

  it('accepts a chat with no title', () => {
    const withoutTitle: Record<string, unknown> = { ...validChat() };
    delete withoutTitle.title;
    expect(chatMetadataSchema.parse(withoutTitle)).toEqual(withoutTitle);
  });

  it.each(CHAT_STATUSES)('accepts the %s status', (status) => {
    expect(chatMetadataSchema.parse({ ...validChat(), status })).toMatchObject({ status });
  });

  it('rejects a status outside the closed union', () => {
    expect(() => chatMetadataSchema.parse({ ...validChat(), status: 'archived' })).toThrow();
  });

  describe('startedAt', () => {
    it('rejects a negative timestamp', () => {
      expect(() => chatMetadataSchema.parse({ ...validChat(), startedAt: -1 })).toThrow();
    });

    it('rejects a fractional timestamp', () => {
      expect(() => chatMetadataSchema.parse({ ...validChat(), startedAt: 1.5 })).toThrow();
    });

    it('accepts zero as a valid epoch timestamp', () => {
      expect(chatMetadataSchema.parse({ ...validChat(), startedAt: 0 })).toMatchObject({
        startedAt: 0,
      });
    });
  });

  describe('strictness', () => {
    it('rejects an unknown top-level key', () => {
      expect(() => chatMetadataSchema.parse({ ...validChat(), extraneous: 'nope' })).toThrow();
    });

    it('rejects a chat carrying a password field', () => {
      expect(() => chatMetadataSchema.parse({ ...validChat(), password: 'hunter2' })).toThrow();
    });
  });
});

describe('isChatServerRevisionStale', () => {
  it("is false when the chat's last known revision matches the current one", () => {
    const chat = chatMetadataSchema.parse({ ...validChat(), lastKnownServerRevision: 2 });
    expect(isChatServerRevisionStale(chat, 2)).toBe(false);
  });

  it("is true when the chat's last known revision is behind the current one", () => {
    const chat = chatMetadataSchema.parse({ ...validChat(), lastKnownServerRevision: 2 });
    expect(isChatServerRevisionStale(chat, 3)).toBe(true);
  });
});
