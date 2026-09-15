import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserViewHost } from '../../../src/renderer/src/shell/browserViewHost';

/**
 * The reserved-region reporter, with the pane-splitter suspension path in
 * particular under test.
 *
 * That path exists because the AEM page is a native `WebContentsView`
 * composited *above* this document: while it is on screen it, not the
 * renderer, receives mouse input over its own rectangle, which would break a
 * leftward splitter drag. Collapsing it is only safe if the restore
 * afterwards is guaranteed to re-send the live rectangle - the reporter's own
 * "don't re-send an unchanged rectangle" dedupe would otherwise swallow it
 * and leave the pane permanently blank. That is the regression this suite is
 * mainly here to catch.
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
  // jsdom implements neither of these; the reporter only needs them to
  // coalesce resize bursts, which this suite drives explicitly instead.
  Reflect.set(dom.window, 'requestAnimationFrame', () => 1);
  Reflect.set(dom.window, 'cancelAnimationFrame', () => undefined);
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

  it("collapses the native view when suspended, so it cannot swallow a drag's pointer events", () => {
    const host = build();
    host.reportBoundsNow();
    host.setSuspended(true);
    expect(setViewBounds).toHaveBeenCalledTimes(2);
    expect(setViewBounds.mock.lastCall?.[0]).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('ignores bounds reports while suspended', () => {
    const host = build();
    host.setSuspended(true);
    rect = { x: 0, y: 40, width: 500, height: 560 };
    host.reportBoundsNow();
    expect(setViewBounds).toHaveBeenCalledTimes(1);
    expect(setViewBounds.mock.lastCall?.[0]).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('restores the live rectangle on resume even when it is unchanged since the collapse', () => {
    const host = build();
    host.reportBoundsNow();
    host.setSuspended(true);
    host.setSuspended(false);
    expect(setViewBounds).toHaveBeenCalledTimes(3);
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
    expect(setViewBounds).toHaveBeenCalledTimes(1);
    host.setSuspended(false);
    host.setSuspended(false);
    expect(setViewBounds).toHaveBeenCalledTimes(2);
  });
});
