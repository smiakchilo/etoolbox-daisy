import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatJournal } from '../../../src/main/chatJournal';
import type {
  AgentEvent,
  ChatId,
  MessageId,
  ReasoningId,
  SdkSessionId,
  ServerId,
  ToolCallId,
  TurnId,
  UserInputRequestId,
} from '../../../src/shared';
import { createScratchDirs } from '../../support/scratchDirs';

/**
 * Scratch directories live under the project's own `test-results/` (already
 * gitignored), matching `logger.test.ts` and `windowState.test.ts`.
 */
const scratch = createScratchDirs('main-unit-scratch', 'chatJournal-');
const createScratchRoot = scratch.create;

afterEach(() => {
  scratch.cleanup();
});

const CHAT_ID = 'chat-1' as ChatId;
const TURN_ID = 'turn-1' as TurnId;
const SECOND_TURN_ID = 'turn-2' as TurnId;
const MESSAGE_ID = 'message-1' as MessageId;

function readRecords(dir: string, chatId = CHAT_ID): unknown[] {
  try {
    return readFileSync(path.join(dir, `${chatId}.jsonl`), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
}

/** A monotonic clock so `at`/`startedAt` are deterministic. */
function counterClock(start = 1000): () => number {
  let value = start;
  return () => value++;
}

const SDK_SESSION_ID = 'sdk-session-1' as SdkSessionId;
const SERVER_ID = 'server-a' as ServerId;

const stateChanged = (state: string, withTurn = true, turnId: TurnId = TURN_ID): AgentEvent =>
  ({
    type: 'session.state.changed',
    chatId: CHAT_ID,
    sequence: 0,
    ...(withTurn ? { turnId } : {}),
    state,
  }) as AgentEvent;

const messageStarted = (): AgentEvent => ({
  type: 'assistant.message.started',
  chatId: CHAT_ID,
  sequence: 1,
  turnId: TURN_ID,
  messageId: MESSAGE_ID,
});

const delta = (text: string, sequence = 2): AgentEvent => ({
  type: 'assistant.text.delta',
  chatId: CHAT_ID,
  sequence,
  turnId: TURN_ID,
  messageId: MESSAGE_ID,
  delta: text,
});

const messageCompleted = (content: string): AgentEvent => ({
  type: 'assistant.message.completed',
  chatId: CHAT_ID,
  sequence: 3,
  turnId: TURN_ID,
  messageId: MESSAGE_ID,
  content,
});

const TOOL_CALL_ID = 'call-1' as ToolCallId;
const REASONING_ID = 'reason-1' as ReasoningId;

const reasoningDelta = (text: string, sequence = 2): AgentEvent => ({
  type: 'assistant.reasoning.delta',
  chatId: CHAT_ID,
  sequence,
  turnId: TURN_ID,
  reasoningId: REASONING_ID,
  delta: text,
});

const reasoningCompleted = (content: string, sequence = 3): AgentEvent => ({
  type: 'assistant.reasoning.completed',
  chatId: CHAT_ID,
  sequence,
  turnId: TURN_ID,
  reasoningId: REASONING_ID,
  content,
});

const toolRequested = (): AgentEvent => ({
  type: 'tool.call.requested',
  chatId: CHAT_ID,
  sequence: 4,
  toolCallId: TOOL_CALL_ID,
  toolName: 'aem_query',
  arguments: { path: '/content' },
});

const toolApproved = (): AgentEvent => ({
  type: 'tool.call.approved',
  chatId: CHAT_ID,
  sequence: 5,
  toolCallId: TOOL_CALL_ID,
});

const toolRejected = (): AgentEvent => ({
  type: 'tool.call.rejected',
  chatId: CHAT_ID,
  sequence: 5,
  toolCallId: TOOL_CALL_ID,
  reason: 'denied',
});

const toolResult = (): AgentEvent => ({
  type: 'tool.result',
  chatId: CHAT_ID,
  sequence: 6,
  toolCallId: TOOL_CALL_ID,
  outcome: { ok: true, data: { found: true } },
});

describe('createChatJournal - header', () => {
  it('writes no journal file for a chat that is opened and never used', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });

    journal.openChat({
      chatId: CHAT_ID,
      sdkSessionId: SDK_SESSION_ID,
      serverId: SERVER_ID,
    });

    expect(readRecords(dir)).toEqual([]);
    expect(journal.getHealth()).toEqual({
      writeFailureCount: 0,
      droppedRecordCount: 0,
      lastFailureCode: null,
    });
  });

  it('writes the header immediately before the first record, with the chat id, session id, server id and startedAt', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });

    journal.openChat({
      chatId: CHAT_ID,
      sdkSessionId: SDK_SESSION_ID,
      serverId: SERVER_ID,
    });
    journal.recordEvent(stateChanged('sending'));

    const records = readRecords(dir);
    expect(records[0]).toEqual({
      recordType: 'header',
      schemaVersion: 1,
      chatId: CHAT_ID,
      sdkSessionId: 'sdk-session-1',
      serverId: 'server-a',
      startedAt: 1000,
    });
    expect(records).toHaveLength(2);
    expect(journal.getHealth()).toEqual({
      writeFailureCount: 0,
      droppedRecordCount: 0,
      lastFailureCode: null,
    });
  });

  it('does not write a second header when the same chat is opened again', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordEvent(stateChanged('sending'));
    const headers = readRecords(dir).filter(
      (record) => (record as { recordType: string }).recordType === 'header',
    );
    expect(headers).toHaveLength(1);
  });

  it('appends without a header when the file already has content (a resumed chat)', () => {
    const dir = createScratchRoot();
    writeFileSync(
      path.join(dir, `${CHAT_ID}.jsonl`),
      JSON.stringify({
        recordType: 'header',
        schemaVersion: 1,
        chatId: CHAT_ID,
        sdkSessionId: SDK_SESSION_ID,
        startedAt: 1,
      }) + '\n',
      'utf8',
    );
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordEvent(stateChanged('sending'));
    const records = readRecords(dir);
    expect(records[0]).toMatchObject({ recordType: 'header', sdkSessionId: 'sdk-session-1' });
    expect(
      records.filter((record) => (record as { recordType: string }).recordType === 'header'),
    ).toHaveLength(1);
    expect(records).toHaveLength(2);
  });

  it('refuses an unsafe chat id and records the failure instead of throwing', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: '../escape' as ChatId, sdkSessionId: SDK_SESSION_ID });
    expect(journal.getHealth().lastFailureCode).toBe('UNSAFE_CHAT_ID');
  });
});

describe("createChatJournal - the chat's host", () => {
  it('fills a deferred header with the host the chat was first used on', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    // The startup chat: opened before any page/host was restored.
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordUserPrompt({
      chatId: CHAT_ID,
      turnId: TURN_ID,
      prompt: 'where is the media library?',
      serverId: SERVER_ID,
    });
    journal.recordEvent(stateChanged('sending'));

    const records = readRecords(dir);
    expect(records[0]).toMatchObject({ recordType: 'header', serverId: 'server-a' });
    expect(records[1]).toMatchObject({ recordType: 'user.prompt', serverId: 'server-a' });
  });

  it("keeps the open-time host over a later prompt's", () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID, serverId: SERVER_ID });
    journal.recordUserPrompt({
      chatId: CHAT_ID,
      turnId: TURN_ID,
      prompt: 'hi',
      serverId: 'server-b' as ServerId,
    });
    journal.recordEvent(stateChanged('sending'));

    const records = readRecords(dir);
    expect(records[0]).toMatchObject({ recordType: 'header', serverId: 'server-a' });
    expect(records[1]).toMatchObject({ recordType: 'user.prompt', serverId: 'server-b' });
  });

  it('leaves the header host-less when no prompt named one, and records a later host on its prompt', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    // First send with no host: the header is flushed host-less.
    journal.recordUserPrompt({ chatId: CHAT_ID, turnId: TURN_ID, prompt: 'plain' });
    journal.recordEvent(stateChanged('sending'));
    journal.recordEvent(stateChanged('idle'));
    // A later send on a host: the append-only header cannot gain it, so the host
    // rides on the prompt record for History to find.
    journal.recordUserPrompt({
      chatId: CHAT_ID,
      turnId: SECOND_TURN_ID,
      prompt: 'on a host',
      serverId: SERVER_ID,
    });
    journal.recordEvent(stateChanged('sending', true, SECOND_TURN_ID));

    const records = readRecords(dir);
    expect(records[0]).toMatchObject({ recordType: 'header' });
    expect(records[0]).not.toHaveProperty('serverId');
    const prompts = records.filter(
      (record) => (record as { recordType: string }).recordType === 'user.prompt',
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toHaveProperty('serverId');
    expect(prompts[1]).toMatchObject({ serverId: 'server-a' });
  });
});

describe('createChatJournal - later sessions (session.opened)', () => {
  const SECOND_SESSION = 'sdk-session-2' as SdkSessionId;

  function recordTypes(dir: string): string[] {
    return readRecords(dir).map((record) => (record as { recordType: string }).recordType);
  }

  it('records a session.opened when an open chat is recycled to a new session', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordEvent(stateChanged('sending'));
    // A runtime recycle re-opens the same chat under a new session.
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SECOND_SESSION });
    journal.recordEvent(stateChanged('idle'));

    const records = readRecords(dir);
    expect(
      records.filter((record) => (record as { recordType: string }).recordType === 'header'),
    ).toHaveLength(1);
    expect(records[0]).toMatchObject({ recordType: 'header', sdkSessionId: 'sdk-session-1' });
    const opened = records.filter(
      (record) => (record as { recordType: string }).recordType === 'session.opened',
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      recordType: 'session.opened',
      sdkSessionId: 'sdk-session-2',
    });
  });

  it('does not record a second session.opened for the same session', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordEvent(stateChanged('sending'));
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordEvent(stateChanged('idle'));
    expect(recordTypes(dir)).toEqual(['header', 'agent.event', 'agent.event']);
  });

  it("replaces the deferred header's session when a chat is recycled before it is used", () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    // Opened but never used: the header is still pending and no file exists.
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SECOND_SESSION });
    journal.recordEvent(stateChanged('sending'));

    const records = readRecords(dir);
    expect(records[0]).toMatchObject({ recordType: 'header', sdkSessionId: 'sdk-session-2' });
    expect(recordTypes(dir)).toEqual(['header', 'agent.event']);
  });

  it('records a session.opened when an existing journal is opened under a new session', () => {
    const dir = createScratchRoot();
    writeFileSync(
      path.join(dir, `${CHAT_ID}.jsonl`),
      JSON.stringify({
        recordType: 'header',
        schemaVersion: 1,
        chatId: CHAT_ID,
        sdkSessionId: SDK_SESSION_ID,
        startedAt: 1,
      }) + '\n',
      'utf8',
    );
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SECOND_SESSION });

    expect(recordTypes(dir)).toEqual(['header', 'session.opened']);
    expect(readRecords(dir)[1]).toMatchObject({
      recordType: 'session.opened',
      sdkSessionId: 'sdk-session-2',
    });
  });

  it('appends nothing when an existing journal is reopened under its recorded session', () => {
    const dir = createScratchRoot();
    writeFileSync(
      path.join(dir, `${CHAT_ID}.jsonl`),
      JSON.stringify({
        recordType: 'header',
        schemaVersion: 1,
        chatId: CHAT_ID,
        sdkSessionId: SDK_SESSION_ID,
        startedAt: 1,
      }) + '\n',
      'utf8',
    );
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    expect(readRecords(dir)).toHaveLength(1);
  });
});

describe('createChatJournal - events and prompts', () => {
  it('writes structural events and drops the prompt for a chat that was never opened', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.recordEvent(stateChanged('sending'));
    journal.recordUserPrompt({ chatId: CHAT_ID, turnId: TURN_ID, prompt: 'hi' });
    expect(readRecords(dir)).toEqual([]);
    expect(journal.getHealth().droppedRecordCount).toBe(2);
  });

  it('writes the staged prompt immediately before the first event carrying its turnId', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordUserPrompt({ chatId: CHAT_ID, turnId: TURN_ID, prompt: 'Show me the page' });
    journal.recordEvent(stateChanged('sending'));

    const records = readRecords(dir);
    expect(records[0]).toMatchObject({ recordType: 'header' });
    expect(records[1]).toMatchObject({
      recordType: 'user.prompt',
      chatId: CHAT_ID,
      turnId: TURN_ID,
      prompt: 'Show me the page',
    });
    expect(records[2]).toMatchObject({
      recordType: 'agent.event',
      event: { type: 'session.state.changed', state: 'sending' },
    });
  });

  it('writes the current-page block the model read on the prompt record, and only when there was one', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordUserPrompt({
      chatId: CHAT_ID,
      turnId: TURN_ID,
      prompt: 'Find X',
      pageContext: 'Host origin: https://a.example\nContent path: /content/a',
    });
    journal.recordEvent(stateChanged('sending'));

    expect(readRecords(dir)[1]).toEqual({
      recordType: 'user.prompt',
      at: expect.any(Number) as unknown,
      chatId: CHAT_ID,
      turnId: TURN_ID,
      prompt: 'Find X',
      pageContext: 'Host origin: https://a.example\nContent path: /content/a',
    });
  });

  it('leaves pageContext out of the prompt record when the turn had no block', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordUserPrompt({ chatId: CHAT_ID, turnId: TURN_ID, prompt: 'Find X' });
    journal.recordEvent(stateChanged('sending'));

    expect(readRecords(dir)[1]).not.toHaveProperty('pageContext');
  });
  it('never writes a discarded prompt whose turn never started', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordUserPrompt({ chatId: CHAT_ID, turnId: TURN_ID, prompt: 'never sent' });
    journal.discardUserPrompt(CHAT_ID, TURN_ID);
    journal.recordEvent(stateChanged('sending'));
    expect(
      readRecords(dir).some((r) => (r as { recordType: string }).recordType === 'user.prompt'),
    ).toBe(false);
  });

  it('writes nothing on closeChat for a chat that was never used', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.closeChat(CHAT_ID);
    expect(readRecords(dir)).toEqual([]);
  });

  it('folds deltas and writes no per-delta line', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordEvent(messageStarted());
    journal.recordEvent(delta('Hello '));
    journal.recordEvent(delta('world'));

    const records = readRecords(dir);
    const deltaLines = records.filter(
      (r) => (r as { event?: { type?: string } }).event?.type === 'assistant.text.delta',
    );
    expect(deltaLines).toHaveLength(0);
    expect(records).toHaveLength(2); // header + message.started
  });

  it('never writes reasoning to the journal, and never lets it flush a pending prompt', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordUserPrompt({ chatId: CHAT_ID, turnId: TURN_ID, prompt: 'hi' });
    journal.recordEvent(reasoningDelta('thinking'));
    journal.recordEvent(reasoningCompleted('thinking'));

    const records = readRecords(dir);
    // Reasoning is transient by contract: not one line of it is durable.
    expect(
      records.some((r) =>
        (r as { event?: { type?: string } }).event?.type?.startsWith('assistant.reasoning'),
      ),
    ).toBe(false);
    // And a reasoning block alone must not flush the staged prompt.
    expect(records.some((r) => (r as { recordType: string }).recordType === 'user.prompt')).toBe(
      false,
    );
    // Nothing durable at all - not even a header, because the chat never wrote
    // a real record.
    expect(records).toHaveLength(0);
  });

  it('never writes a live-added question action to the journal, nor lets it flush a pending prompt', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordUserPrompt({ chatId: CHAT_ID, turnId: TURN_ID, prompt: 'hi' });
    journal.recordEvent({
      type: 'user.input.actions.added',
      chatId: CHAT_ID,
      sequence: 1,
      turnId: TURN_ID,
      requestId: 'input-1' as UserInputRequestId,
      actions: ['Load all'],
    });

    expect(readRecords(dir)).toHaveLength(0);
  });

  it('still flushes the staged prompt on the first non-reasoning event', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordUserPrompt({ chatId: CHAT_ID, turnId: TURN_ID, prompt: 'hi' });
    journal.recordEvent(reasoningDelta('thinking'));
    journal.recordEvent(messageStarted());

    const records = readRecords(dir);
    expect(records.some((r) => (r as { recordType: string }).recordType === 'user.prompt')).toBe(
      true,
    );
  });

  it('writes a partial message when the turn ends before completion', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordEvent(messageStarted());
    journal.recordEvent(delta('Hello ', 2));
    journal.recordEvent(delta('wor', 3));
    journal.recordEvent(stateChanged('cancelling'));
    journal.recordEvent(stateChanged('idle'));

    const partial = readRecords(dir).find(
      (r) => (r as { recordType: string }).recordType === 'assistant.message.partial',
    );
    expect(partial).toMatchObject({
      chatId: CHAT_ID,
      turnId: TURN_ID,
      messageId: MESSAGE_ID,
      content: 'Hello wor',
    });
  });

  it('writes no partial when the message completed', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordEvent(messageStarted());
    journal.recordEvent(delta('Hello'));
    journal.recordEvent(messageCompleted('Hello'));
    journal.recordEvent(stateChanged('idle'));

    const records = readRecords(dir);
    expect(
      records.some((r) => (r as { recordType: string }).recordType === 'assistant.message.partial'),
    ).toBe(false);
    expect(
      records.some(
        (r) => (r as { event?: { type?: string } }).event?.type === 'assistant.message.completed',
      ),
    ).toBe(true);
  });

  it('finalizes an unfinished message on closeChat and writes the closed marker last', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordEvent(messageStarted());
    journal.recordEvent(delta('partial'));
    journal.closeChat(CHAT_ID);

    const records = readRecords(dir);
    expect(records.at(-1)).toMatchObject({ recordType: 'chat.closed', chatId: CHAT_ID });
    expect(
      records.some((r) => (r as { recordType: string }).recordType === 'assistant.message.partial'),
    ).toBe(true);
  });

  it('ignores events for a chat after it was closed', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.closeChat(CHAT_ID);
    const before = readRecords(dir).length;
    journal.recordEvent(stateChanged('idle'));
    expect(readRecords(dir)).toHaveLength(before);
    expect(journal.getHealth().droppedRecordCount).toBe(1);
  });
});

describe('createChatJournal - abandoned tool calls', () => {
  it('records a tool call that never produced a result when the turn ends', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordEvent(stateChanged('sending'));
    journal.recordEvent(toolRequested());
    journal.recordEvent(toolApproved());
    journal.recordEvent(stateChanged('cancelling'));
    journal.recordEvent(stateChanged('idle'));

    const abandoned = readRecords(dir).find(
      (r) => (r as { recordType: string }).recordType === 'tool.call.abandoned',
    );
    expect(abandoned).toMatchObject({
      chatId: CHAT_ID,
      toolCallId: TOOL_CALL_ID,
      toolName: 'aem_query',
      turnId: TURN_ID,
    });
  });

  it('does not record an abandoned call once a result arrived', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordEvent(stateChanged('sending'));
    journal.recordEvent(toolRequested());
    journal.recordEvent(toolApproved());
    journal.recordEvent(toolResult());
    journal.recordEvent(stateChanged('idle'));

    expect(
      readRecords(dir).some(
        (r) => (r as { recordType: string }).recordType === 'tool.call.abandoned',
      ),
    ).toBe(false);
  });

  it('does not record an abandoned call for a rejected call (already terminal)', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordEvent(stateChanged('sending'));
    journal.recordEvent(toolRequested());
    journal.recordEvent(toolRejected());
    journal.recordEvent(stateChanged('idle'));

    expect(
      readRecords(dir).some(
        (r) => (r as { recordType: string }).recordType === 'tool.call.abandoned',
      ),
    ).toBe(false);
  });

  it('finalizes outstanding calls on closeChat, before the closed marker', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordEvent(stateChanged('sending'));
    journal.recordEvent(toolRequested());
    journal.closeChat(CHAT_ID);

    const records = readRecords(dir);
    expect(records.at(-2)).toMatchObject({ recordType: 'tool.call.abandoned' });
    expect(records.at(-1)).toMatchObject({ recordType: 'chat.closed' });
  });
});

describe('createChatJournal - interruption notices', () => {
  it('writes an interruption record carrying the reason, after the header', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.openChat({ chatId: CHAT_ID, sdkSessionId: SDK_SESSION_ID });
    journal.recordEvent(stateChanged('sending'));
    journal.recordEvent(stateChanged('cancelling'));
    journal.recordEvent(stateChanged('idle'));
    journal.recordInterruption({ chatId: CHAT_ID, reason: 'stopped' });

    const records = readRecords(dir);
    expect(records.at(-1)).toMatchObject({
      recordType: 'interruption',
      chatId: CHAT_ID,
      reason: 'stopped',
    });
  });

  it('drops an interruption for a chat with no open journal', () => {
    const dir = createScratchRoot();
    const journal = createChatJournal(dir, { now: counterClock() });
    journal.recordInterruption({ chatId: CHAT_ID, reason: 'navigation' });

    expect(readRecords(dir)).toEqual([]);
    expect(journal.getHealth().droppedRecordCount).toBe(1);
  });
});
