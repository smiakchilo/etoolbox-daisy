import { describe, expect, it, vi } from 'vitest';
import { createCommitSaver } from '../../../../src/renderer/src/settings/commitSaver';

/**
 * The commit scheduler (`commitSaver.ts`), the primitive every Settings section
 * is built on. There is deliberately no timer: a commit is a deliberate act, so
 * it runs as soon as the current event finishes. The scheduler's only job is to
 * serialize commits so two can never overlap.
 *
 * Rules under test:
 * - An armed commit runs on the next microtask, never synchronously, and a
 *   burst of arms in one event coalesces into the latest one.
 * - A commit armed while a previous one is in flight starts only after that one
 *   settles.
 * - `flushNow` runs pending work immediately and waits for in-flight work
 *   (the close-and-persist path); `hasPending` tracks both states.
 * - A throwing/rejected commit is swallowed and logged, never an unhandled
 *   promise across IPC.
 * - `cancel` drops a queued commit; an in-flight commit keeps running.
 * - `dispose` cancels pending work and rejects later arms.
 */

/** Flushes the microtask queue (queueMicrotask callbacks + promise jobs). */
async function drain(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

describe('createCommitSaver scheduler', () => {
  it('runs an armed commit as soon as the event yields, never synchronously', async () => {
    const run = vi.fn(() => Promise.resolve());
    const saver = createCommitSaver();

    saver.arm(run);
    expect(run).not.toHaveBeenCalled();
    await drain();
    expect(run).toHaveBeenCalledTimes(1);
    expect(saver.hasPending()).toBe(false);
  });

  it('coalesces a burst of arms in one event into the latest run', async () => {
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    const saver = createCommitSaver();

    saver.arm(first);
    saver.arm(second);
    await drain();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('starts a commit armed during an in-flight one only after it settles', async () => {
    let release: () => void = () => undefined;
    const first = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const second = vi.fn(() => Promise.resolve());
    const saver = createCommitSaver();

    saver.arm(first);
    await drain();
    expect(first).toHaveBeenCalledTimes(1);

    saver.arm(second);
    await drain();
    expect(second).not.toHaveBeenCalled();

    release();
    await drain();
    expect(second).toHaveBeenCalledTimes(1);
    expect(saver.hasPending()).toBe(false);
  });

  it('flushNow runs pending work immediately and waits for in-flight work', async () => {
    let release: () => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const saver = createCommitSaver();

    saver.arm(run);
    await drain();
    expect(run).toHaveBeenCalledTimes(1);

    let flushed = false;
    const flush = saver.flushNow().then(() => {
      flushed = true;
    });
    await drain();
    // Still waiting on the in-flight commit.
    expect(flushed).toBe(false);

    release();
    await flush;
    expect(flushed).toBe(true);
    expect(saver.hasPending()).toBe(false);
  });

  it('flushNow drains work armed during an in-flight commit', async () => {
    let release: () => void = () => undefined;
    let call = 0;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          call += 1;
          release = resolve;
        }),
    );
    const saver = createCommitSaver();

    saver.arm(run);
    await drain();
    expect(run).toHaveBeenCalledTimes(1);

    // A second commit arms while the first is still in flight.
    saver.arm(run);
    const flush = saver.flushNow();
    release();
    await drain();
    // The flush loop launched the second run itself.
    expect(run).toHaveBeenCalledTimes(2);
    release();
    await flush;

    expect(call).toBe(2);
    expect(saver.hasPending()).toBe(false);
  });

  it('never runs two commits concurrently, even while flushing', async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const run = vi.fn(() => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<void>((resolve) => {
        releases.push(() => {
          active -= 1;
          resolve();
        });
      });
    });
    const saver = createCommitSaver();

    saver.arm(run);
    await drain();
    expect(run).toHaveBeenCalledTimes(1);

    // A second commit is queued while the first is in flight; flushing must
    // still serialize them rather than start the second on top of the first.
    saver.arm(run);
    const flush = saver.flushNow();
    await drain();
    expect(run).toHaveBeenCalledTimes(1);

    releases.shift()?.();
    await drain();
    expect(run).toHaveBeenCalledTimes(2);

    releases.shift()?.();
    await flush;

    expect(maxActive).toBe(1);
    expect(saver.hasPending()).toBe(false);
  });

  it('hasPending tracks a queued commit and an in-flight commit', async () => {
    let release: () => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const saver = createCommitSaver();

    expect(saver.hasPending()).toBe(false);
    saver.arm(run);
    expect(saver.hasPending()).toBe(true);
    await drain();
    expect(saver.hasPending()).toBe(true);
    release();
    await drain();
    expect(saver.hasPending()).toBe(false);
  });

  it('swallows a commit that throws synchronously, logging it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const run = vi.fn(() => {
        throw new Error('boom');
      });
      const saver = createCommitSaver();
      saver.arm(run);
      await expect(saver.flushNow()).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalledWith('[daisy] Settings save failed');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('swallows a commit that rejects, logging it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const run = vi.fn(() => Promise.reject(new Error('boom')));
      const saver = createCommitSaver();
      saver.arm(run);
      await expect(saver.flushNow()).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalledWith('[daisy] Settings save failed');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('dispose cancels a pending commit and ignores later arms', async () => {
    const run = vi.fn(() => Promise.resolve());
    const saver = createCommitSaver();

    saver.arm(run);
    saver.dispose();
    await drain();
    expect(run).not.toHaveBeenCalled();

    saver.arm(run);
    await drain();
    expect(run).not.toHaveBeenCalled();
    expect(saver.hasPending()).toBe(false);
  });

  it('cancel drops a queued commit without touching an in-flight one', async () => {
    let release: () => void = () => undefined;
    let call = 0;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          call += 1;
          release = resolve;
        }),
    );
    const saver = createCommitSaver();

    saver.arm(run);
    await drain();
    expect(run).toHaveBeenCalledTimes(1);

    // A commit lands while the first is in flight, then is cancelled before it
    // can start. The in-flight commit must still complete.
    saver.arm(run);
    saver.cancel();
    release();
    await drain();
    expect(run).toHaveBeenCalledTimes(1);
    expect(call).toBe(1);
    expect(saver.hasPending()).toBe(false);

    // A queued commit cancelled before the event yields never runs.
    saver.arm(run);
    saver.cancel();
    await drain();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
