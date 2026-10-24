import { describe, expect, it, vi } from 'vitest';
import {
  mapOpenRouterUsage,
  readUsageTotals,
  USAGE_READ_TIMEOUT_MS,
} from '../../../../src/agents/openrouter/usageDiagnostics';

const TOTALS = {
  inputTokens: 300,
  outputTokens: 50,
  totalTokens: 350,
  cachedTokens: 120,
  reasoningTokens: 9,
  cost: 0.02,
  modelCalls: 3,
};

describe('mapOpenRouterUsage', () => {
  it('reports the whole run (every round) from the aggregate, and the model from the last response', () => {
    expect(
      mapOpenRouterUsage(
        // The last round alone - what getResponse() returns - understates the run.
        { model: 'openai/gpt-x', usage: { inputTokens: 100, outputTokens: 20 } },
        TOTALS,
        { durationMs: 900, reasoningEffort: 'medium' },
      ),
    ).toEqual({
      type: 'model.usage',
      model: 'openai/gpt-x',
      reasoningEffort: 'medium',
      inputTokens: 300,
      outputTokens: 50,
      cacheReadTokens: 120,
      reasoningTokens: 9,
      cost: 0.02,
      costUnit: 'usd',
      durationMs: 900,
    });
  });

  it('falls back to the last response when the SDK gives no aggregate', () => {
    expect(
      mapOpenRouterUsage(
        {
          model: 'openai/gpt-x',
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            inputTokensDetails: { cachedTokens: 80 },
            outputTokensDetails: { reasoningTokens: 7 },
            cost: 0.01,
          },
        },
        undefined,
      ),
    ).toEqual({
      type: 'model.usage',
      model: 'openai/gpt-x',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      reasoningTokens: 7,
      cost: 0.01,
      costUnit: 'usd',
    });
  });

  it('still reports the spend of a run that failed before any final response', () => {
    const mapped = mapOpenRouterUsage(undefined, TOTALS);

    expect(mapped).toMatchObject({ inputTokens: 300, outputTokens: 50 });
    expect(mapped).not.toHaveProperty('model');
  });

  it('reports nothing for a run that completed no model call, rather than zeros', () => {
    const none = { ...TOTALS, inputTokens: 0, outputTokens: 0, modelCalls: 0 };

    expect(mapOpenRouterUsage({ model: 'openai/gpt-x' }, none)).toBeUndefined();
  });

  it('returns undefined when there is neither a response nor an aggregate', () => {
    expect(mapOpenRouterUsage(undefined, undefined)).toBeUndefined();
    expect(mapOpenRouterUsage('nope', undefined)).toBeUndefined();
    expect(mapOpenRouterUsage(null, null)).toBeUndefined();
  });

  it('drops malformed values and never reads the output', () => {
    const mapped = mapOpenRouterUsage(
      {
        model: 42,
        output: [{ text: 'private content' }],
        usage: { inputTokens: -5, outputTokens: '7', cost: Number.NaN },
      },
      undefined,
      { reasoningEffort: null },
    );
    expect(mapped).toBeUndefined();
  });

  it('omits a cost the server did not report', () => {
    const mapped = mapOpenRouterUsage({ model: 'm' }, { ...TOTALS, cost: undefined });

    expect(mapped).not.toHaveProperty('cost');
    expect(mapped).not.toHaveProperty('costUnit');
  });
});

describe('readUsageTotals', () => {
  it("returns the run's totals when they arrive", async () => {
    await expect(readUsageTotals({ getUsage: () => Promise.resolve(TOTALS) })).resolves.toBe(
      TOTALS,
    );
  });

  it('returns nothing, never a rejection, when the SDK throws', async () => {
    await expect(
      readUsageTotals({ getUsage: () => Promise.reject(new Error('boom')) }),
    ).resolves.toBeUndefined();
    await expect(
      readUsageTotals({
        getUsage: () => {
          throw new Error('sync boom');
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('gives up after the bound when the accounting of an aborted run never arrives', async () => {
    vi.useFakeTimers();
    try {
      const pending = readUsageTotals({ getUsage: () => new Promise(() => undefined) });

      await vi.advanceTimersByTimeAsync(USAGE_READ_TIMEOUT_MS + 1);

      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no timer behind once the totals have arrived', async () => {
    vi.useFakeTimers();
    try {
      await readUsageTotals({ getUsage: () => Promise.resolve(TOTALS) });

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
