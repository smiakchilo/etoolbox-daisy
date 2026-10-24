/**
 * Projects the OpenRouter SDK's usage (typed `unknown` at this seam) onto a
 * `model.usage` event body. Only the model name and numeric token/cost counters
 * are read; the response's output, which holds the conversation, is never
 * touched. Anything absent or malformed is omitted.
 *
 * Two inputs, deliberately distinct. `getResponse()` is the **last** round of a
 * tool loop only, so its `usage` understates a turn that called tools; it is
 * read for the model name, and for the tokens only when no totals exist.
 * `getUsage()` aggregates **every** model call the run made, which is what the
 * user's gross totals need (`SessionUsageTotals`: `inputTokens` and `outputTokens`
 * are gross, `cachedTokens` the cached part of the input, `cost` USD and present
 * only when the server reported one).
 */
import { type ModelUsageBody, buildModelUsage, hasUsage } from '../../shared';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function mapOpenRouterUsage(
  response: unknown,
  totals: unknown,
  extras: { readonly durationMs?: number; readonly reasoningEffort?: string | null } = {},
): ModelUsageBody | undefined {
  const root = record(response);
  const aggregate = record(totals);
  // A run that never completed a model call has nothing to report - zeros would
  // read as "free", not "unknown".
  if (aggregate !== undefined && aggregate['modelCalls'] === 0) return undefined;
  if (root === undefined && aggregate === undefined) return undefined;

  const lastRound = record(root?.['usage']);
  const body =
    aggregate !== undefined
      ? buildModelUsage({
          model: root?.['model'],
          reasoningEffort: extras.reasoningEffort ?? undefined,
          inputTokens: aggregate['inputTokens'],
          outputTokens: aggregate['outputTokens'],
          cacheReadTokens: aggregate['cachedTokens'],
          reasoningTokens: aggregate['reasoningTokens'],
          cost: { value: aggregate['cost'], unit: 'usd' },
          durationMs: extras.durationMs,
        })
      : buildModelUsage({
          model: root?.['model'],
          reasoningEffort: extras.reasoningEffort ?? undefined,
          inputTokens: lastRound?.['inputTokens'],
          outputTokens: lastRound?.['outputTokens'],
          cacheReadTokens: record(lastRound?.['inputTokensDetails'])?.['cachedTokens'],
          reasoningTokens: record(lastRound?.['outputTokensDetails'])?.['reasoningTokens'],
          cost: { value: lastRound?.['cost'], unit: 'usd' },
          durationMs: extras.durationMs,
        });
  return hasUsage(body) ? body : undefined;
}

/**
 * How long a run's usage totals are waited for. `getUsage()` is documented never
 * to reject, but on a run that was aborted or failed it re-enters the SDK's tool
 * loop before answering, and nothing in its types promises that returns
 * promptly - so the wait is bounded, and a run whose accounting does not arrive
 * is reported without it rather than holding the turn (or a one-shot call) open.
 */
export const USAGE_READ_TIMEOUT_MS = 3000;

/**
 * The run's aggregate usage (`SessionUsageTotals`), or `undefined` when the SDK
 * has none to give in time. Never rejects.
 */
export async function readUsageTotals(
  call: { getUsage(): Promise<unknown> },
  timeoutMs: number = USAGE_READ_TIMEOUT_MS,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => call.getUsage())
        .catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
