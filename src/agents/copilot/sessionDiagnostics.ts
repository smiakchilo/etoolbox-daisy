/**
 * Pure mappings from the Copilot SDK's diagnostic session events (model
 * usage, a failed model call, a model switch) onto the normalized
 * `model.*` agent events. Kept apart from `sdkAgentService.ts` so the
 * field-by-field copy can be unit tested without a session.
 *
 * Only structured facts are copied. The SDK's `errorMessage` on a failed call
 * is deliberately never read: provider messages can echo request content.
 * Every string is bounded here, so an oversized value is dropped rather than
 * failing the contract's validation and losing the whole event.
 */
import {
  type ContextUsageBody,
  type ModelCallFailedEvent,
  type ModelChangedEvent,
  type ModelUsageBody,
  buildContextUsage,
  buildModelUsage,
} from '../../shared';

type EventBody<T extends { chatId: unknown; sequence: unknown }> = Omit<T, 'chatId' | 'sequence'>;

export interface SdkUsageData {
  readonly model?: string;
  readonly reasoningEffort?: string | null;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  /** The model's billing multiplier for the call (not money, and not AI credits). */
  readonly cost?: number;
  /** The call's real spend, in nano-AI units (1e9 per AI credit). */
  readonly copilotUsage?: { readonly totalNanoAiu?: number };
  readonly duration?: number;
  readonly timeToFirstTokenMs?: number;
  readonly finishReason?: string;
}

/** The SDK's `session.usage_info` payload: how full the context window is. */
export interface SdkUsageInfoData {
  readonly currentTokens?: number;
  readonly tokenLimit?: number;
}

export interface SdkModelCallFailureData {
  readonly source?: string;
  readonly failureKind?: string;
  readonly transport?: string;
  readonly statusCode?: number;
  readonly errorCode?: string;
  readonly errorType?: string;
  readonly durationMs?: number;
  readonly model?: string;
}

export interface SdkModelChangeData {
  readonly newModel: string;
  readonly previousModel?: string;
  readonly reasoningEffort?: string | null;
  readonly previousReasoningEffort?: string | null;
}

const MODEL_MAX = 200;
const EFFORT_MAX = 50;
const TEXT_MAX = 100;

function text(value: string | null | undefined, max: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return undefined;
  return value;
}

function metric(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Builds an object from the entries whose value is defined, preserving exact optional typing. */
function defined<T extends Record<string, unknown>>(entries: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

/** Nano-AI units per AI credit, the SDK's own conversion (`NANO_AIU_PER_AIU`). */
const NANO_AIU_PER_AI_CREDIT = 1e9;

export function mapModelUsage(data: SdkUsageData): ModelUsageBody {
  const nanoAiu = data.copilotUsage?.totalNanoAiu;
  // The runtime itself reads an absent cache count as zero when the call
  // reports its input (its own uncached figure is `input - cacheRead -
  // cacheWrite`), so a call with input but no cache fields means "no cache used"
  // rather than "not reported".
  const hasInput = metric(data.inputTokens) !== undefined;
  return buildModelUsage({
    model: data.model,
    reasoningEffort: data.reasoningEffort,
    inputTokens: data.inputTokens,
    outputTokens: data.outputTokens,
    cacheReadTokens: data.cacheReadTokens ?? (hasInput ? 0 : undefined),
    cacheWriteTokens: data.cacheWriteTokens ?? (hasInput ? 0 : undefined),
    reasoningTokens: data.reasoningTokens,
    cost: { value: data.cost, unit: 'billing-multiplier' },
    aiCredits: typeof nanoAiu === 'number' ? nanoAiu / NANO_AIU_PER_AI_CREDIT : undefined,
    durationMs: data.duration,
    timeToFirstTokenMs: data.timeToFirstTokenMs,
    finishReason: data.finishReason,
  });
}

/** Returns `undefined` when the runtime reported no usable window size. */
export function mapContextUsage(data: SdkUsageInfoData): ContextUsageBody | undefined {
  return buildContextUsage(data);
}

/** Returns `undefined` for a failure that is not the user's own model call (sub-agent, MCP sampling). */
export function mapModelCallFailure(
  data: SdkModelCallFailureData,
): EventBody<ModelCallFailedEvent> | undefined {
  if (data.source !== undefined && data.source !== 'top_level') return undefined;
  const failureKind =
    data.failureKind === 'api' || data.failureKind === 'transport' ? data.failureKind : undefined;
  const transport =
    data.transport === 'http' || data.transport === 'websocket' ? data.transport : undefined;
  const statusCode =
    typeof data.statusCode === 'number' &&
    Number.isInteger(data.statusCode) &&
    data.statusCode >= 100 &&
    data.statusCode <= 599
      ? data.statusCode
      : undefined;
  return {
    type: 'model.call.failed',
    ...defined({
      model: text(data.model, MODEL_MAX),
      failureKind,
      transport,
      statusCode,
      errorCode: text(data.errorCode, TEXT_MAX),
      errorType: text(data.errorType, TEXT_MAX),
      durationMs: metric(data.durationMs),
    }),
  };
}

/** Returns `undefined` when the runtime reported no usable model name. */
export function mapModelChange(data: SdkModelChangeData): EventBody<ModelChangedEvent> | undefined {
  const model = text(data.newModel, MODEL_MAX);
  if (model === undefined) return undefined;
  return {
    type: 'model.changed',
    model,
    cause: 'runtime-reported',
    ...defined({
      reasoningEffort: text(data.reasoningEffort, EFFORT_MAX),
      previousModel: text(data.previousModel, MODEL_MAX),
      previousReasoningEffort: text(data.previousReasoningEffort, EFFORT_MAX),
    }),
  };
}
