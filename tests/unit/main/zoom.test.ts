import { describe, expect, it, vi } from 'vitest';
import { applyZoom, nextZoomLevel, ZOOM_LEVEL_MAX, ZOOM_LEVEL_MIN } from '../../../src/main/zoom';
import { createFakeWebContents } from '../../support/fakeWebContents';

/**
 * The main-process zoom helper (`src/main/zoom.ts`). Every zoom key -
 * `Ctrl+NumpadAdd`, `Ctrl+NumpadSubtract`, `Ctrl+0` - funnels through
 * `applyZoom`, so the level arithmetic lives (and is tested) in exactly one
 * place.
 */

describe('nextZoomLevel', () => {
  it('steps one Electron level per direction', () => {
    expect(nextZoomLevel(0, 'in')).toBe(1);
    expect(nextZoomLevel(0, 'out')).toBe(-1);
    expect(nextZoomLevel(2, 'in')).toBe(3);
    expect(nextZoomLevel(-2, 'out')).toBe(-3);
  });

  it('resets to 100% regardless of the current level', () => {
    expect(nextZoomLevel(4, 'reset')).toBe(0);
    expect(nextZoomLevel(-3, 'reset')).toBe(0);
  });

  it('clamps at both bounds', () => {
    expect(nextZoomLevel(ZOOM_LEVEL_MAX, 'in')).toBe(ZOOM_LEVEL_MAX);
    expect(nextZoomLevel(ZOOM_LEVEL_MIN, 'out')).toBe(ZOOM_LEVEL_MIN);
  });
});

describe('applyZoom', () => {
  it('writes the next level to the target view', () => {
    const fake = createFakeWebContents();
    const setZoomLevel = vi.fn();
    fake.define(
      'getZoomLevel',
      vi.fn(() => 1),
    );
    fake.define('setZoomLevel', setZoomLevel);

    applyZoom(fake.webContents, 'in');

    expect(setZoomLevel).toHaveBeenCalledWith(2);
  });

  it('leaves a destroyed view alone', () => {
    const fake = createFakeWebContents();
    const setZoomLevel = vi.fn();
    fake.define(
      'isDestroyed',
      vi.fn(() => true),
    );
    fake.define('setZoomLevel', setZoomLevel);

    applyZoom(fake.webContents, 'in');

    expect(setZoomLevel).not.toHaveBeenCalled();
  });
});
