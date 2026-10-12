/**
 * Projects the OpenRouter SDK's final response (typed `unknown` at this seam)
 * onto a `model.usage` event body. Only the model name and numeric token/cost
 * counters are read; the response's output, which holds the conversation, is
 * never touched. Anything absent or malformed is omitted.
 */
import type { ModelUsageEvent } from '../../shared';

const MODEL_MAX = 200;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function metric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function mapOpenRouterUsage(
  response: unknown,
  extras: { readonly durationMs?: number; readonly reasoningEffort?: string | null } = {},
): Omit<ModelUsageEvent, 'chatId' | 'sequence' | 'turnId'> | undefined {
  const root = record(response);
  if (root === undefined) return undefined;
  const usage = record(root['usage']);
  const model = typeof root['model'] === 'string' ? root['model'] : undefined;
  const fields = {
    model: model !== undefined && model.length > 0 && model.length <= MODEL_MAX ? model : undefined,
    reasoningEffort:
      extras.reasoningEffort !== undefined &&
      extras.reasoningEffort !== null &&
      extras.reasoningEffort.length > 0 &&
      extras.reasoningEffort.length <= 50
        ? extras.reasoningEffort
        : undefined,
    inputTokens: metric(usage?.['inputTokens']),
    outputTokens: metric(usage?.['outputTokens']),
    cacheReadTokens: metric(record(usage?.['inputTokensDetails'])?.['cachedTokens']),
    reasoningTokens: metric(record(usage?.['outputTokensDetails'])?.['reasoningTokens']),
    cost: metric(usage?.['cost']),
    durationMs: metric(extras.durationMs),
  };
  const body: Record<string, unknown> = { type: 'model.usage' };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) body[key] = value;
  }
  return body as Omit<ModelUsageEvent, 'chatId' | 'sequence' | 'turnId'>;
}
