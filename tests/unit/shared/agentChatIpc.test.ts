import { describe, expect, it } from 'vitest';
import {
  agentChatHistoryEntrySchema,
  agentChatHistoryListResultSchema,
  agentChatListConversationsRequestSchema,
  parseAgentChatHistoryListResult,
} from '../../../src/shared';

/**
 * The History wire contract (`agent-chat:list-conversations`). The entry is
 * derived server-side and parsed again in the preload, so its exact shape -
 * which fields are optional, and that unknown keys are rejected - is what keeps
 * the renderer and main in step.
 */

const entry = {
  chatId: 'chat-1',
  title: 'Find the media library',
  startedAt: 1000,
  updatedAt: 5000,
  serverId: 'server-1',
  sdkSessionId: 'sdk-1',
};

describe('agentChatHistoryListResultSchema', () => {
  it('round-trips an ok result', () => {
    const result = {
      ok: true as const,
      entries: [entry, { chatId: 'chat-2', startedAt: 0, updatedAt: 0 }],
    };
    expect(parseAgentChatHistoryListResult(result)).toEqual(result);
  });

  it('round-trips an ok result that names the next page', () => {
    const result = {
      ok: true as const,
      entries: [entry],
      next: 'scan-token',
    };
    expect(parseAgentChatHistoryListResult(result)).toEqual(result);
  });

  it('round-trips an error result', () => {
    const result = {
      ok: false as const,
      error: { code: 'STORAGE_ERROR' as const, message: 'nope' },
    };
    expect(parseAgentChatHistoryListResult(result)).toEqual(result);
  });

  it('rejects an ok result with an unreadable entry', () => {
    expect(
      agentChatHistoryListResultSchema.safeParse({ ok: true, entries: [{ chatId: 'x' }] }).success,
    ).toBe(false);
  });
});

describe('agentChatListConversationsRequestSchema', () => {
  it('accepts a first request', () => {
    expect(agentChatListConversationsRequestSchema.parse({})).toEqual({});
  });

  it('rejects an absent request - the handler, not the schema, fills a first request', () => {
    expect(agentChatListConversationsRequestSchema.safeParse(undefined).success).toBe(false);
  });

  it('round-trips a continuation request', () => {
    const request = { next: 'scan-token' };
    expect(agentChatListConversationsRequestSchema.parse(request)).toEqual(request);
  });

  it('rejects an unknown key', () => {
    expect(agentChatListConversationsRequestSchema.safeParse({ next: 'x', limit: 5 }).success).toBe(
      false,
    );
  });
});

describe('agentChatHistoryEntrySchema', () => {
  it('accepts a fully-populated entry', () => {
    expect(agentChatHistoryEntrySchema.parse(entry)).toEqual(entry);
  });

  it('accepts an entry with no title, server or session', () => {
    expect(
      agentChatHistoryEntrySchema.parse({ chatId: 'chat-1', startedAt: 0, updatedAt: 0 }),
    ).toEqual({ chatId: 'chat-1', startedAt: 0, updatedAt: 0 });
  });

  it('rejects an unknown key', () => {
    expect(agentChatHistoryEntrySchema.safeParse({ ...entry, extra: 1 }).success).toBe(false);
  });

  it('rejects a missing timestamp', () => {
    expect(agentChatHistoryEntrySchema.safeParse({ chatId: 'chat-1', startedAt: 0 }).success).toBe(
      false,
    );
  });
});

describe('parseAgentChatHistoryListResult', () => {
  it('round-trips an ok result', () => {
    const result = {
      ok: true as const,
      entries: [entry, { chatId: 'chat-2', startedAt: 0, updatedAt: 0 }],
    };
    expect(parseAgentChatHistoryListResult(result)).toEqual(result);
  });

  it('round-trips an error result', () => {
    const result = {
      ok: false as const,
      error: { code: 'STORAGE_ERROR' as const, message: 'nope' },
    };
    expect(parseAgentChatHistoryListResult(result)).toEqual(result);
  });

  it('rejects an ok result with an unreadable entry', () => {
    expect(
      agentChatHistoryListResultSchema.safeParse({ ok: true, entries: [{ chatId: 'x' }] }).success,
    ).toBe(false);
  });
});
