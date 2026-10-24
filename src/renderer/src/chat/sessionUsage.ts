import type { AgentEvent, ChatJournalRecord, CostUnit } from '../../../shared';

/**
 * The running total of what the open conversation has cost, projected from the
 * normalized `model.usage` / `model.changed` / `context.usage` events - live and,
 * for a resumed chat, replayed from its journal. Agent-neutral: it knows nothing
 * of any SDK, only of the contract, so a new agent needs no work here.
 *
 * Every metric records whether *every* model call reported it. The contract says
 * an absent metric is "not reported", never zero, so a total over calls that
 * only partly reported it is a lower bound, and a figure derived from two such
 * totals (uncached input) cannot be stated exactly. Callers show a lower bound
 * as such and an underivable figure as unavailable - never a guess.
 */

/** A summed metric: `complete` is false when some call did not report it. */
export interface UsageTotal {
  readonly value: number;
  readonly complete: boolean;
}

export interface ContextSnapshot {
  readonly currentTokens: number;
  readonly tokenLimit: number;
}

export interface SessionUsageSnapshot {
  /** Model calls seen (`model.usage` events). Zero means nothing was reported. */
  readonly calls: number;
  /** The model the latest call (or switch) named. */
  readonly model: string | undefined;
  /** Gross input, cached reads and writes included. */
  readonly input: UsageTotal | undefined;
  readonly output: UsageTotal | undefined;
  readonly cacheRead: UsageTotal | undefined;
  readonly cacheWrite: UsageTotal | undefined;
  /** Cost per unit: different units are never added together. */
  readonly costs: Readonly<Partial<Record<CostUnit, UsageTotal>>>;
  /** GitHub Copilot's own usage metric. */
  readonly aiCredits: UsageTotal | undefined;
  /** The latest context-window snapshot, when the agent reports one. */
  readonly context: ContextSnapshot | undefined;
}

export interface SessionUsage {
  /** Folds one event in; anything that is not usage is ignored. */
  apply(event: AgentEvent): void;
  /** Starts over (a new conversation). */
  clear(): void;
  snapshot(): SessionUsageSnapshot;
}

interface Accumulator {
  sum: number;
  reported: number;
}

type MetricKey = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'aiCredits';

export function createSessionUsage(): SessionUsage {
  let calls = 0;
  let model: string | undefined;
  let context: ContextSnapshot | undefined;
  const metrics = new Map<MetricKey, Accumulator>();
  const costs = new Map<CostUnit, Accumulator>();

  function add<K>(map: Map<K, Accumulator>, key: K, value: number | undefined): void {
    if (value === undefined) return;
    const entry = map.get(key) ?? { sum: 0, reported: 0 };
    entry.sum += value;
    entry.reported += 1;
    map.set(key, entry);
  }

  function total(entry: Accumulator | undefined): UsageTotal | undefined {
    return entry === undefined
      ? undefined
      : { value: entry.sum, complete: entry.reported === calls };
  }

  return {
    apply(event) {
      switch (event.type) {
        case 'model.changed':
          model = event.model;
          return;
        case 'context.usage':
          context = { currentTokens: event.currentTokens, tokenLimit: event.tokenLimit };
          return;
        case 'model.usage': {
          calls += 1;
          if (event.model !== undefined) model = event.model;
          add(metrics, 'input', event.inputTokens);
          add(metrics, 'output', event.outputTokens);
          add(metrics, 'cacheRead', event.cacheReadTokens);
          add(metrics, 'cacheWrite', event.cacheWriteTokens);
          add(metrics, 'aiCredits', event.aiCredits);
          // A cost whose unit is unknown (an old journal) is not shown: nothing
          // says what it measures.
          if (event.costUnit !== undefined) add(costs, event.costUnit, event.cost);
          return;
        }
        default:
          return;
      }
    },
    clear() {
      calls = 0;
      model = undefined;
      context = undefined;
      metrics.clear();
      costs.clear();
    },
    snapshot() {
      const costTotals: Partial<Record<CostUnit, UsageTotal>> = {};
      for (const [unit, entry] of costs) {
        const value = total(entry);
        if (value !== undefined) costTotals[unit] = value;
      }
      return {
        calls,
        model,
        input: total(metrics.get('input')),
        output: total(metrics.get('output')),
        cacheRead: total(metrics.get('cacheRead')),
        cacheWrite: total(metrics.get('cacheWrite')),
        costs: costTotals,
        aiCredits: total(metrics.get('aiCredits')),
        context,
      };
    },
  };
}

/**
 * Feeds a stored conversation's journal into `usage`, so a resumed chat shows
 * the totals it had. Only `agent.event` records carry usage; everything else is
 * ignored. Replays on top of whatever `usage` holds, so callers `clear()` first.
 */
export function replayJournalIntoUsage(
  records: readonly ChatJournalRecord[],
  usage: SessionUsage,
): void {
  for (const record of records) {
    if (record.recordType === 'agent.event') usage.apply(record.event);
  }
}

/**
 * Uncached input: the gross input minus the part served from cache (reads, and
 * writes where reported). Exact only when both input and cache reads were
 * reported on every call; otherwise `undefined` - the figure cannot be stated.
 */
export function uncachedInput(snapshot: SessionUsageSnapshot): number | undefined {
  const { input, cacheRead, cacheWrite } = snapshot;
  if (input === undefined || cacheRead === undefined) return undefined;
  if (!input.complete || !cacheRead.complete) return undefined;
  return Math.max(0, input.value - cacheRead.value - (cacheWrite?.value ?? 0));
}

// ---------------------------------------------------------------------------
// Presentation (pure)
// ---------------------------------------------------------------------------

const LOWER_BOUND = '≥';
const MISSING = '—';

/** 1234 -> "1.2k", 12345 -> "12.3k", 1_500_000 -> "1.5M"; below 1000 exact. */
export function formatTokenCount(value: number): string {
  if (value < 1000) return String(Math.round(value));
  const scaled = value >= 1_000_000 ? value / 1_000_000 : value / 1000;
  const suffix = value >= 1_000_000 ? 'M' : 'k';
  const rounded = scaled >= 100 ? Math.round(scaled).toString() : scaled.toFixed(1);
  return `${rounded.replace(/\.0$/, '')}${suffix}`;
}

function formatTotal(total: UsageTotal | undefined, format: (value: number) => string): string {
  if (total === undefined) return MISSING;
  return `${total.complete ? '' : LOWER_BOUND}${format(total.value)}`;
}

/** Full-precision token count with thousands separators, for tooltips and the panel. */
export function formatExactTokens(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** What the footer gauge shows: compact text, and the exact figures for its tooltip. */
export interface GaugeText {
  readonly text: string;
  readonly title: string;
}

/**
 * The footer gauge: gross input then output for the conversation. `undefined`
 * when there is nothing to show - no call has reported input or output (a new
 * conversation, an older journal, an agent that reports none) - so the footer
 * hides the gauge rather than show zeros or dashes for something unknown.
 */
export function describeGauge(snapshot: SessionUsageSnapshot): GaugeText | undefined {
  if (snapshot.input === undefined && snapshot.output === undefined) return undefined;
  const input = formatTotal(snapshot.input, formatTokenCount);
  const output = formatTotal(snapshot.output, formatTokenCount);
  const exact = (total: UsageTotal | undefined): string => formatTotal(total, formatExactTokens);
  return {
    text: `↑ ${input} ↓ ${output}`,
    title: `Input ${exact(snapshot.input)}, output ${exact(snapshot.output)} tokens in this chat`,
  };
}

export interface UsageRow {
  /** Stable key, used as the row's test hook and never shown. */
  readonly id:
    | 'model'
    | 'context'
    | 'input-uncached'
    | 'input-cached'
    | 'output'
    | 'cost-usd'
    | 'cost-ai-credits';
  readonly label: string;
  readonly value: string;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function formatCredits(value: number): string {
  return value.toFixed(value < 1 ? 4 : 2);
}

/**
 * The usage panel's rows. Cost rows appear only when the agent reported a cost
 * in a unit worth showing; the billing multiplier is a provider weighting, not
 * a spend, and is left out.
 */
export function describeUsagePanel(
  snapshot: SessionUsageSnapshot,
  fallbackModel: string | undefined,
): readonly UsageRow[] {
  const uncached = uncachedInput(snapshot);
  const notFullyReported = 'Not fully reported';
  const rows: UsageRow[] = [
    { id: 'model', label: 'Model', value: snapshot.model ?? fallbackModel ?? MISSING },
    {
      id: 'context',
      label: 'Context',
      value:
        snapshot.context === undefined
          ? 'Not reported'
          : `${formatExactTokens(snapshot.context.currentTokens)} / ${formatExactTokens(snapshot.context.tokenLimit)} (${String(Math.round((snapshot.context.currentTokens / snapshot.context.tokenLimit) * 100))}%)`,
    },
    {
      id: 'input-uncached',
      label: 'Input, uncached',
      value:
        snapshot.input === undefined
          ? MISSING
          : uncached === undefined
            ? notFullyReported
            : formatExactTokens(uncached),
    },
    {
      id: 'input-cached',
      label: 'Input, cached',
      value:
        snapshot.cacheRead === undefined
          ? MISSING
          : formatTotal(snapshot.cacheRead, formatExactTokens),
    },
    { id: 'output', label: 'Output', value: formatTotal(snapshot.output, formatExactTokens) },
  ];
  const usd = snapshot.costs.usd;
  if (usd !== undefined) {
    rows.push({ id: 'cost-usd', label: 'Cost', value: formatTotal(usd, formatUsd) });
  }
  if (snapshot.aiCredits !== undefined) {
    rows.push({
      id: 'cost-ai-credits',
      label: 'AI credits',
      value: formatTotal(snapshot.aiCredits, formatCredits),
    });
  }
  return rows;
}
