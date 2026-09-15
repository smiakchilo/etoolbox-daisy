import { describe, expect, it } from 'vitest';
import { clampViewBounds } from '../../../../src/main/browser/viewBounds';

const container = { x: 0, y: 0, width: 1000, height: 800 };

describe('clampViewBounds', () => {
  it('passes through a rectangle that already fits entirely inside the container', () => {
    expect(clampViewBounds({ x: 100, y: 50, width: 400, height: 300 }, container)).toEqual({
      x: 100,
      y: 50,
      width: 400,
      height: 300,
    });
  });

  it('clamps a width that would overflow the right edge', () => {
    expect(clampViewBounds({ x: 900, y: 0, width: 500, height: 100 }, container)).toEqual({
      x: 900,
      y: 0,
      width: 100,
      height: 100,
    });
  });

  it('clamps a height that would overflow the bottom edge', () => {
    expect(clampViewBounds({ x: 0, y: 700, width: 100, height: 500 }, container)).toEqual({
      x: 0,
      y: 700,
      width: 100,
      height: 100,
    });
  });

  it('clamps a negative-origin-equivalent report (x/y beyond container) to the container edge with zero size', () => {
    expect(clampViewBounds({ x: 1500, y: 0, width: 200, height: 200 }, container)).toEqual({
      x: 1000,
      y: 0,
      width: 0,
      height: 200,
    });
  });

  it('clamps a rectangle at the exact origin with an oversized width and height', () => {
    expect(clampViewBounds({ x: 0, y: 0, width: 5000, height: 5000 }, container)).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 800,
    });
  });

  it('handles a zero-size container without producing negative dimensions', () => {
    expect(
      clampViewBounds({ x: 10, y: 10, width: 50, height: 50 }, { x: 0, y: 0, width: 0, height: 0 }),
    ).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
