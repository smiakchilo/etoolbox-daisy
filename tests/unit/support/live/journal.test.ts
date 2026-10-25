import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assistantMessages,
  assistantText,
  errorEvents,
  isAwaitingUserInput,
  journalPathFor,
  listJournalChatIds,
  modelOf,
  modelUsageTotals,
  parseJournalText,
  readJournalFile,
  serverIdOf,
  skillCalls,
  toolCalls,
  turnSummaries,
  userPrompts,
} from '../../../support/live/journal';
import {
  assistantRecord,
  headerRecord,
  modelChangedRecord,
  promptRecord,
  questionRecord,
  toJsonl,
  toolRecords,
  turnSummaryRecord,
  usageRecord,
} from '../../../support/live/journalFixtures';
import { createScratchDirs } from '../../../support/scratchDirs';

const scratch = createScratchDirs('unit-live-journal', 'journal-');
afterEach(() => scratch.cleanup());

const NOT_FOUND = { ok: false, code: 'NOT_FOUND', message: 'no such page' } as const;

describe('parseJournalText', () => {
  it('skips a half-written last line and counts it', () => {
    const text = toJsonl([headerRecord(), promptRecord(2_000, 'hi')]) + '{"recordType":"user.pro';
    const journal = parseJournalText(text);
    expect(journal.records).toHaveLength(2);
    expect(journal.skippedLines).toBe(1);
  });

  it('skips lines that are JSON but not a journal record', () => {
    const journal = parseJournalText(`${JSON.stringify({ recordType: 'nope' })}\n[]\n`);
    expect(journal.records).toHaveLength(0);
    expect(journal.skippedLines).toBe(2);
  });

  it('ignores blank lines without counting them', () => {
    const journal = parseJournalText(`\n\n${toJsonl([headerRecord()])}\n`);
    expect(journal.records).toHaveLength(1);
    expect(journal.skippedLines).toBe(0);
  });
});

describe('files', () => {
  it('reads a journal file and lists chat ids by file name', () => {
    const chats = scratch.create();
    writeFileSync(journalPathFor(chats, 'chat-1'), toJsonl([headerRecord()]));
    writeFileSync(path.join(chats, 'notes.txt'), 'not a journal');
    expect(listJournalChatIds(chats)).toEqual(['chat-1']);
    expect(readJournalFile(journalPathFor(chats, 'chat-1')).records).toHaveLength(1);
  });

  it('lists nothing for a missing directory', () => {
    expect(listJournalChatIds(path.join(scratch.create(), 'absent'))).toEqual([]);
  });

  it('refuses a chat id that is not a safe file name', () => {
    expect(() => journalPathFor(scratch.create(), '../escape')).toThrow();
  });

  it('keeps a nested directory readable', () => {
    const dir = path.join(scratch.create(), 'a', 'b');
    mkdirSync(dir, { recursive: true });
    expect(listJournalChatIds(dir)).toEqual([]);
  });
});

describe('queries', () => {
  const journal = parseJournalText(
    toJsonl([
      headerRecord(1_000),
      promptRecord(2_000, 'first'),
      ...toolRecords(2_100, {
        id: 'call-a',
        name: 'environment_facts',
        result: { ok: true, data: {} },
      }),
      ...toolRecords(2_200, {
        id: 'call-b',
        name: 'aem_get_json',
        arguments: { path: '/x' },
        result: NOT_FOUND,
      }),
      ...toolRecords(2_300, { id: 'call-c', name: 'load_skill', arguments: { name: 'search' } }),
      assistantRecord(2_400, ''),
      assistantRecord(2_500, 'the answer'),
      turnSummaryRecord(2_600),
      promptRecord(3_000, 'second'),
      ...toolRecords(3_100, {
        id: 'call-d',
        name: 'environment_facts',
        result: { ok: true, data: {} },
      }),
      assistantRecord(3_200, 'more'),
      turnSummaryRecord(3_300, 'error'),
    ]),
  );

  it('returns prompts and turn summaries in order', () => {
    expect(userPrompts(journal).map((prompt) => prompt.prompt)).toEqual(['first', 'second']);
    expect(turnSummaries(journal).map((summary) => summary.outcome)).toEqual([
      'completed',
      'error',
    ]);
  });

  it('joins each tool call with its result and prompt index', () => {
    const calls = toolCalls(journal);
    expect(calls.map((call) => call.toolCallId)).toEqual(['call-a', 'call-b', 'call-c', 'call-d']);
    expect(calls.map((call) => call.promptIndex)).toEqual([0, 0, 0, 1]);
    expect(calls[0]?.outcome?.ok).toBe(true);
    expect(calls[1]?.outcome?.ok).toBe(false);
    expect(calls[2]?.outcome).toBeUndefined();
  });

  it('filters tool calls by name', () => {
    expect(toolCalls(journal, 'environment_facts')).toHaveLength(2);
    expect(toolCalls(journal, 'absent')).toHaveLength(0);
  });

  it('reads the loaded skill name from the skill call', () => {
    expect(skillCalls(journal).map((call) => call.skillName)).toEqual(['search']);
  });

  it('keeps empty assistant messages but leaves them out of the text', () => {
    expect(assistantMessages(journal)).toHaveLength(3);
    expect(assistantText(journal)).toBe('the answer\n\nmore');
  });
});

describe('diagnostics', () => {
  it('sums usage, treating an unreported metric as zero', () => {
    const journal = parseJournalText(
      toJsonl([
        headerRecord(),
        usageRecord(2_000, { inputTokens: 10, outputTokens: 4 }),
        usageRecord(2_100, { inputTokens: 5 }),
      ]),
    );
    expect(modelUsageTotals(journal)).toEqual({
      inputTokens: 15,
      outputTokens: 4,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      calls: 2,
    });
  });

  it('reports the last model change, else the turn summary model', () => {
    const changed = parseJournalText(
      toJsonl([
        modelChangedRecord(1_500, 'first-model'),
        modelChangedRecord(1_600, 'second-model'),
      ]),
    );
    expect(modelOf(changed)).toBe('second-model');
    const summarised = parseJournalText(
      toJsonl([turnSummaryRecord(2_000, 'completed', { model: 'from-summary' })]),
    );
    expect(modelOf(summarised)).toBe('from-summary');
    expect(modelOf(parseJournalText(''))).toBeUndefined();
  });

  it('takes the host from the header, else from the first prompt that names one', () => {
    expect(serverIdOf(parseJournalText(toJsonl([headerRecord(1_000, 'host-1')])))).toBe('host-1');
    const fromPrompt = { ...promptRecord(2_000, 'hi'), serverId: 'host-2' };
    expect(serverIdOf(parseJournalText(toJsonl([headerRecord(), fromPrompt])))).toBe('host-2');
    expect(serverIdOf(parseJournalText(toJsonl([headerRecord()])))).toBeUndefined();
  });

  it('collects error events', () => {
    const failure = {
      recordType: 'agent.event',
      at: 2_000,
      event: {
        type: 'model.call.failed',
        chatId: 'chat-1',
        sequence: 90,
      },
    };
    expect(errorEvents(parseJournalText(toJsonl([failure])))).toHaveLength(1);
    expect(errorEvents(parseJournalText(toJsonl([headerRecord()])))).toHaveLength(0);
  });
});

describe('isAwaitingUserInput', () => {
  const asked = [headerRecord(), promptRecord(2_000, 'go'), questionRecord(2_100, 'which?')];

  it('is true while a question is unanswered', () => {
    expect(isAwaitingUserInput(parseJournalText(toJsonl(asked)))).toBe(true);
  });

  it('is false once the ask_user call has its result', () => {
    const answered = [
      ...asked,
      ...toolRecords(2_200, { id: 'ask', name: 'ask_user', result: { ok: true, data: 'x' } }),
    ];
    expect(isAwaitingUserInput(parseJournalText(toJsonl(answered)))).toBe(false);
  });

  it('is false after the turn ended or a new prompt was sent', () => {
    expect(
      isAwaitingUserInput(parseJournalText(toJsonl([...asked, turnSummaryRecord(2_300)]))),
    ).toBe(false);
    expect(
      isAwaitingUserInput(parseJournalText(toJsonl([...asked, promptRecord(2_400, 'again')]))),
    ).toBe(false);
  });
});
