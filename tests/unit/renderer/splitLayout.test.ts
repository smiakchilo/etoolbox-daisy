import { describe, expect, it } from 'vitest';
import { isBrowserPaneFraction } from '../../../src/renderer/src/shell/splitLayout';

/**
 * The one piece of pane-boundary geometry this codebase still owns directly:
 * validating a value read back from storage. Clamping, drag math and
 * keyboard stepping now live inside `sp-split-view` itself (see
 * `shell/mainSplitView.ts`).
 */

describe('isBrowserPaneFraction', () => {
  it('accepts a fraction strictly inside the unit interval', () => {
    expect(isBrowserPaneFraction(0.5)).toBe(true);
  });

  it('rejects values that would restore the app with a collapsed pane', () => {
    expect(isBrowserPaneFraction(0)).toBe(false);
    expect(isBrowserPaneFraction(1)).toBe(false);
    expect(isBrowserPaneFraction(1.5)).toBe(false);
    expect(isBrowserPaneFraction(-0.2)).toBe(false);
  });

  it('rejects non-numeric and non-finite values', () => {
    expect(isBrowserPaneFraction(Number.NaN)).toBe(false);
    expect(isBrowserPaneFraction('0.5')).toBe(false);
    expect(isBrowserPaneFraction(null)).toBe(false);
    expect(isBrowserPaneFraction(undefined)).toBe(false);
  });
});
