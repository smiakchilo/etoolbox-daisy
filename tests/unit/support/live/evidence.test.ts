import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TestInfo } from '@playwright/test';
import { afterEach, describe, expect, it } from 'vitest';
import { summarizeJournal } from '../../../support/live/evidenceSummary';
import { parseJournalText } from '../../../support/live/journal';
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
import { attachEvidence } from '../../../support/live/liveEvidence';
import { REDACTED } from '../../../support/live/redact';
import {
  describeToolStatus,
  RESULT_TRUNCATE_BYTES,
  renderTranscript,
  truncate,
} from '../../../support/live/transcript';
import { toolCalls } from '../../../support/live/journal';
import { createScratchDirs } from '../../../support/scratchDirs';

const scratch = createScratchDirs('unit-live-evidence', 'evidence-');
afterEach(() => scratch.cleanup());

const SECRET = 'Bearer abcdef1234567890xyz';

function fixtureJournalText(): string {
  return toJsonl([
    headerRecord(1_000, 'host-1'),
    modelChangedRecord(1_500, 'model-x'),
    promptRecord(2_000, 'what is configured?'),
    ...toolRecords(2_100, {
      id: 'call-a',
      name: 'environment_facts',
      result: { ok: true, data: { note: `Authorization: ${SECRET}`, big: 'x'.repeat(5_000) } },
    }),
    ...toolRecords(2_200, {
      id: 'call-b',
      name: 'aem_get_json',
      arguments: { path: '/content/a' },
      result: { ok: false, code: 'NOT_FOUND', message: 'no such page' },
    }),
    questionRecord(2_300, 'which one?'),
    usageRecord(2_400, { inputTokens: 100, outputTokens: 20 }),
    assistantRecord(2_500, 'Here is the answer.'),
    turnSummaryRecord(2_600),
  ]);
}

describe('renderTranscript', () => {
  const journal = parseJournalText(fixtureJournalText());

  it('lists the prompt, tool calls, question and assistant text in journal order', () => {
    const text = renderTranscript(journal, 'Heading');
    const order = [
      'Heading',
      'what is configured?',
      'environment_facts',
      'aem_get_json',
      'which one?',
      'Here is the answer.',
    ].map((needle) => text.indexOf(needle));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('truncates a huge tool result to the budget and says so', () => {
    const text = renderTranscript(journal);
    expect(text).not.toContain('x'.repeat(RESULT_TRUNCATE_BYTES + 1));
    expect(text).toContain('truncated');
  });

  it('shows the error code of a failed call', () => {
    expect(renderTranscript(journal)).toContain('NOT_FOUND');
  });

  it('renders an empty journal as just its heading', () => {
    expect(renderTranscript(parseJournalText(''), 'Only').trim()).toBe('# Only');
  });
});

describe('truncate and describeToolStatus', () => {
  it('leaves short text alone and reports the dropped length', () => {
    expect(truncate('abc', 10)).toBe('abc');
    expect(truncate('abcdef', 2)).toContain('4 more');
  });

  it('distinguishes ok, error and no result', () => {
    const calls = toolCalls(
      parseJournalText(
        toJsonl([
          ...toolRecords(1, { id: 'a', name: 't', result: { ok: true, data: 1 } }),
          ...toolRecords(2, {
            id: 'b',
            name: 't',
            result: { ok: false, code: 'NOT_FOUND', message: 'm' },
          }),
          ...toolRecords(3, { id: 'c', name: 't' }),
        ]),
      ),
    );
    const statuses = calls.map(describeToolStatus);
    expect(new Set(statuses).size).toBe(3);
    expect(statuses[1]).toContain('NOT_FOUND');
  });
});

describe('summarizeJournal', () => {
  const meta = {
    scenario: 's',
    agentId: 'copilot',
    settingsModel: 'settings-model',
    passed: true,
  } as const;

  it('derives model, host, duration, tool statuses and usage from the journal', () => {
    const summary = summarizeJournal(parseJournalText(fixtureJournalText()), {
      ...meta,
      hostLabel: 'Local',
    });
    expect(summary.model).toBe('model-x');
    expect(summary.serverId).toBe('host-1');
    expect(summary.hostLabel).toBe('Local');
    expect(summary.durationMs).toBe(1_600);
    expect(summary.toolCalls.map((call) => call.ok)).toEqual([true, false]);
    expect(summary.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, modelCalls: 1 });
    expect(summary.turns).toHaveLength(1);
  });

  it('falls back to the settings model and null facts for an empty journal', () => {
    const summary = summarizeJournal(parseJournalText(''), meta);
    expect(summary.model).toBe('settings-model');
    expect(summary.durationMs).toBeNull();
    expect(summary.hostLabel).toBeNull();
    expect(summary.toolCalls).toEqual([]);
  });
});

describe('attachEvidence', () => {
  function fakeTestInfo(): { info: TestInfo; attached: string[] } {
    const attached: string[] = [];
    const info = {
      status: undefined,
      attach: (name: string) => {
        attached.push(name);
        return Promise.resolve();
      },
    } as unknown as TestInfo;
    return { info, attached };
  }

  const agent = { id: 'copilot', model: 'settings-model', reasoningEffort: undefined } as const;

  it('writes a redacted journal copy, summary and transcript, and attaches them', async () => {
    const dir = scratch.create();
    const journalPath = path.join(dir, 'chat-1.jsonl');
    writeFileSync(journalPath, fixtureJournalText());
    const { info, attached } = fakeTestInfo();

    const { directory, summary } = await attachEvidence(
      info,
      { scenario: 'My Scenario!', journalPath, agent, passed: true },
      { rootDir: path.join(dir, 'out'), now: new Date(2026, 9, 16, 13, 5, 9) },
    );

    expect(path.basename(directory)).toBe('20261016-130509-my-scenario');
    expect(summary.passed).toBe(true);
    expect(attached).toEqual(['journal', 'summary', 'transcript']);
    for (const file of ['journal.jsonl', 'summary.json', 'transcript.md']) {
      const text = readFileSync(path.join(directory, file), 'utf8');
      expect(text).not.toContain('abcdef1234567890xyz');
    }
    const copy = readFileSync(path.join(directory, 'journal.jsonl'), 'utf8');
    expect(copy).toContain(REDACTED);
    expect(parseJournalText(copy).skippedLines).toBe(0);
    expect(parseJournalText(copy).records.length).toBe(
      parseJournalText(fixtureJournalText()).records.length,
    );
  });

  it('still leaves evidence when the journal was never written', async () => {
    const dir = scratch.create();
    mkdirSync(path.join(dir, 'out'));
    const { info } = fakeTestInfo();
    const { directory, summary } = await attachEvidence(
      info,
      {
        scenario: 'early failure',
        journalPath: path.join(dir, 'absent.jsonl'),
        agent,
        passed: false,
      },
      { rootDir: path.join(dir, 'out') },
    );
    expect(summary.passed).toBe(false);
    expect(summary.toolCalls).toEqual([]);
    expect(readFileSync(path.join(directory, 'summary.json'), 'utf8')).toContain('copilot');
  });
});
