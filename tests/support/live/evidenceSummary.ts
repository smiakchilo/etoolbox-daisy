import {
  errorEvents,
  type Journal,
  modelOf,
  modelUsageTotals,
  serverIdOf,
  toolCalls,
  turnSummaries,
} from './journal';
import { describeToolStatus } from './transcript';

export interface EvidenceMeta {
  readonly scenario: string;
  readonly agentId: string;
  /** The model the settings select; the journal's recorded model wins in the summary. */
  readonly settingsModel?: string | undefined;
  readonly hostLabel?: string | undefined;
  readonly passed: boolean | 'unknown';
}

export interface EvidenceSummary {
  readonly scenario: string;
  readonly passed: boolean | 'unknown';
  readonly agentId: string;
  readonly model: string | null;
  readonly hostLabel: string | null;
  readonly serverId: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly turns: readonly {
    readonly outcome: string;
    readonly durationMs: number;
    readonly toolCallCount: number;
    readonly modelCallCount: number;
  }[];
  readonly toolCalls: readonly {
    readonly name: string;
    readonly status: string;
    readonly ok: boolean | null;
  }[];
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly reasoningTokens: number;
    readonly modelCalls: number;
  };
  readonly errorCount: number;
  readonly skippedJournalLines: number;
}

function iso(epochMs: number | undefined): string | null {
  return epochMs === undefined ? null : new Date(epochMs).toISOString();
}

/** The machine-readable evidence summary: derived only from the journal plus the run's own metadata. */
export function summarizeJournal(journal: Journal, meta: EvidenceMeta): EvidenceSummary {
  const times = journal.records.flatMap((record) => {
    if (record.recordType === 'header') return [record.startedAt];
    return 'at' in record ? [record.at] : [];
  });
  const first = times.length === 0 ? undefined : Math.min(...times);
  const last = times.length === 0 ? undefined : Math.max(...times);
  const usage = modelUsageTotals(journal);
  return {
    scenario: meta.scenario,
    passed: meta.passed,
    agentId: meta.agentId,
    model: modelOf(journal) ?? meta.settingsModel ?? null,
    hostLabel: meta.hostLabel ?? null,
    serverId: serverIdOf(journal) ?? null,
    startedAt: iso(first),
    finishedAt: iso(last),
    durationMs: first === undefined || last === undefined ? null : last - first,
    turns: turnSummaries(journal).map((summary) => ({
      outcome: summary.outcome,
      durationMs: summary.durationMs,
      toolCallCount: summary.toolCallCount,
      modelCallCount: summary.modelCallCount,
    })),
    toolCalls: toolCalls(journal).map((call) => ({
      name: call.toolName,
      status: describeToolStatus(call),
      ok: call.outcome === undefined ? null : call.outcome.ok,
    })),
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      reasoningTokens: usage.reasoningTokens,
      modelCalls: usage.calls,
    },
    errorCount: errorEvents(journal).length,
    skippedJournalLines: journal.skippedLines,
  };
}
