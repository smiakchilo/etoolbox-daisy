import { el } from '../lib/dom';
import { computeReservedRegionBounds, type ReservedRegionBounds } from './viewModel';

/**
 * How long the native view's collapse/expand animation runs. This must stay
 * in step with the `200ms ease` transition on `.browser-page-panel` in
 * shell.css - the two are deliberately the same motion, one applied to the
 * composited native view, one to the DOM cover panel beneath it.
 */
const COLLAPSE_FADE_MS = 200;

/** Smooth deceleration, the same curve the DOM panel's CSS transition implies. */
function easeOutCubic(t: number): number {
  return 1 - (1 - t) * (1 - t) * (1 - t);
}

/**
 * The region reserved below the browser toolbar for the native
 * `WebContentsView` that the main process positions over the renderer
 * (requirements-decisions.md section 8). This element deliberately renders no
 * page content itself - the renderer must never try to draw AEM/author pages
 * itself, since sandboxing and CSP make that impossible anyway and the whole
 * point of a native view is that Electron composites it outside the web
 * page's DOM/paint pipeline. It exists only so its geometry can be measured
 * and reported to main.
 */
export interface BrowserViewHost {
  readonly element: HTMLElement;
  /** Forces a bounds measurement/report right now, e.g. after the pane first mounts. */
  reportBoundsNow(): void;
  /**
   * Collapses the native view to a zero-sized rectangle (`true`) and restores
   * it from the live measurement (`false`).
   *
   * Used while the pane splitter is being dragged. The native view is
   * composited *above* this document, so for its own rectangle it - not the
   * renderer - receives mouse input; a drag heading left would lose its
   * `pointermove`/`pointerup` stream as soon as the cursor overtook the
   * view's IPC-delayed new bounds, leaving the splitter stuck mid-drag.
   * Collapsing for the duration also avoids asking the main process to resize
   * a live page once per animation frame.
   *
   * The collapse/restore is animated by default (the view shrinks to a point
   * about the centre of its reserved rectangle over {@link COLLAPSE_FADE_MS}),
   * so the page itself participates in the drag's fade instead of vanishing in
   * one frame. Pass `{ animate: false }` when an instant collapse is wanted -
   * the server picker, whose list must get the layout space the moment it
   * opens (details in browserPane.ts).
   */
  setSuspended(suspended: boolean, options?: { readonly animate?: boolean }): void;
  dispose(): void;
}

export function createBrowserViewHost(): BrowserViewHost {
  const placeholder = el('p', {
    attrs: { class: 'browser-view-host__notice' },
    text: 'Reserved for the page view. Content is drawn by the main process, not the renderer.',
  });
  const host = el('div', {
    attrs: { class: 'browser-view-host', 'data-testid': 'browser-view-host' },
    children: [placeholder],
  });

  let lastReported: ReservedRegionBounds | undefined;
  let suspended = false;
  // Which mode the collapse ran in, so the restore matches it (an instant
  // picker collapse must not come back animated around a layout change).
  let collapseAnimateMode = false;
  // What an in-flight animation is doing, so `setSuspended` knows when a call
  // is a true no-op versus a legitimate direction reversal (e.g. the picker
  // opening mid-restore must collapse instantly, not be swallowed).
  let pendingOp: 'suspending' | 'restoring' | 'none' = 'none';

  function reportBoundsNow(): void {
    if (suspended) return;
    const bounds = computeReservedRegionBounds(host.getBoundingClientRect());
    if (
      lastReported &&
      lastReported.x === bounds.x &&
      lastReported.y === bounds.y &&
      lastReported.width === bounds.width &&
      lastReported.height === bounds.height
    ) {
      return;
    }
    lastReported = bounds;
    // `host.getBoundingClientRect()` is already CSS pixels relative to the
    // viewport, which is what `aemBrowserView.ts` expects: it feeds this
    // rectangle straight to `WebContentsView.setBounds()` against a
    // same-origin `window.getContentBounds()` rectangle whose own (0,0) is
    // the window's content-area top-left. `shell.css` guarantees the
    // document itself never scrolls (see its top-of-file comment), so the
    // viewport and the window content area never drift apart here.
    window.daisy.browser.setViewBounds(bounds);
  }

  // Coalesces bursts of resize notifications (a `ResizeObserver` firing
  // repeatedly mid-drag, or a window `resize` arriving alongside it) into at
  // most one IPC send per animation frame - but never drops the final one:
  // `reportBoundsNow` always re-measures the *live* rectangle when the
  // frame's callback actually runs, so whichever resize was last before the
  // browser stops requesting frames is exactly the one that gets reported.
  let rafHandle: number | undefined;

  function scheduleReport(): void {
    if (rafHandle !== undefined) return;
    rafHandle = window.requestAnimationFrame(() => {
      rafHandle = undefined;
      reportBoundsNow();
    });
  }

  // Animation for the splitter drag. The native view has no opacity
  // (verified against electron.d.ts: `View` only exposes setBounds /
  // setVisible / setBackgroundColor / setBackgroundBlur), so "fading" it
  // means collapsing its rectangle to a point about its own centre. That is
  // exactly as good for the drag: the page shrinks away over the same 200ms
  // the covering DOM panel fades, and is only ever fully resolved to a
  // zero-sized rectangle once the animation has run its course.
  let animHandle: number | undefined;

  /**
   * Animates the native view between a full `anchor` rectangle and a
   * centre-pinned point. `closing` picks the direction: the view shrinks
   * `anchor` -> zero, or grows zero -> `anchor`. Each frame's rectangle is
   * kept in `lastReported` so the mutual dedupe still holds while an
   * animation is in flight and so an interrupted animation never leaves a
   * stale full-size value behind.
   */
  function animateViewBounds(
    anchor: ReservedRegionBounds,
    closing: boolean,
    onDone: () => void,
  ): void {
    if (animHandle !== undefined) {
      window.cancelAnimationFrame(animHandle);
      animHandle = undefined;
    }
    let startTime: number | undefined;
    const step = (now: number): void => {
      if (startTime === undefined) startTime = now;
      const t = Math.min(1, (now - startTime) / COLLAPSE_FADE_MS);
      const scale = closing ? 1 - easeOutCubic(t) : easeOutCubic(t);
      const width = Math.max(0, Math.round(anchor.width * scale));
      const height = Math.max(0, Math.round(anchor.height * scale));
      const rect: ReservedRegionBounds = {
        x: Math.round(anchor.x + (anchor.width - width) / 2),
        y: Math.round(anchor.y + (anchor.height - height) / 2),
        width,
        height,
      };
      lastReported = rect;
      window.daisy.browser.setViewBounds(rect);
      if (t < 1) {
        animHandle = window.requestAnimationFrame(step);
      } else {
        animHandle = undefined;
        onDone();
      }
    };
    animHandle = window.requestAnimationFrame(step);
  }

  // The primary signal: the reserved element can change size without the
  // window changing size at all (e.g. the chat pane's flex sibling growing).
  const resizeObserver = new ResizeObserver(() => scheduleReport());
  resizeObserver.observe(host);

  // Belt-and-suspenders: also react directly to a window resize, in case a
  // future layout change ever made the element's own size insensitive to it
  // (`ResizeObserver` would otherwise be the only signal).
  window.addEventListener('resize', scheduleReport);

  return {
    element: host,
    reportBoundsNow,
    setSuspended(next: boolean, options?: { readonly animate?: boolean }): void {
      const animate = options?.animate ?? true;
      if (next) {
        // Already collapsed, or a collapse in flight: nothing to do. Only a
        // mid-restore must be interrupted (and re-collapsed), e.g. the picker
        // opening while the view is still growing back.
        if (suspended && pendingOp !== 'restoring') return;
      } else {
        // Fully restored, or already growing back: nothing to do.
        if (!suspended || pendingOp === 'restoring') return;
      }
      // Cancel any in-flight animation before acting on this call. The
      // animated paths re-cancel inside `animateViewBounds`, but the instant
      // paths bypass it - without this, a queued frame from a cancelled
      // restore would fire afterwards and resurrect the view with a stale
      // rectangle.
      if (animHandle !== undefined) {
        window.cancelAnimationFrame(animHandle);
        animHandle = undefined;
      }
      if (next) {
        collapseAnimateMode = animate;
        suspended = true;
        // Base on the last measured value so a suspend that raced a pending
        // `reportBoundsNow` still collapses from the size actually on screen.
        const anchor = lastReported ?? computeReservedRegionBounds(host.getBoundingClientRect());
        if (animate && anchor.width > 0 && anchor.height > 0) {
          pendingOp = 'suspending';
          animateViewBounds(anchor, true, () => {
            // `lastReported` is the centre-pinned zero rect already; nothing
            // to snap. The restore's dedupe sees it differ from the live
            // rect, so the view is guaranteed to come back.
            pendingOp = 'none';
          });
        } else {
          const collapsed: ReservedRegionBounds = { x: 0, y: 0, width: 0, height: 0 };
          lastReported = collapsed;
          pendingOp = 'none';
          window.daisy.browser.setViewBounds(collapsed);
        }
      } else {
        const target = computeReservedRegionBounds(host.getBoundingClientRect());
        if (collapseAnimateMode && target.width > 0 && target.height > 0) {
          pendingOp = 'restoring';
          animateViewBounds(target, false, () => {
            // `suspended` stays true for the whole animation so
            // `reportBoundsNow` can't slip an unrelated measurement in under
            // the growing view; `lastReported` is already `target` from the
            // final frame.
            pendingOp = 'none';
            suspended = false;
          });
        } else {
          pendingOp = 'none';
          suspended = false;
          reportBoundsNow();
        }
      }
    },
    dispose(): void {
      resizeObserver.disconnect();
      window.removeEventListener('resize', scheduleReport);
      if (animHandle !== undefined) {
        window.cancelAnimationFrame(animHandle);
        animHandle = undefined;
      }
      if (rafHandle !== undefined) {
        window.cancelAnimationFrame(rafHandle);
        rafHandle = undefined;
      }
    },
  };
}
