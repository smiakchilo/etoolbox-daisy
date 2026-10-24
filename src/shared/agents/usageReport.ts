/**
 * The one place that turns a provider's usage numbers into the normalized
 * `model.usage` / `context.usage` event bodies, so every agent reports the same
 * fields with the same meaning. The user sees these totals (the footer gauge and
 * the usage panel), so a number reported without its unit, or a negative or
 * non-finite one, must never reach the stream.
 *
 * What a new agent does: pass whatever its SDK reports, as received, to
 * {@link buildModelUsage}; leave out what the SDK does not report (absent means
 * "not reported", never zero). A cost is only expressible together with its
 * unit, which is the point of its shape. The adapter adds `chatId`, `sequence`
 * and `turnId` and emits the result.
 *
 * An agent that makes calls outside the conversation (a tool's stateless
 * secondary turn, `AgentRuntime.complete`) hands each call's body to the
 * {@link UsageSink} it is given instead of dropping it.
 */
import type { ContextUsageEvent, CostUnit, ModelUsageEvent } from '../contracts';

/** A `model.usage` event without the fields only the adapter knows. */
export type ModelUsageBody = Omit<ModelUsageEvent, 'chatId' | 'sequence' | 'turnId'>;

/** A `context.usage` event without the fields only the adapter knows. */
export type ContextUsageBody = Omit<ContextUsageEvent, 'chatId' | 'sequence' | 'turnId'>;

/**
 * Receives the usage of one model call made on the chat's behalf outside the
 * conversation. Never throws; a report with nothing usable is simply dropped by
 * the caller. The application attributes it to the open chat's turn.
 */
export type UsageSink = (usage: ModelUsageBody) => void;

/** A cost with its unit; the two can only be given together. */
export interface ReportedCost {
  readonly value: unknown;
  readonly unit: CostUnit;
}

/**
 * The provider's numbers as received. Every field is `unknown`-tolerant: the
 * builder keeps only what is a usable value and omits the rest.
 */
export interface RawModelUsage {
  readonly model?: unknown;
  readonly reasoningEffort?: unknown;
  /** Gross input tokens, cached reads included. */
  readonly inputTokens?: unknown;
  readonly outputTokens?: unknown;
  /** The part of the input served from the provider's cache. */
  readonly cacheReadTokens?: unknown;
  readonly cacheWriteTokens?: unknown;
  readonly reasoningTokens?: unknown;
  readonly cost?: ReportedCost;
  /** GitHub Copilot's own usage metric; other providers omit it. */
  readonly aiCredits?: unknown;
  readonly durationMs?: unknown;
  readonly timeToFirstTokenMs?: unknown;
  readonly finishReason?: unknown;
}

const MODEL_MAX = 200;
const EFFORT_MAX = 50;
const FINISH_REASON_MAX = 100;

function metric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

/** Copies the defined entries, so an absent value is omitted (`exactOptionalPropertyTypes`). */
function definedEntries(entries: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function buildModelUsage(raw: RawModelUsage): ModelUsageBody {
  const cost = raw.cost === undefined ? undefined : metric(raw.cost.value);
  return {
    type: 'model.usage',
    ...definedEntries({
      model: text(raw.model, MODEL_MAX),
      reasoningEffort: text(raw.reasoningEffort, EFFORT_MAX),
      inputTokens: metric(raw.inputTokens),
      outputTokens: metric(raw.outputTokens),
      cacheReadTokens: metric(raw.cacheReadTokens),
      cacheWriteTokens: metric(raw.cacheWriteTokens),
      reasoningTokens: metric(raw.reasoningTokens),
      cost,
      costUnit: cost === undefined ? undefined : raw.cost?.unit,
      aiCredits: metric(raw.aiCredits),
      durationMs: metric(raw.durationMs),
      timeToFirstTokenMs: metric(raw.timeToFirstTokenMs),
      finishReason: text(raw.finishReason, FINISH_REASON_MAX),
    }),
  };
}

/** Whether a built body carries anything worth reporting beyond its type. */
export function hasUsage(body: ModelUsageBody): boolean {
  return Object.keys(body).some((key) => key !== 'type');
}

/**
 * A `context.usage` body, or `undefined` when either number is unusable (a zero
 * or missing window cannot describe how full anything is).
 */
export function buildContextUsage(raw: {
  readonly currentTokens?: unknown;
  readonly tokenLimit?: unknown;
}): ContextUsageBody | undefined {
  const currentTokens = metric(raw.currentTokens);
  const tokenLimit = metric(raw.tokenLimit);
  if (currentTokens === undefined || tokenLimit === undefined || tokenLimit === 0) return undefined;
  return { type: 'context.usage', currentTokens, tokenLimit };
}
