import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutoSave } from '../../../../src/renderer/src/settings/autoSave';

/**
 * The debounced auto-save scheduler (autoSave.ts), the primitive every
 * Settings section is built on. Rules under test:
 *
 * - Each arm coalesces: only one pending run, and the window restarts at the
 *   latest edit (no save fires for typing that keeps coming).
 * - A run armed while a previous save is in flight starts only after that
 *   save settles, then waits its own fresh window.
 * - `flushNow` runs pending work immediately and waits for in-flight work
 *   (the close-and-persist path); `hasPending` tracks both states.
 * - A throwing/rejected save is swallowed and logged, never a rejection that
 *   could bubble into an unhandled promise across IPC.
 * - `dispose` cancels pending work and rejects later arms.
 */

describe('createAutoSave scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid edits into one save, restarting the window at each edit', async () => {
    const run = vi.fn(() => Promise.resolve());
    const autoSave = createAutoSave(1000);

    autoSave.arm(run);
    await vi.advanceTimersByTimeAsync(400);
    autoSave.arm(run);
    // The second edit restarted the window: it now ends at t=1400, not t=1000.
    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('honours a custom delay window', async () => {
    const run = vi.fn(() => Promise.resolve());
    const autoSave = createAutoSave(250);

    autoSave.arm(run);
    await vi.advanceTimersByTimeAsync(249);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs work armed during an in-flight save only after a fresh window following that save', async () => {
    let release: () => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const autoSave = createAutoSave(1000);

    autoSave.arm(run);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);

    // An edit lands while the save is in flight: it must not start a second
    // concurrent save, however long the timer is left alone.
    autoSave.arm(run);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);

    // Once the in-flight save settles, the pending edit gets its own fresh
    // 1000ms window (never saved immediately on top of the previous save).
    release();
    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs (not merely queues) the very first arm, even for a no-op arm before any timer', async () => {
    const run = vi.fn(() => Promise.resolve());
    const autoSave = createAutoSave(1000);

    autoSave.arm(run);
    await autoSave.flushNow();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('flushNow drains pending work immediately without waiting for the window', async () => {
    const run = vi.fn(() => Promise.resolve());
    const autoSave = createAutoSave(1000);

    autoSave.arm(run);
    await autoSave.flushNow();
    expect(run).toHaveBeenCalledTimes(1);
    expect(autoSave.hasPending()).toBe(false);
  });

  it('flushNow waits for an in-flight save, then drains work armed during it', async () => {
    let release: () => void = () => undefined;
    let call = 0;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          call += 1;
          release = resolve;
        }),
    );
    const autoSave = createAutoSave(1000);

    autoSave.arm(run);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    // A second edit arms a run while the first is still in flight.
    autoSave.arm(run);

    const flush = autoSave.flushNow();
    release();
    await vi.advanceTimersByTimeAsync(0);
    // The second run is launched by the flush loop itself (no debounce).
    expect(run).toHaveBeenCalledTimes(2);
    release();
    await flush;

    expect(run).toHaveBeenCalledTimes(2);
    expect(call).toBe(2);
    expect(autoSave.hasPending()).toBe(false);
  });

  it('hasPending tracks an armed-but-not-run edit and an in-flight save', async () => {
    let release: () => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const autoSave = createAutoSave(1000);

    expect(autoSave.hasPending()).toBe(false);
    autoSave.arm(run);
    expect(autoSave.hasPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(autoSave.hasPending()).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(autoSave.hasPending()).toBe(false);
  });

  it('swallows a save that throws synchronously, logging it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const run = vi.fn(() => {
        throw new Error('boom');
      });
      const autoSave = createAutoSave(1000);
      autoSave.arm(run);
      await expect(autoSave.flushNow()).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalledWith('[daisy] Settings auto-save failed.');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('swallows a save that rejects, logging it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const run = vi.fn(() => Promise.reject(new Error('boom')));
      const autoSave = createAutoSave(1000);
      autoSave.arm(run);
      await expect(autoSave.flushNow()).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalledWith('[daisy] Settings auto-save failed.');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('dispose cancels a pending save and ignores later arms', async () => {
    const run = vi.fn(() => Promise.resolve());
    const autoSave = createAutoSave(1000);

    autoSave.arm(run);
    autoSave.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();

    autoSave.arm(run);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
    expect(autoSave.hasPending()).toBe(false);
  });

  it('cancel drops an armed-but-not-run save without touching an in-flight one', async () => {
    let release: () => void = () => undefined;
    let call = 0;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          call += 1;
          release = resolve;
        }),
    );
    const autoSave = createAutoSave(1000);

    autoSave.arm(run);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);

    // An edit lands while the save is in flight, then is cancelled before it
    // ever gets its own window. The in-flight save must still complete.
    autoSave.arm(run);
    autoSave.cancel();
    release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(call).toBe(1);
    expect(autoSave.hasPending()).toBe(false);

    autoSave.arm(run);
    autoSave.cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
