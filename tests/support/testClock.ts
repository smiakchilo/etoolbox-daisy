import type { Clock } from '../../src/shared/contracts/toolContracts';

/**
 * A manually-advanced clock for deterministic deadline/staleness tests.
 * `src/shared/contracts/toolContracts.ts` defines `Clock` as an injected
 * function precisely so `computeDeadline`/`isDeadlineExpired` never reach for
 * `Date.now()`; this is the test-side implementation of that seam.
 */
export interface ManualClock {
  readonly now: Clock;
  advanceMs(deltaMs: number): void;
  setMs(absoluteMs: number): void;
}

export function createManualClock(startMs = 0): ManualClock {
  let current = startMs;
  return {
    now: () => current,
    advanceMs(deltaMs: number) {
      current += deltaMs;
    },
    setMs(absoluteMs: number) {
      current = absoluteMs;
    },
  };
}
