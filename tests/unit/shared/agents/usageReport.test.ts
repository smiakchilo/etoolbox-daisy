import { describe, expect, it } from 'vitest';
import {
  agentEventSchema,
  buildContextUsage,
  buildModelUsage,
  hasUsage,
} from '../../../../src/shared';

describe('buildModelUsage', () => {
  it('keeps every usable value and omits what the provider did not report', () => {
    expect(
      buildModelUsage({
        model: 'gpt-x',
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 6,
        cost: { value: 0.5, unit: 'usd' },
        aiCredits: 1.25,
      }),
    ).toEqual({
      type: 'model.usage',
      model: 'gpt-x',
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 6,
      cost: 0.5,
      costUnit: 'usd',
      aiCredits: 1.25,
    });
  });

  it('drops negative, non-finite, mistyped and oversized values', () => {
    const body = buildModelUsage({
      model: 'm'.repeat(201),
      reasoningEffort: '',
      inputTokens: -1,
      outputTokens: Number.NaN,
      cacheReadTokens: '5',
      aiCredits: Number.POSITIVE_INFINITY,
      finishReason: 'x'.repeat(101),
    });

    expect(body).toEqual({ type: 'model.usage' });
  });

  it('never reports a unit for a cost it dropped', () => {
    const body = buildModelUsage({ cost: { value: Number.NaN, unit: 'usd' } });

    expect(body).not.toHaveProperty('cost');
    expect(body).not.toHaveProperty('costUnit');
  });

  it('builds a body the event schema accepts once the adapter adds its own fields', () => {
    const body = buildModelUsage({
      inputTokens: 1,
      cost: { value: 2, unit: 'billing-multiplier' },
    });

    const parsed = agentEventSchema.safeParse({ ...body, chatId: 'chat-1', sequence: 0 });

    expect(parsed.success).toBe(true);
  });

  it('says whether a body carries anything beyond its type', () => {
    expect(hasUsage(buildModelUsage({}))).toBe(false);
    expect(hasUsage(buildModelUsage({ outputTokens: 0 }))).toBe(true);
  });
});

describe('buildContextUsage', () => {
  it('builds a snapshot from a usable pair', () => {
    expect(buildContextUsage({ currentTokens: 10, tokenLimit: 100 })).toEqual({
      type: 'context.usage',
      currentTokens: 10,
      tokenLimit: 100,
    });
  });

  it('refuses a window of zero or a missing number', () => {
    expect(buildContextUsage({ currentTokens: 10, tokenLimit: 0 })).toBeUndefined();
    expect(buildContextUsage({ currentTokens: 10 })).toBeUndefined();
    expect(buildContextUsage({ tokenLimit: 100 })).toBeUndefined();
  });
});
