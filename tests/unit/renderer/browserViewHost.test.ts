import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserViewHost } from '../../../src/renderer/src/shell/browserViewHost';

/**
 * The reserved-region reporter, with the server-picker suspension path under
 * test.
 *
 * The picker collapses the native view (`setSuspended`). That path exists
 * because a DOM list cannot sit above the composited `WebContentsView`.
 * Collapsing is only safe if the restore afterwards is guaranteed to re-send
 * the live rectangle - the reporter's own "don't re-send an unchanged
 * rectangle" dedupe would otherwise swallow it and leave the pane
 * permanently blank. That is the regression this suite is mainly here to
 * catch.
 *
 * A splitter drag deliberately does NOT suspend the view at all; that path
 * needs no correction here (splitter-layout.spec.ts proves the drag cannot
 * stall).
 */

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

let dom: JSDOM;
let setViewBounds: ReturnType<typeof vi.fn>;
let rect: Bounds;

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;
const previousResizeObserver = Reflect.get(globalThis, 'ResizeObserver') as unknown;

beforeEach(() => {
  dom = new JSDOM();
  setViewBounds = vi.fn();
  rect = { x: 0, y: 40, width: 800, height: 560 };

  Reflect.set(dom.window, 'daisy', { browser: { setViewBounds } });
  // jsdom implements none of rAF/ResizeObserver; the reporter coalesces resize
  // bursts into rAF frames (this suite drives them explicitly), and jsdom has
  // no layout, so every `getBoundingClientRect` is stubbed per-test.
  Reflect.set(dom.window, 'requestAnimationFrame', () => 1);
  Reflect.set(dom.window, 'cancelAnimationFrame', () => {});
  Reflect.set(
    globalThis,
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  Reflect.set(globalThis, 'document', dom.window.document);
  Reflect.set(globalThis, 'window', dom.window);
});

afterEach(() => {
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
  Reflect.set(globalThis, 'window', previousWindow);
  Reflect.set(globalThis, 'ResizeObserver', previousResizeObserver);
});

/** Builds a host whose reserved element measures `rect` (jsdom performs no layout). */
function build(): ReturnType<typeof createBrowserViewHost> {
  const host = createBrowserViewHost();
  host.element.getBoundingClientRect = () => ({
    ...rect,
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    toJSON: () => ({}),
  });
  return host;
}

describe('createBrowserViewHost', () => {
  it('reports the measured reserved region, and does not re-send an unchanged one', () => {
    const host = build();
    host.reportBoundsNow();
    expect(setViewBounds).toHaveBeenCalledTimes(1);
    expect(setViewBounds.mock.lastCall?.[0]).toEqual({ x: 0, y: 40, width: 800, height: 560 });

    host.reportBoundsNow();
    expect(setViewBounds).toHaveBeenCalledTimes(1);
  });

  it('collapses the native view instantly when suspended, so the picker list can sit above it', () => {
    const host = build();
    host.reportBoundsNow();
    expect(setViewBounds).toHaveBeenCalledTimes(1);

    host.setSuspended(true);
    expect(setViewBounds).toHaveBeenCalledTimes(2);
    expect(setViewBounds.mock.lastCall?.[0]).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('ignores bounds reports while suspended', () => {
    const host = build();
    host.setSuspended(true);
    const sentBefore = setViewBounds.mock.calls.length;
    const lastBefore = setViewBounds.mock.lastCall?.[0] as Bounds;

    rect = { x: 0, y: 40, width: 500, height: 560 };
    host.reportBoundsNow();

    expect(setViewBounds).toHaveBeenCalledTimes(sentBefore);
    expect(setViewBounds.mock.lastCall?.[0]).toEqual(lastBefore);
    expect(lastBefore.width).toBe(0);
  });

  it('restores the live rectangle on resume even when it is unchanged since the collapse', () => {
    const host = build();
    host.reportBoundsNow();
    host.setSuspended(true);
    host.setSuspended(false);
    // The restore must bypass the "unchanged since last report" dedupe: the
    // collapsed zero rect is the last reported value, and the live rect
    // differs from it.
    expect(setViewBounds.mock.lastCall?.[0]).toEqual({ x: 0, y: 40, width: 800, height: 560 });
  });

  it('reports the newly dragged width on resume', () => {
    const host = build();
    host.reportBoundsNow();
    host.setSuspended(true);
    rect = { x: 0, y: 40, width: 420, height: 560 };
    host.setSuspended(false);
    expect(setViewBounds.mock.lastCall?.[0]).toEqual({ x: 0, y: 40, width: 420, height: 560 });
  });

  it('treats a repeated suspend/resume as a no-op', () => {
    const host = build();
    host.setSuspended(true);
    host.setSuspended(true);
    host.setSuspended(false);
    host.setSuspended(false);
    // Collapsed once ({0,0,0,0}), restored once (the live rect), and the
    // repeated calls sent nothing extra.
    expect(setViewBounds).toHaveBeenCalledTimes(2);
    expect(setViewBounds.mock.lastCall?.[0]).toEqual({ x: 0, y: 40, width: 800, height: 560 });
  });
});
