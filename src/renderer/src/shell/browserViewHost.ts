import { el } from '../lib/dom';
import { computeReservedRegionBounds, type ReservedRegionBounds } from './viewModel';

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
   */
  setSuspended(suspended: boolean): void;
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
    setSuspended(next: boolean): void {
      if (suspended === next) return;
      suspended = next;
      if (next) {
        const collapsed: ReservedRegionBounds = { x: 0, y: 0, width: 0, height: 0 };
        // Recorded as the last reported value so the `resume` call below is
        // never swallowed by the dedupe above: the restored rectangle always
        // differs from a collapsed one.
        lastReported = collapsed;
        window.daisy.browser.setViewBounds(collapsed);
      } else {
        reportBoundsNow();
      }
    },
    dispose(): void {
      resizeObserver.disconnect();
      window.removeEventListener('resize', scheduleReport);
      if (rafHandle !== undefined) {
        window.cancelAnimationFrame(rafHandle);
        rafHandle = undefined;
      }
    },
  };
}
