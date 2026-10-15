import { vi } from 'vitest';

/** Lets already-resolved promise chains run, one microtask hop per tick. */
export async function flushMicrotasks(ticks = 12): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
}

/** Advances fake timers by `ms`, then drains what that scheduled (needs `vi.useFakeTimers()`). */
export async function settle(ms = 1000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(0);
}
