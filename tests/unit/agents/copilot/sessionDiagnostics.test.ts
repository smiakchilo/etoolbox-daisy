import { describe, expect, it } from 'vitest';
import {
  mapContextUsage,
  mapModelCallFailure,
  mapModelChange,
  mapModelUsage,
} from '../../../../src/agents/copilot/sessionDiagnostics';

describe('mapModelUsage', () => {
  it('copies every counter and renames the SDK `duration` to `durationMs`', () => {
    expect(
      mapModelUsage({
        model: 'gpt-x',
        reasoningEffort: 'high',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 4,
        cacheWriteTokens: 3,
        reasoningTokens: 2,
        cost: 1,
        duration: 1200,
        timeToFirstTokenMs: 300,
        finishReason: 'stop',
      }),
    ).toEqual({
      type: 'model.usage',
      model: 'gpt-x',
      reasoningEffort: 'high',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 4,
      cacheWriteTokens: 3,
      reasoningTokens: 2,
      cost: 1,
      costUnit: 'billing-multiplier',
      durationMs: 1200,
      timeToFirstTokenMs: 300,
      finishReason: 'stop',
    });
  });

  it('reports AI credits from the runtime nano-AI units, apart from the billing multiplier', () => {
    const mapped = mapModelUsage({
      inputTokens: 10,
      cost: 2,
      copilotUsage: { totalNanoAiu: 2_500_000_000 },
    });

    expect(mapped).toMatchObject({ aiCredits: 2.5, cost: 2, costUnit: 'billing-multiplier' });
  });

  it('reads an absent cache count as zero once the call reports its input, as the runtime does', () => {
    expect(mapModelUsage({ inputTokens: 10 })).toMatchObject({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    // Without an input figure nothing says the cache was unused.
    const noInput = mapModelUsage({ outputTokens: 3 });
    expect(noInput).not.toHaveProperty('cacheReadTokens');
    expect(noInput).not.toHaveProperty('cacheWriteTokens');
  });

  it('omits absent, null, negative, non-finite and oversized values', () => {
    const mapped = mapModelUsage({
      model: 'm'.repeat(201),
      reasoningEffort: null,
      inputTokens: -1,
      outputTokens: Number.NaN,
      cost: Number.POSITIVE_INFINITY,
      finishReason: 'x'.repeat(101),
      duration: 0,
    });
    expect(mapped).toEqual({ type: 'model.usage', durationMs: 0 });
  });
});

describe('mapContextUsage', () => {
  it('maps the window snapshot', () => {
    expect(mapContextUsage({ currentTokens: 1200, tokenLimit: 128_000 })).toEqual({
      type: 'context.usage',
      currentTokens: 1200,
      tokenLimit: 128_000,
    });
  });

  it('reports nothing for a snapshot that cannot describe a window', () => {
    expect(mapContextUsage({ currentTokens: 5 })).toBeUndefined();
    expect(mapContextUsage({ currentTokens: 5, tokenLimit: 0 })).toBeUndefined();
    expect(mapContextUsage({ currentTokens: -1, tokenLimit: 100 })).toBeUndefined();
  });
});

describe('mapModelCallFailure', () => {
  it('maps the structured facts only', () => {
    const mapped = mapModelCallFailure({
      source: 'top_level',
      failureKind: 'api',
      transport: 'http',
      statusCode: 429,
      errorCode: 'rate_limited',
      errorType: 'RateLimit',
      durationMs: 800,
      model: 'gpt-x',
      // Carried by the SDK and deliberately never read.
      errorMessage: 'the prompt was: secret',
    } as Parameters<typeof mapModelCallFailure>[0]);
    expect(mapped).toEqual({
      type: 'model.call.failed',
      model: 'gpt-x',
      failureKind: 'api',
      transport: 'http',
      statusCode: 429,
      errorCode: 'rate_limited',
      errorType: 'RateLimit',
      durationMs: 800,
    });
    expect(JSON.stringify(mapped)).not.toContain('secret');
  });

  it('skips a failure that is not the top-level model call', () => {
    expect(mapModelCallFailure({ source: 'sub_agent', statusCode: 500 })).toBeUndefined();
    expect(mapModelCallFailure({ source: 'mcp_sampling' })).toBeUndefined();
  });

  it('treats a missing source as top-level and drops unknown enums and bad status codes', () => {
    expect(
      mapModelCallFailure({ failureKind: 'weird', transport: 'carrier-pigeon', statusCode: 42 }),
    ).toEqual({ type: 'model.call.failed' });
    expect(mapModelCallFailure({ statusCode: 503.5 })).toEqual({ type: 'model.call.failed' });
  });
});

describe('mapModelChange', () => {
  it('is runtime-reported and carries the previous values', () => {
    expect(
      mapModelChange({
        newModel: 'b',
        previousModel: 'a',
        reasoningEffort: 'low',
        previousReasoningEffort: null,
      }),
    ).toEqual({
      type: 'model.changed',
      model: 'b',
      cause: 'runtime-reported',
      reasoningEffort: 'low',
      previousModel: 'a',
    });
  });

  it('yields nothing for an unusable model name', () => {
    expect(mapModelChange({ newModel: '' })).toBeUndefined();
    expect(mapModelChange({ newModel: 'x'.repeat(201) })).toBeUndefined();
  });
});
