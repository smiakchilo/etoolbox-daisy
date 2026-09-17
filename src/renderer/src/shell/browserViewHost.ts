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
 *
 * base.css widens the `sp-split-view` handle to 8px (its
 * `--mod-splitview-handle-width`); the measured/reported rectangle must
 * therefore end before that handle's overhang, so the composited view never
 * covers it (a native view always paints above this document). The pane's
 * own width - the persisted split - is unaffected; only the reserved
 * rectangle narrows.
 */
export interface BrowserViewHost {
  readonly element: HTMLElement;
  /** Forces a bounds measurement/report right now, e.g. after the pane first mounts. */
  reportBoundsNow(): void;
  /**
   * Collapses the native view to a zero-sized rectangle (`true`) and restores
   * it from the live measurement (`false`).
   *
   * Used only by the hosts panel, which replaces the page-view region with
   * its own DOM list (browserPane.ts). A DOM list cannot sit above the
   * composited native view, so the view is collapsed the moment the hosts
   * panel opens and the panel's `[hidden]` swaps instantly.
   *
   * The pane-splitter drag deliberately does NOT go through this path: the
   * view stays fully visible and live-following for its whole duration (see
   * splitter-layout.spec.ts for why even a leftward drag cannot stall - the
   * likely-but-never-verified "input capture" reasoning that motivated a
   * collapse is refuted there by a real drag against the built app).
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
    // the window's content-area top-left. `base.css` guarantees the
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
        // Recorded as the last reported value so the restore below is never
        // swallowed by the dedupe: the restored rectangle always differs
        // from a collapsed one.
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
