import { WebContentsView, screen } from 'electron';
import type { BrowserWindow, Session, WebContents } from 'electron';
import type { BrowserNavigationState, ViewBounds } from '../../shared/browser-ipc';
import { decideAuxiliaryWindowOpen } from './auxiliaryWindowPolicy';
import { createAuxiliaryWindowManager, type AuxiliaryWindowManager } from './auxiliaryWindows';
import { clampViewBounds } from './viewBounds';

/**
 * The AEM pane's `WebContentsView` (implementation-plan.md step 05;
 * requirements-decisions.md section 8's two-pane layout).
 *
 * Positioning is entirely driven by the renderer's own reserved-region
 * measurement (`browserViewHost.ts`'s `.browser-view-host`, reported via
 * `browser:set-view-bounds`) - this module never guesses a layout of its
 * own. What it *does* own is making that positioning survive three things
 * the renderer cannot see or does not fire for:
 *
 *  - a window resize that arrives at the OS/Chromium level fractionally
 *    ahead of the renderer's own `ResizeObserver` callback and IPC
 *    round-trip - `applyBounds` is always driven from `lastBounds` plus a
 *    *fresh* read of `window.getContentBounds()`, so even if the renderer's
 *    next report is delayed the view never renders outside the window;
 *  - a DPI/scale-factor change (`screen`'s `display-metrics-changed`) or the
 *    window moving to a different monitor (`window`'s `moved`) - the
 *    reserved region's *CSS-pixel* size does not change in either case, so
 *    the renderer's `ResizeObserver` never fires and never re-reports
 *    bounds, yet Chromium can still need the native view relaid out/rescaled
 *    for the new monitor. Re-invoking `setBounds` with the same numbers is a
 *    deliberate no-op-looking call that still forces that relayout;
 *  - leaking listeners/views - `destroy()` is the single place all of the
 *    above is unwound, and is required to be called exactly once when the
 *    owning window closes.
 */
export interface AemBrowserViewOptions {
  readonly window: BrowserWindow;
  readonly aemSession: Session;
  readonly aemPreloadPath: string;
  /** Pushed to the renderer as `browser:state-changed` on every navigation-state change. */
  readonly onNavigationStateChange: (state: BrowserNavigationState) => void;
}

export interface AemBrowserView {
  readonly webContents: WebContents;
  readonly auxiliaryWindows: AuxiliaryWindowManager;
  setBounds(bounds: ViewBounds): void;
  getNavigationState(): BrowserNavigationState;
  goBack(): void;
  goForward(): void;
  reload(): void;
  /** Stops in-flight loading. Also required by `serverSwitch.ts`'s `SwitchableAemView`. */
  stop(): void;
  loadURL(url: string): Promise<void>;
  /** Removes the view, closes its WebContents, and unregisters every listener this module attached. Idempotent. */
  destroy(): void;
}

export function createAemBrowserView(options: AemBrowserViewOptions): AemBrowserView {
  const view = new WebContentsView({
    webPreferences: {
      session: options.aemSession,
      preload: options.aemPreloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  options.window.contentView.addChildView(view);

  const auxiliaryWindows = createAuxiliaryWindowManager(options.aemSession);
  auxiliaryWindows.attachTo(view.webContents);

  let lastBounds: ViewBounds = { x: 0, y: 0, width: 0, height: 0 };
  let destroyed = false;

  function applyBounds(): void {
    if (destroyed) return;
    const contentBounds = options.window.getContentBounds();
    const clamped = clampViewBounds(lastBounds, {
      x: 0,
      y: 0,
      width: contentBounds.width,
      height: contentBounds.height,
    });
    view.setBounds(clamped);
  }

  function setBounds(bounds: ViewBounds): void {
    lastBounds = bounds;
    applyBounds();
  }

  function getNavigationState(): BrowserNavigationState {
    const history = view.webContents.navigationHistory;
    return {
      url: view.webContents.getURL(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      isLoading: view.webContents.isLoading(),
    };
  }

  function pushNavigationState(): void {
    if (destroyed) return;
    options.onNavigationStateChange(getNavigationState());
  }

  view.webContents.on('did-navigate', pushNavigationState);
  view.webContents.on('did-navigate-in-page', pushNavigationState);
  view.webContents.on('did-start-loading', pushNavigationState);
  view.webContents.on('did-stop-loading', pushNavigationState);

  // Top-level navigation guard for the AEM view itself: http(s) only. Cross-
  // *origin* http(s) navigation is deliberately still allowed here (an SSO
  // redirect chain legitimately leaves the AEM origin for an IdP origin and
  // comes back), matching decideAuxiliaryWindowOpen's own scheme-only
  // (not origin) restriction - reused here rather than duplicated so both
  // the AEM view and its auxiliary windows enforce identically the one rule
  // that actually matters for this guard.
  view.webContents.on('will-navigate', (navigationEvent, targetUrl) => {
    if (decideAuxiliaryWindowOpen(targetUrl).kind !== 'allow') {
      navigationEvent.preventDefault();
    }
  });

  function onDisplayMetricsChanged(): void {
    applyBounds();
  }
  function onWindowMoved(): void {
    applyBounds();
  }

  screen.on('display-metrics-changed', onDisplayMetricsChanged);
  options.window.on('moved', onWindowMoved);

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    screen.removeListener('display-metrics-changed', onDisplayMetricsChanged);
    options.window.removeListener('moved', onWindowMoved);
    auxiliaryWindows.closeAll();
    if (!options.window.isDestroyed()) {
      options.window.contentView.removeChildView(view);
    }
    if (!view.webContents.isDestroyed()) {
      view.webContents.close();
    }
  }

  return {
    webContents: view.webContents,
    auxiliaryWindows,
    setBounds,
    getNavigationState,
    goBack: () => view.webContents.navigationHistory.goBack(),
    goForward: () => view.webContents.navigationHistory.goForward(),
    reload: () => view.webContents.reload(),
    stop: () => view.webContents.stop(),
    loadURL: (url: string) => view.webContents.loadURL(url),
    destroy,
  };
}
