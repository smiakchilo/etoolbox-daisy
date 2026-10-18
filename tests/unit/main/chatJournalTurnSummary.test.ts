import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatJournal } from '../../../src/main/chatJournal';
import {
  chatJournalRecordSchema,
  type AgentEvent,
  type ChatId,
  type ChatJournalTurnSummaryRecord,
  type MessageId,
  type SessionId,
  type ToolCallId,
  type TurnId,
} from '../../../src/shared';
import { createScratchDirs } from '../../support/scratchDirs';

const scratch = createScratchDirs('main-unit-scratch', 'turnSummary-');
const createScratchRoot = scratch.create;

afterEach(() => {
  scratch.cleanup();
});

const CHAT = 'chat-1' as ChatId;
const TURN = 'turn-1' as TurnId;
const TURN_2 = 'turn-2' as TurnId;
const MESSAGE = 'message-1' as MessageId;
const CALL = 'call-1' as ToolCallId;
const SDK = 'sdk-1' as SessionId;

function readRecords(dir: string): { recordType: string }[] {
  return readFileSync(path.join(dir, `${CHAT}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { recordType: string });
}

function summaries(dir: string): ChatJournalTurnSummaryRecord[] {
  return readRecords(dir).filter(
    (record): record is ChatJournalTurnSummaryRecord => record.recordType === 'turn.summary',
  );
}

const state = (value: string, turnId: TurnId = TURN): AgentEvent =>
  ({
    type: 'session.state.changed',
    chatId: CHAT,
    sequence: 0,
    turnId,
    state: value,
  }) as AgentEvent;

const modelChanged = (): AgentEvent => ({
  type: 'model.changed',
  chatId: CHAT,
  sequence: 1,
  turnId: TURN,
  model: 'gpt-x',
  cause: 'session-open',
});

const usage = (fields: Record<string, unknown>, turnId: TurnId = TURN): AgentEvent => ({
  type: 'model.usage',
  chatId: CHAT,
  sequence: 2,
  turnId,
  ...fields,
});

const callFailed = (): AgentEvent => ({
  type: 'model.call.failed',
  chatId: CHAT,
  sequence: 3,
  turnId: TURN,
  statusCode: 503,
});

const delta: AgentEvent = {
  type: 'assistant.text.delta',
  chatId: CHAT,
  sequence: 4,
  turnId: TURN,
  messageId: MESSAGE,
  delta: 'hi',
};

const requested = (): AgentEvent => ({
  type: 'tool.call.requested',
  chatId: CHAT,
  sequence: 5,
  toolCallId: CALL,
  toolName: 'aem_query',
  arguments: {},
});

const toolResult = (): AgentEvent => ({
  type: 'tool.result',
  chatId: CHAT,
  sequence: 6,
  toolCallId: CALL,
  outcome: { ok: true, data: {} },
});

const errorEvent = (): AgentEvent =>
  ({
    type: 'error',
    chatId: CHAT,
    sequence: 7,
    turnId: TURN,
    error: { code: 'AGENT_UNAVAILABLE', message: 'x', requiredAction: 'none' },
  }) as unknown as AgentEvent;

function setUp(onTurnSummary?: (record: ChatJournalTurnSummaryRecord) => void) {
  const dir = createScratchRoot();
  let t = 1000;
  const journal = createChatJournal(dir, {
    now: () => t,
    ...(onTurnSummary !== undefined ? { onTurnSummary } : {}),
  });
  journal.openChat({ chatId: CHAT, sessionId: SDK });
  return {
    dir,
    journal,
    advance: (ms: number) => {
      t += ms;
    },
    prompt: (turnId: TurnId = TURN) =>
      journal.recordUserPrompt({ chatId: CHAT, turnId, prompt: 'private prompt' }),
  };
}

describe('createChatJournal - turn.summary', () => {
  it('summarises a completed turn with its timings, tools and usage', () => {
    const { dir, journal, advance, prompt } = setUp();
    prompt();
    advance(10);
    journal.recordEvent(state('sending'));
    journal.recordEvent(modelChanged());
    advance(500);
    journal.recordEvent(requested());
    advance(200);
    journal.recordEvent(toolResult());
    advance(100);
    journal.recordEvent(delta);
    journal.recordEvent(
      usage({
        model: 'gpt-x-2025',
        reasoningEffort: 'high',
        inputTokens: 100,
        outputTokens: 10,
        cost: 0.5,
        finishReason: 'stop',
      }),
    );
    journal.recordEvent(
      usage({ inputTokens: 50, outputTokens: 5, cacheReadTokens: 20, cost: 0.25 }),
    );
    journal.recordEvent(callFailed());
    advance(50);
    journal.recordEvent(state('idle'));

    const [summary, ...rest] = summaries(dir);
    expect(rest).toEqual([]);
    expect(summary).toMatchObject({
      chatId: CHAT,
      turnId: TURN,
      outcome: 'completed',
      durationMs: 860,
      firstActivityMs: 510,
      firstTextMs: 810,
      toolCallCount: 1,
      toolDurationMs: 200,
      modelCallCount: 2,
      modelCallFailureCount: 1,
      model: 'gpt-x-2025',
      reasoningEffort: 'high',
      inputTokens: 150,
      outputTokens: 15,
      cacheReadTokens: 20,
      cost: 0.75,
      finishReason: 'stop',
    });
    expect(summary).not.toHaveProperty('reasoningTokens');
    expect(chatJournalRecordSchema.safeParse(summary).success).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('private prompt');
  });

  it('does not count a state change or a model switch as first activity', () => {
    const { dir, journal, advance, prompt } = setUp();
    prompt();
    journal.recordEvent(state('sending'));
    journal.recordEvent(modelChanged());
    advance(40);
    journal.recordEvent(state('error'));
    expect(summaries(dir)[0]).not.toHaveProperty('firstActivityMs');
  });

  it('records an error turn once, with no second summary for the recovery idle', () => {
    const { dir, journal, advance, prompt } = setUp();
    prompt();
    journal.recordEvent(state('sending'));
    advance(30);
    journal.recordEvent(errorEvent());
    journal.recordEvent(state('idle'));

    const all = summaries(dir);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ outcome: 'error', durationMs: 30 });
  });

  it('marks a turn that went through cancelling as interrupted', () => {
    const { dir, journal, prompt } = setUp();
    prompt();
    journal.recordEvent(state('sending'));
    journal.recordEvent(state('cancelling'));
    journal.recordEvent(state('idle'));
    expect(summaries(dir)[0]).toMatchObject({ outcome: 'interrupted' });
  });

  it('closes a turn still running when the chat closes as interrupted', () => {
    const { dir, journal, advance, prompt } = setUp();
    prompt();
    journal.recordEvent(state('sending'));
    advance(70);
    journal.closeChat(CHAT);
    expect(summaries(dir)[0]).toMatchObject({ outcome: 'interrupted', durationMs: 70 });
  });

  it('closes the previous turn as interrupted when a new one starts without a terminal event', () => {
    const { dir, journal, prompt } = setUp();
    prompt();
    journal.recordEvent(state('sending'));
    prompt(TURN_2);
    journal.recordEvent(state('sending', TURN_2));
    journal.recordEvent(state('idle', TURN_2));

    const all = summaries(dir);
    expect(all.map((s) => [s.turnId, s.outcome])).toEqual([
      [TURN, 'interrupted'],
      [TURN_2, 'completed'],
    ]);
  });

  it('ignores usage that belongs to another turn', () => {
    const { dir, journal, prompt } = setUp();
    prompt();
    journal.recordEvent(state('sending'));
    journal.recordEvent(usage({ inputTokens: 999 }, TURN_2));
    journal.recordEvent(state('idle'));
    const summary = summaries(dir)[0];
    expect(summary).toMatchObject({ modelCallCount: 0 });
    expect(summary).not.toHaveProperty('inputTokens');
  });

  it('writes no summary for events that never had a prompt', () => {
    const { dir, journal } = setUp();
    journal.recordEvent(state('sending'));
    journal.recordEvent(state('idle'));
    expect(readRecords(dir).some((r) => r.recordType === 'turn.summary')).toBe(false);
  });

  it('passes each summary to onTurnSummary, and survives a throwing hook', () => {
    const seen: ChatJournalTurnSummaryRecord[] = [];
    const { dir, journal, prompt } = setUp((record) => {
      seen.push(record);
      throw new Error('hook failed');
    });
    prompt();
    journal.recordEvent(state('sending'));
    expect(() => journal.recordEvent(state('idle'))).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ turnId: TURN, outcome: 'completed' });
    expect(summaries(dir)).toHaveLength(1);
  });
});
