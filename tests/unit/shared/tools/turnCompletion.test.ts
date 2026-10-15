import { describe, expect, it } from 'vitest';
import {
  TURN_COMPLETE_RESULT_KEY,
  isTurnCompleteResult,
  type JsonValue,
} from '../../../../src/shared';

/**
 * `isTurnCompleteResult` is the one place every agent adapter agrees on how a
 * tool result says "the model's turn ends here" (see `TURN_COMPLETE_RESULT_KEY`).
 * The tools that set it are covered by their own suites; this pins the reader.
 */
describe('isTurnCompleteResult', () => {
  it('is true only for an object carrying the marker as boolean true', () => {
    expect(isTurnCompleteResult({ [TURN_COMPLETE_RESULT_KEY]: true })).toBe(true);
    expect(isTurnCompleteResult({ operation: 'x', [TURN_COMPLETE_RESULT_KEY]: true })).toBe(true);
  });

  it('is false for a missing marker, a non-true value, a non-object, or an array', () => {
    expect(isTurnCompleteResult({ operation: 'x' })).toBe(false);
    expect(isTurnCompleteResult({ [TURN_COMPLETE_RESULT_KEY]: false })).toBe(false);
    expect(isTurnCompleteResult({ [TURN_COMPLETE_RESULT_KEY]: 'yes' })).toBe(false);
    expect(isTurnCompleteResult(undefined)).toBe(false);
    expect(isTurnCompleteResult(null)).toBe(false);
    expect(isTurnCompleteResult('turnComplete')).toBe(false);
    expect(isTurnCompleteResult([1, 2])).toBe(false);
    // A payload whose real content is a `JsonValue[]` never carries the marker.
    expect(isTurnCompleteResult([] as readonly JsonValue[])).toBe(false);
  });
});
