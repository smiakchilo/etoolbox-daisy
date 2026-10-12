import { describe, expect, it } from 'vitest';
import { mapOpenRouterUsage } from '../../../../src/agents/openrouter/usageDiagnostics';

describe('mapOpenRouterUsage', () => {
  it('reads the model and the nested token details', () => {
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
        { durationMs: 900, reasoningEffort: 'medium' },
      ),
    ).toEqual({
      type: 'model.usage',
      model: 'openai/gpt-x',
      reasoningEffort: 'medium',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      reasoningTokens: 7,
      cost: 0.01,
      durationMs: 900,
    });
  });

  it('returns undefined for a non-object response', () => {
    expect(mapOpenRouterUsage(undefined)).toBeUndefined();
    expect(mapOpenRouterUsage('nope')).toBeUndefined();
    expect(mapOpenRouterUsage(null)).toBeUndefined();
  });

  it('drops malformed values and never reads the output', () => {
    const mapped = mapOpenRouterUsage(
      {
        model: 42,
        output: [{ text: 'private content' }],
        usage: { inputTokens: -5, outputTokens: '7', cost: Number.NaN },
      },
      { reasoningEffort: null },
    );
    expect(mapped).toEqual({ type: 'model.usage' });
  });
});
