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
import type { ModelCallFailedEvent, ModelChangedEvent, ModelUsageEvent } from '../../shared';

type EventBody<T extends { chatId: unknown; sequence: unknown }> = Omit<T, 'chatId' | 'sequence'>;

export interface SdkUsageData {
  readonly model?: string;
  readonly reasoningEffort?: string | null;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly cost?: number;
  readonly duration?: number;
  readonly timeToFirstTokenMs?: number;
  readonly finishReason?: string;
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

export function mapModelUsage(data: SdkUsageData): EventBody<ModelUsageEvent> {
  return {
    type: 'model.usage',
    ...defined({
      model: text(data.model, MODEL_MAX),
      reasoningEffort: text(data.reasoningEffort, EFFORT_MAX),
      inputTokens: metric(data.inputTokens),
      outputTokens: metric(data.outputTokens),
      cacheReadTokens: metric(data.cacheReadTokens),
      cacheWriteTokens: metric(data.cacheWriteTokens),
      reasoningTokens: metric(data.reasoningTokens),
      cost: metric(data.cost),
      durationMs: metric(data.duration),
      timeToFirstTokenMs: metric(data.timeToFirstTokenMs),
      finishReason: text(data.finishReason, TEXT_MAX),
    }),
  };
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
