import { describe, expect, it } from 'vitest';
import {
  AGENT_TURN_IN_FLIGHT_STATES,
  createDeferredRuntimeRecycler,
  createModelPreferenceCache,
  isAgentTurnInFlight,
} from '../../../src/main/agentComposition';
import { SESSION_STREAM_STATES } from '../../../src/shared';

/**
 * Composition-level tests for step 09's model-preference plumbing and the
 * deferred runtime recycler that lets a mid-turn Settings change take effect on
 * the next turn instead of tearing down the live one.
 */

describe('isAgentTurnInFlight', () => {
  it('is true in every state in which a turn is actually running', () => {
    expect(isAgentTurnInFlight('sending')).toBe(true);
    expect(isAgentTurnInFlight('streaming')).toBe(true);
    expect(isAgentTurnInFlight('runningTool')).toBe(true);
  });

  it('is true while cancelling, because the turn is still winding down', () => {
    // Recycling here would race the turn being stopped.
    expect(isAgentTurnInFlight('cancelling')).toBe(true);
  });

  it('is false for `idle`, `error` and `closed`, so a recycle applies at once', () => {
    expect(isAgentTurnInFlight('idle')).toBe(false);
    expect(isAgentTurnInFlight('error')).toBe(false);
    expect(isAgentTurnInFlight('closed')).toBe(false);
  });

  it('classifies every state the contract defines, so a new one cannot be forgotten', () => {
    for (const state of SESSION_STREAM_STATES) {
      expect(typeof isAgentTurnInFlight(state)).toBe('boolean');
    }
    expect(AGENT_TURN_IN_FLIGHT_STATES.size).toBeLessThan(SESSION_STREAM_STATES.length);
  });
});

describe('createDeferredRuntimeRecycler', () => {
  function harness(inFlight = false) {
    let turnInFlight = inFlight;
    const order: string[] = [];
    const errors: unknown[] = [];
    const recycler = createDeferredRuntimeRecycler({
      isTurnInFlight: () => turnInFlight,
      onError: (error) => errors.push(error),
    });
    return {
      recycler,
      order,
      errors,
      setTurnInFlight: (value: boolean): void => {
        turnInFlight = value;
      },
      recycle:
        (name: string): (() => Promise<void>) =>
        () => {
          order.push(name);
          return Promise.resolve();
        },
    };
  }

  it('applies a recycle immediately when no turn is in flight, resolving after it ran', async () => {
    const h = harness(false);
    const done = h.recycler.request(h.recycle('proxy'));
    await done;
    expect(h.order).toEqual(['proxy']);
  });

  it('defers a recycle while a turn is in flight until the turn settles', async () => {
    const h = harness(true);
    await h.recycler.request(h.recycle('proxy'));
    expect(h.order).toEqual([]);

    h.setTurnInFlight(false);
    await h.recycler.drain();
    expect(h.order).toEqual(['proxy']);
  });

  it('does not start a queued recycle while a turn is still in flight', async () => {
    const h = harness(true);
    await h.recycler.request(h.recycle('proxy'));
    await h.recycler.drain();
    expect(h.order).toEqual([]);
  });

  it('runs queued recycles in the order they were requested', async () => {
    const h = harness(true);
    await h.recycler.request(h.recycle('first'));
    await h.recycler.request(h.recycle('second'));

    h.setTurnInFlight(false);
    await h.recycler.drain();
    expect(h.order).toEqual(['first', 'second']);
  });

  it('reports a throwing recycle and still runs the rest of the queue', async () => {
    const h = harness(true);
    await h.recycler.request(() => {
      h.order.push('boom');
      throw new Error('proxy unreachable');
    });
    await h.recycler.request(h.recycle('after'));

    h.setTurnInFlight(false);
    await h.recycler.drain();
    expect(h.order).toEqual(['boom', 'after']);
    expect(h.errors).toHaveLength(1);
  });

  it('serialises: a recycle requested mid-run waits for the running one', async () => {
    const h = harness(false);
    let release: (() => void) | undefined;
    const slow = h.recycler.request(
      () =>
        new Promise<void>((resolve) => {
          h.order.push('slow');
          release = resolve;
        }),
    );
    await Promise.resolve();
    const second = h.recycler.request(h.recycle('second'));

    // The second must not have started while the first is still running.
    expect(h.order).toEqual(['slow']);
    release?.();
    await slow;
    await second;
    expect(h.order).toEqual(['slow', 'second']);
  });
});

describe('createModelPreferenceCache', () => {
  it('starts at the seeded preference', () => {
    const cache = createModelPreferenceCache({ model: 'model-a', reasoningEffort: 'low' });
    expect(cache.current()).toEqual({ model: 'model-a', reasoningEffort: 'low' });
  });

  it('returns the newest value synchronously after a set', () => {
    // Synchronous by design: it is read on the sendPrompt path, which must not
    // do a disk read per turn.
    const cache = createModelPreferenceCache({ model: null, reasoningEffort: null });
    cache.set({ model: 'model-b', reasoningEffort: null });
    expect(cache.current()).toEqual({ model: 'model-b', reasoningEffort: null });
  });
});
