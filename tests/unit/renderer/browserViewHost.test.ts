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
 *
 * `setSuspended(true)` no longer collapses in one IPC send: it animates the
 * view's rectangle down to a centre-pinned point over 200ms (the native view
 * has no opacity API, so this is its "fade"). The suite drives those frames
 * with a controllable `requestAnimationFrame` stub: `runFrames` advances time
 * and fires queued callbacks, `runToCompletion` steps 16ms frames until the
 * animation is done.
 */

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface QueuedFrame {
  id: number;
  cb: (time: number) => void;
}

let dom: JSDOM;
let setViewBounds: ReturnType<typeof vi.fn>;
let rect: Bounds;
let rafCallbacks: QueuedFrame[];
let nextRafId: number;
let rafNow: number;

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;
const previousResizeObserver = Reflect.get(globalThis, 'ResizeObserver') as unknown;

beforeEach(() => {
  dom = new JSDOM();
  setViewBounds = vi.fn();
  rect = { x: 0, y: 40, width: 800, height: 560 };
  rafCallbacks = [];
  nextRafId = 1;
  rafNow = 0;

  Reflect.set(dom.window, 'daisy', { browser: { setViewBounds } });
  // jsdom implements neither of these; the reporter needs them to coalesce
  // resize bursts (which this suite drives explicitly instead) and to animate
  // the collapse/restore, which the helpers below step by hand.
  Reflect.set(dom.window, 'requestAnimationFrame', (cb: (time: number) => void) => {
    const id = nextRafId;
    nextRafId += 1;
    rafCallbacks.push({ id, cb });
    return id;
  });
  Reflect.set(dom.window, 'cancelAnimationFrame', (id: number) => {
    rafCallbacks = rafCallbacks.filter((entry) => entry.id !== id);
  });
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

/** Runs one round of whatever frames are currently queued, with time advanced `delta`. */
function runFrames(delta: number): void {
  rafNow += delta;
  const pending = rafCallbacks;
  rafCallbacks = [];
  for (const entry of pending) entry.cb(rafNow);
}

/** Steps 16ms frames until no animation frames remain (or a hard cap is hit). */
function runToCompletion(): void {
  for (let i = 0; i < 100; i += 1) {
    if (rafCallbacks.length === 0) break;
    runFrames(16);
  }
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
    // The view fades rather than popping: no collapsed rectangle is sent until
    // the animation has actually run. The first frame is the t=0 anchor (an
    // unchanged full rect); the second rounds it down to a partial midpoint
    // still centred on the original rectangle.
    runFrames(16);
    runFrames(16);
    const partial = setViewBounds.mock.lastCall?.[0] as Bounds;
    expect(partial.width).toBeGreaterThan(0);
    expect(partial.width).toBeLessThan(800);
    expect(partial.x).toBeGreaterThan(0);

    runToCompletion();
    const collapsed = setViewBounds.mock.lastCall?.[0] as Bounds;
    expect(collapsed.width).toBe(0);
    expect(collapsed.height).toBe(0);
    expect(collapsed.x).toBe(Math.round(800 / 2));
    expect(collapsed.y).toBe(Math.round(40 + 560 / 2));
  });

  it('ignores bounds reports while suspended', () => {
    const host = build();
    host.setSuspended(true);
    runToCompletion();
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
    runToCompletion();
    host.setSuspended(false);
    runToCompletion();
    expect(setViewBounds.mock.lastCall?.[0]).toEqual({ x: 0, y: 40, width: 800, height: 560 });
  });

  it('reports the newly dragged width on resume', () => {
    const host = build();
    host.reportBoundsNow();
    host.setSuspended(true);
    runToCompletion();
    rect = { x: 0, y: 40, width: 420, height: 560 };
    host.setSuspended(false);
    runToCompletion();
    expect(setViewBounds.mock.lastCall?.[0]).toEqual({ x: 0, y: 40, width: 420, height: 560 });
  });

  it('treats a repeated suspend/resume as a no-op', () => {
    const host = build();
    host.setSuspended(true);
    host.setSuspended(true);
    host.setSuspended(false);
    host.setSuspended(false);
    // Everything collapsed and restored; the animation runs to the live rect.
    runToCompletion();
    expect(setViewBounds.mock.lastCall?.[0]).toEqual({ x: 0, y: 40, width: 800, height: 560 });
  });

  it('collapses instantly when animate is disabled (server picker path), and restores instantly too', () => {
    const host = build();
    host.reportBoundsNow();
    expect(setViewBounds).toHaveBeenCalledTimes(1);

    host.setSuspended(true, { animate: false });
    expect(setViewBounds).toHaveBeenCalledTimes(2);
    expect(setViewBounds.mock.lastCall?.[0]).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(rafCallbacks).toHaveLength(0);

    rect = { x: 0, y: 40, width: 420, height: 560 };
    host.setSuspended(false, { animate: false });
    expect(setViewBounds).toHaveBeenCalledTimes(3);
    expect(setViewBounds.mock.lastCall?.[0]).toEqual({ x: 0, y: 40, width: 420, height: 560 });
    expect(rafCallbacks).toHaveLength(0);
  });

  it('interrupts a mid-restore grow with an instant collapse, e.g. picker opening during a drag', () => {
    const host = build();
    host.reportBoundsNow();
    host.setSuspended(true);
    runToCompletion();
    host.setSuspended(false);
    // The first restore frame is the t=0 anchor (a point); the second starts
    // the visible grow back.
    runFrames(16);
    runFrames(16);
    expect((setViewBounds.mock.lastCall?.[0] as Bounds).width).toBeGreaterThan(0);

    host.setSuspended(true, { animate: false });
    expect(setViewBounds.mock.lastCall?.[0]).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(rafCallbacks).toHaveLength(0);
  });
});
