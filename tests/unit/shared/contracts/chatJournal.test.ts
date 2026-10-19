import { describe, expect, it } from 'vitest';
import {
  CHAT_JOURNAL_SCHEMA_VERSION,
  chatJournalRecordSchema,
  parseChatJournalRecord,
} from '../../../../src/shared';

const CHAT_ID = 'chat-1';
const SDK_SESSION_ID = 'sdk-session-1';
const TURN_ID = 'turn-1';
const MESSAGE_ID = 'message-1';

function header(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recordType: 'header',
    schemaVersion: CHAT_JOURNAL_SCHEMA_VERSION,
    chatId: CHAT_ID,
    sessionId: SDK_SESSION_ID,
    startedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('chatJournalRecordSchema - header', () => {
  it('accepts a minimal header and keeps serverId optional', () => {
    const parsed = parseChatJournalRecord(header());
    expect(parsed).toEqual({
      recordType: 'header',
      schemaVersion: 1,
      chatId: CHAT_ID,
      sessionId: SDK_SESSION_ID,
      startedAt: 1_700_000_000_000,
    });
  });

  it('accepts an explicit serverId', () => {
    const parsed = parseChatJournalRecord(header({ serverId: 'server-a' }));
    expect(parsed).toMatchObject({ serverId: 'server-a' });
  });

  it('rejects a missing sessionId', () => {
    const candidate = header();
    delete candidate['sessionId'];
    expect(chatJournalRecordSchema.safeParse(candidate).success).toBe(false);
  });

  it('rejects an unknown schemaVersion', () => {
    expect(chatJournalRecordSchema.safeParse(header({ schemaVersion: 2 })).success).toBe(false);
  });

  it('rejects an unrecognised extra key (strict)', () => {
    expect(chatJournalRecordSchema.safeParse(header({ extra: true })).success).toBe(false);
  });
});

describe('chatJournalRecordSchema - session.opened', () => {
  it('accepts a later session the chat was opened with', () => {
    expect(
      parseChatJournalRecord({
        recordType: 'session.opened',
        at: 1_700_000_000_500,
        chatId: CHAT_ID,
        sessionId: 'sdk-session-2',
      }),
    ).toEqual({
      recordType: 'session.opened',
      at: 1_700_000_000_500,
      chatId: CHAT_ID,
      sessionId: 'sdk-session-2',
    });
  });

  it('rejects a missing sessionId', () => {
    expect(
      chatJournalRecordSchema.safeParse({
        recordType: 'session.opened',
        at: 1,
        chatId: CHAT_ID,
      }).success,
    ).toBe(false);
  });

  it('rejects an unrecognised extra key (strict)', () => {
    expect(
      chatJournalRecordSchema.safeParse({
        recordType: 'session.opened',
        at: 1,
        chatId: CHAT_ID,
        sessionId: 'sdk-session-2',
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe('chatJournalRecordSchema - other record kinds', () => {
  it('accepts a user.prompt record', () => {
    expect(
      chatJournalRecordSchema.safeParse({
        recordType: 'user.prompt',
        at: 5,
        chatId: CHAT_ID,
        turnId: TURN_ID,
        prompt: 'Show me /content/page',
      }).success,
    ).toBe(true);
  });

  it('accepts an optional pageContext on a user.prompt, and still reads one without it', () => {
    const prompt = {
      recordType: 'user.prompt',
      at: 5,
      chatId: CHAT_ID,
      turnId: TURN_ID,
      prompt: 'Find X',
    };
    expect(
      chatJournalRecordSchema.safeParse({
        ...prompt,
        pageContext: 'Host origin: https://a.example',
      }).success,
    ).toBe(true);
    expect(chatJournalRecordSchema.safeParse(prompt).success).toBe(true);
  });

  it('accepts an optional serverId on a user.prompt, and still reads one without it', () => {
    const prompt = {
      recordType: 'user.prompt',
      at: 5,
      chatId: CHAT_ID,
      turnId: TURN_ID,
      prompt: 'Find X',
    };
    expect(chatJournalRecordSchema.safeParse({ ...prompt, serverId: 'server-a' }).success).toBe(
      true,
    );
    expect(chatJournalRecordSchema.safeParse(prompt).success).toBe(true);
  });

  it('accepts a reflection origin on a user.prompt and rejects any other origin', () => {
    const prompt = {
      recordType: 'user.prompt',
      at: 5,
      chatId: CHAT_ID,
      turnId: TURN_ID,
      prompt: 'Reflect',
    };
    expect(chatJournalRecordSchema.safeParse({ ...prompt, origin: 'reflection' }).success).toBe(
      true,
    );
    expect(chatJournalRecordSchema.safeParse({ ...prompt, origin: 'user' }).success).toBe(false);
  });

  it('rejects an empty serverId on a user.prompt', () => {
    expect(
      chatJournalRecordSchema.safeParse({
        recordType: 'user.prompt',
        at: 5,
        chatId: CHAT_ID,
        turnId: TURN_ID,
        prompt: 'Find X',
        serverId: '',
      }).success,
    ).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['over its bound', 'x'.repeat(8_001)],
  ])('rejects a pageContext that is %s', (_name, pageContext) => {
    expect(
      chatJournalRecordSchema.safeParse({
        recordType: 'user.prompt',
        at: 5,
        chatId: CHAT_ID,
        turnId: TURN_ID,
        prompt: 'Find X',
        pageContext,
      }).success,
    ).toBe(false);
  });

  it('keeps user.prompt strict: another unknown key is still refused', () => {
    expect(
      chatJournalRecordSchema.safeParse({
        recordType: 'user.prompt',
        at: 5,
        chatId: CHAT_ID,
        turnId: TURN_ID,
        prompt: 'Find X',
        pageContxt: 'typo',
      }).success,
    ).toBe(false);
  });
  it('rejects an empty user.prompt', () => {
    expect(
      chatJournalRecordSchema.safeParse({
        recordType: 'user.prompt',
        at: 5,
        chatId: CHAT_ID,
        turnId: TURN_ID,
        prompt: '',
      }).success,
    ).toBe(false);
  });

  it('accepts an agent.event wrapping a normalized event', () => {
    expect(
      chatJournalRecordSchema.safeParse({
        recordType: 'agent.event',
        at: 5,
        event: {
          type: 'session.state.changed',
          chatId: CHAT_ID,
          sequence: 0,
          state: 'sending',
          turnId: TURN_ID,
        },
      }).success,
    ).toBe(true);
  });

  it('rejects an agent.event whose payload is not a valid AgentEvent', () => {
    expect(
      chatJournalRecordSchema.safeParse({
        recordType: 'agent.event',
        at: 5,
        event: { type: 'assistant.text.delta', chatId: CHAT_ID, sequence: 1, delta: '' },
      }).success,
    ).toBe(false);
  });

  it('accepts a partial message record', () => {
    expect(
      chatJournalRecordSchema.safeParse({
        recordType: 'assistant.message.partial',
        at: 5,
        chatId: CHAT_ID,
        turnId: TURN_ID,
        messageId: MESSAGE_ID,
        content: 'half a thought',
      }).success,
    ).toBe(true);
  });

  it('accepts an abandoned tool-call record, with turnId optional', () => {
    expect(
      chatJournalRecordSchema.safeParse({
        recordType: 'tool.call.abandoned',
        at: 5,
        chatId: CHAT_ID,
        toolCallId: 'call-1',
        toolName: 'aem_query',
      }).success,
    ).toBe(true);
    expect(
      chatJournalRecordSchema.safeParse({
        recordType: 'tool.call.abandoned',
        at: 5,
        chatId: CHAT_ID,
        toolCallId: 'call-1',
        toolName: 'aem_query',
        turnId: TURN_ID,
      }).success,
    ).toBe(true);
  });

  it('rejects an abandoned tool-call record with an empty toolName', () => {
    expect(
      chatJournalRecordSchema.safeParse({
        recordType: 'tool.call.abandoned',
        at: 5,
        chatId: CHAT_ID,
        toolCallId: 'call-1',
        toolName: '',
      }).success,
    ).toBe(false);
  });

  it('accepts a chat.closed record', () => {
    expect(
      chatJournalRecordSchema.safeParse({
        recordType: 'chat.closed',
        at: 5,
        chatId: CHAT_ID,
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown recordType', () => {
    expect(chatJournalRecordSchema.safeParse({ recordType: 'something.else', at: 5 }).success).toBe(
      false,
    );
  });
});

describe('chatJournalRecordSchema - turn.summary', () => {
  const summary = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    recordType: 'turn.summary',
    at: 1_700_000_000_000,
    chatId: CHAT_ID,
    turnId: TURN_ID,
    outcome: 'completed',
    durationMs: 1200,
    toolCallCount: 2,
    toolDurationMs: 300,
    modelCallCount: 1,
    modelCallFailureCount: 0,
    ...overrides,
  });

  it('accepts a minimal summary and one carrying every optional field', () => {
    expect(parseChatJournalRecord(summary())).toMatchObject({ recordType: 'turn.summary' });
    expect(
      chatJournalRecordSchema.safeParse(
        summary({
          firstActivityMs: 10,
          firstTextMs: 20,
          model: 'gpt-x',
          reasoningEffort: 'high',
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          reasoningTokens: 4,
          cost: 0.5,
          finishReason: 'stop',
        }),
      ).success,
    ).toBe(true);
  });

  it.each(['completed', 'error', 'interrupted'])('accepts the %s outcome', (outcome) => {
    expect(chatJournalRecordSchema.safeParse(summary({ outcome })).success).toBe(true);
  });

  it('rejects an unknown outcome, a negative duration and an extra key', () => {
    expect(chatJournalRecordSchema.safeParse(summary({ outcome: 'weird' })).success).toBe(false);
    expect(chatJournalRecordSchema.safeParse(summary({ durationMs: -1 })).success).toBe(false);
    expect(chatJournalRecordSchema.safeParse(summary({ prompt: 'leak' })).success).toBe(false);
  });
});
