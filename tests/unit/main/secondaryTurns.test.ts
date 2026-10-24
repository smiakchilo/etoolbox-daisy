import { describe, expect, it, vi } from 'vitest';
import {
  createLateBoundAuxiliaryUsage,
  createSecondaryTurns,
} from '../../../src/main/agentComposition';
import {
  err,
  ok,
  type ModelUsageBody,
  type OneShotRequest,
  type OneShotResult,
} from '../../../src/shared';

const REQUEST: OneShotRequest = { instructions: 'i', prompt: 'p' };

describe('createSecondaryTurns', () => {
  it('routes a call to the hub with the one usage sink the application bound, whatever the tool', async () => {
    const reportUsage = vi.fn();
    const complete = vi.fn(
      (
        _request: OneShotRequest,
        _signal: AbortSignal | undefined,
        sink: (u: ModelUsageBody) => void,
      ) => {
        sink({ type: 'model.usage', inputTokens: 7 });
        return Promise.resolve(ok('reply'));
      },
    );
    const turns = createSecondaryTurns({ hub: () => ({ complete }), reportUsage });
    const signal = new AbortController().signal;

    const result = await turns.complete(REQUEST, signal);

    expect(result).toEqual(ok('reply'));
    expect(complete).toHaveBeenCalledWith(REQUEST, signal, reportUsage);
    expect(reportUsage).toHaveBeenCalledWith({ type: 'model.usage', inputTokens: 7 });
  });

  it('fails cleanly, without throwing, before the agent hub exists', async () => {
    const turns = createSecondaryTurns({ hub: () => undefined, reportUsage: vi.fn() });

    const result = await turns.complete(REQUEST, undefined);

    expect(result.ok).toBe(false);
  });

  it('reads the hub at call time, so a hub assigned after construction is used', async () => {
    const holder: { hub?: { complete: () => Promise<OneShotResult> } } = {};
    const turns = createSecondaryTurns({ hub: () => holder.hub, reportUsage: vi.fn() });
    expect((await turns.complete(REQUEST, undefined)).ok).toBe(false);

    holder.hub = { complete: () => Promise.resolve(ok('late')) };

    expect(await turns.complete(REQUEST, undefined)).toEqual(ok('late'));
  });

  it("passes the hub's failure through untouched", async () => {
    const failure = err({ message: 'no', cancelled: true });
    const turns = createSecondaryTurns({
      hub: () => ({ complete: () => Promise.resolve(failure) }),
      reportUsage: vi.fn(),
    });

    expect(await turns.complete(REQUEST, undefined)).toEqual(failure);
  });
});

describe('createLateBoundAuxiliaryUsage', () => {
  it('drops a report that races startup, then forwards to the controller once bound', () => {
    const lateBound = createLateBoundAuxiliaryUsage();
    const recordAuxiliaryUsage = vi.fn();

    lateBound.report({ type: 'model.usage', inputTokens: 1 });
    lateBound.bind({ recordAuxiliaryUsage });
    lateBound.report({ type: 'model.usage', inputTokens: 2 });

    expect(recordAuxiliaryUsage.mock.calls).toEqual([[{ type: 'model.usage', inputTokens: 2 }]]);
  });
});
