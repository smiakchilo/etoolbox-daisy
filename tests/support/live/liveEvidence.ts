import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TestInfo } from '@playwright/test';
import { type EvidenceSummary, summarizeJournal } from './evidenceSummary';
import { parseJournalText } from './journal';
import type { LiveAgentInfo, LiveHostInfo } from './liveApp';
import { redactJsonl, redactText, redactValue } from './redact';
import { renderTranscript } from './transcript';

/** Where evidence folders go: `<repo>/test-results/live`. */
export const EVIDENCE_ROOT = path.resolve(__dirname, '../../../test-results/live');

export interface EvidenceInput {
  readonly scenario: string;
  /** The journal the app wrote for the conversation under test. */
  readonly journalPath: string;
  readonly agent: LiveAgentInfo;
  readonly host?: LiveHostInfo | undefined;
  /** Pass the verdict when it is already known (a `finally` runs before Playwright sets `testInfo.status`). */
  readonly passed?: boolean;
}

export interface EvidenceResult {
  readonly directory: string;
  readonly summary: EvidenceSummary;
}

function stamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'scenario'
  );
}

/**
 * Writes `test-results/live/<yyyymmdd-hhmmss>-<scenario>/` with a redacted copy of
 * the journal, `summary.json` and a readable `transcript.md`, and attaches the
 * three to the Playwright report. Call it from a `finally`/`afterEach` BEFORE the
 * app closes, so a failed scenario still leaves its evidence. Every artifact goes
 * through the redaction; nothing raw is written.
 */
export async function attachEvidence(
  testInfo: TestInfo,
  input: EvidenceInput,
  options: { readonly rootDir?: string; readonly now?: Date } = {},
): Promise<EvidenceResult> {
  const { rootDir = EVIDENCE_ROOT, now = new Date() } = options;
  const directory = path.join(rootDir, `${stamp(now)}-${slug(input.scenario)}`);
  mkdirSync(directory, { recursive: true });

  // A scenario that failed before its first prompt has no journal; the evidence then holds only the header facts.
  const rawText = existsSync(input.journalPath) ? readFileSync(input.journalPath, 'utf8') : '';
  const journal = parseJournalText(rawText);
  const passed =
    input.passed ?? (testInfo.status === undefined ? 'unknown' : testInfo.status === 'passed');
  const summary = summarizeJournal(journal, {
    scenario: input.scenario,
    agentId: input.agent.id,
    settingsModel: input.agent.model,
    hostLabel: input.host?.label,
    passed,
  });

  const journalCopy = path.join(directory, 'journal.jsonl');
  const summaryFile = path.join(directory, 'summary.json');
  const transcriptFile = path.join(directory, 'transcript.md');
  writeFileSync(journalCopy, redactJsonl(rawText), 'utf8');
  writeFileSync(summaryFile, `${JSON.stringify(redactValue(summary), null, 2)}\n`, 'utf8');
  const heading = `${input.scenario} - ${input.agent.id} / ${summary.model ?? 'default model'} / ${input.host?.label ?? 'no host'}`;
  writeFileSync(transcriptFile, redactText(renderTranscript(journal, heading)), 'utf8');

  for (const [name, file] of [
    ['journal', journalCopy],
    ['summary', summaryFile],
    ['transcript', transcriptFile],
  ] as const) {
    await testInfo.attach(`${name}`, { path: file });
  }
  return { directory, summary };
}
