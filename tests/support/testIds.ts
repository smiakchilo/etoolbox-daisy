import type { IdGenerator } from '../../src/shared/contracts/ids';

/**
 * Deterministic, counter-based `IdGenerator` (see `src/shared/contracts/ids.ts`
 * - identifier *generation* is deliberately kept outside the contract layer so
 * production can wire `crypto.randomUUID` while tests get reproducible IDs).
 * One counter is shared across every identifier kind minted from it: the
 * branded types already make a `ChatId` and a `RequestId` incompatible at
 * compile time, so there is no need for the underlying strings to come from
 * separate counters too.
 */
export function createCountingIdGenerator(prefix: string): IdGenerator {
  let counter = 0;
  return () => `${prefix}-${String(counter++)}`;
}
