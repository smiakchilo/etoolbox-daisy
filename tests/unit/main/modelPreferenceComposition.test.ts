import { describe, expect, it } from 'vitest';
import {
  MODEL_SELECTION_LOCKED_STATES,
  createModelPreferenceCache,
  isModelSelectionLocked,
} from '../../../src/main/agentComposition';
import { SESSION_STREAM_STATES } from '../../../src/shared/contracts/sessionState';

/**
 * Composition-level tests for step 09's model-preference plumbing.
 */

describe('isModelSelectionLocked', () => {
  it('locks every state in which a turn is actually running', () => {
    expect(isModelSelectionLocked('sending')).toBe(true);
    expect(isModelSelectionLocked('streaming')).toBe(true);
    expect(isModelSelectionLocked('runningTool')).toBe(true);
  });

  it('locks `cancelling`, because the turn is still winding down', () => {
    // A setModel accepted here would race the turn being stopped.
    expect(isModelSelectionLocked('cancelling')).toBe(true);
  });

  it('does NOT lock `idle`', () => {
    expect(isModelSelectionLocked('idle')).toBe(false);
  });

  it('does NOT lock `error` or `closed`', () => {
    // Locking these would strand a user whose turn failed *because of* the
    // model they picked, unable to pick a different one.
    expect(isModelSelectionLocked('error')).toBe(false);
    expect(isModelSelectionLocked('closed')).toBe(false);
  });

  it('classifies every state the contract defines, so a new one cannot be forgotten', () => {
    for (const state of SESSION_STREAM_STATES) {
      expect(typeof isModelSelectionLocked(state)).toBe('boolean');
    }
    expect(MODEL_SELECTION_LOCKED_STATES.size).toBeLessThan(SESSION_STREAM_STATES.length);
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
