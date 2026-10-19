import { existsSync } from 'node:fs';
import { WebContentsView, screen } from 'electron';
import type { BrowserWindow, Session, WebContents } from 'electron';
import type { BrowserNavigationState, ViewBounds } from '../../shared';
import type { Logger } from '../logger';
import { attachChromeContextMenu } from '../contextMenu';
import { attachDevToolsShortcut } from '../devTools';
import { decideAllowedUrl } from './urlPolicy';
import { createWindowOpenRouter, openUrlInView, type WindowOpenRouter } from './windowOpenRouter';
import { extractChromiumErrorCodeFromText } from './serverSwitch';
import { clampViewBounds } from './viewBounds';

/**
 * The browser pane's `WebContentsView` (implementation-plan.md step 05;
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
export interface HostViewOptions {
  readonly window: BrowserWindow;
  readonly viewSession: Session;
  readonly webviewPreloadPath: string;
  /** Pushed to the renderer as `browser:state-changed` on every navigation-state change. */
  readonly onNavigationStateChange: (state: BrowserNavigationState) => void;
  /** Optional diagnostics sink for a preload that is missing or fails to evaluate. */
  readonly logger?: Logger;
}

/**
 * The outcome of a chrome-initiated `goBack`/`goForward`/`reload` command,
 * resolved once the navigation it triggers actually settles (as opposed to
 * `switchServer`'s `loadURL`, whose own promise rejection already carries
 * this information). `errorCode` is the Chromium `ERR_*` code extracted from
 * the failing `did-fail-load` event, `failedUrl` is that event's
 * `validatedURL` - the address that failed, which is what
 * `describeNetworkError` needs to name in its copy (not necessarily the
 * view's current URL: a failed `goBack` fails on the *previous* history
 * entry's address, not the one still showing).
 */
export type ChromeNavigationOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly errorCode: string; readonly failedUrl: string };

export interface HostView {
  readonly webContents: WebContents;
  /** The popup/tab policy for this view's new-window requests; `closeAll` is what a server switch closes popups through. */
  readonly windowOpenRouter: WindowOpenRouter;
  setBounds(bounds: ViewBounds): void;
  getNavigationState(): BrowserNavigationState;
  goBack(): Promise<ChromeNavigationOutcome>;
  goForward(): Promise<ChromeNavigationOutcome>;
  reload(): Promise<ChromeNavigationOutcome>;
  /** Stops in-flight loading. Also required by `serverSwitch.ts`'s `SwitchableView`. */
  stop(): void;
  loadURL(url: string): Promise<void>;
  /** Removes the view, closes its WebContents, and unregisters every listener this module attached. Idempotent. */
  destroy(): void;
}

export function createHostView(options: HostViewOptions): HostView {
  const view = new WebContentsView({
    webPreferences: {
      session: options.viewSession,
      preload: options.webviewPreloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  options.window.contentView.addChildView(view);

  // A preload that is absent (or throws while evaluating) leaves the bridge
  // with no listener: the fetch command is delivered to a `WebContents` that
  // can never answer, and every request waits out its whole deadline. The
  // broker's readiness handshake turns that into an immediate, distinctly
  // classified failure, but the *cause* is only visible here - at construction
  // for a missing file, and on `preload-error` for one that fails to evaluate.
  // Both are application build/packaging faults, not host faults, so they are
  // logged as such rather than left to be inferred from a wall of timeouts.
  if (!existsSync(options.webviewPreloadPath)) {
    options.logger?.error('WEBVIEW_PRELOAD_MISSING');
  }

  const onPreloadError = (): void => {
    options.logger?.error('WEBVIEW_PRELOAD_ERROR');
  };
  view.webContents.on('preload-error', onPreloadError);

  // New-window requests: real popups (Chromium's `new-window` disposition -
  // the SSO/login dialogs) get a separate window, while `target="_blank"`
  // links and bare/`noopener` `window.open` calls load in this same view so
  // the chat pane always describes what the one authenticated view is showing
  // (see `windowOpenPolicy.ts` / `windowOpenRouter.ts`).
  const windowOpenRouter = createWindowOpenRouter(options.viewSession);
  windowOpenRouter.attachTo(view.webContents);

  // Remote content gets the Chrome-shaped right-click menu (the app has no
  // native menu bar). "Open link" loads in this same view - no second window.
  attachChromeContextMenu(view.webContents, options.window, {
    openLink: (url) => openUrlInView(view.webContents, url),
  });

  // Ctrl+Shift+I must keep working while the browser pane has focus - the menu
  // accelerator it replaces was window-scoped, not webContents-scoped. It still
  // toggles the *shell's* DevTools (the menu role's own target); the browser page's
  // DevTools are reached through the context menu's "Inspect" instead.
  attachDevToolsShortcut(view.webContents, options.window.webContents);

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

  // The URL a main-frame navigation is heading to, captured from
  // `did-start-navigation` while the new document has not committed yet.
  // `getURL()` keeps reporting the *committed* document until then, so without
  // this an in-page link's target could not reach the address bar until the
  // navigation had effectively finished - unlike a toolbar-initiated
  // navigation, whose target the toolbar already knows. Cleared once the
  // navigation commits or the load settles, so the address bar falls back to
  // the live URL.
  let pendingNavigationUrl: string | undefined;

  // Whether a document has ever *committed* in this view - set from the two
  // main-frame commit events (`did-navigate`/`did-navigate-in-page`), never
  // from `did-stop-loading` (which also fires for a failed load). Monotonic:
  // once a document is committed, a later failed navigation leaves the
  // renderer with a page to fall back to, so there is no transition back to
  // "no document" within a session. See `browserNavigationStateSchema`'s
  // `hasDocument` doc comment.
  let hasDocument = false;

  function getNavigationState(): BrowserNavigationState {
    const history = view.webContents.navigationHistory;
    return {
      url: pendingNavigationUrl ?? view.webContents.getURL(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      isLoading: view.webContents.isLoading(),
      hasDocument,
    };
  }

  function pushNavigationState(): void {
    if (destroyed) return;
    options.onNavigationStateChange(getNavigationState());
  }

  function onStartNavigation(
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
  ): void {
    // Sub-frame navigation does not change the address bar's document, and the
    // same scheme-only http(s) rule that guards the view's own top-level
    // navigation keeps an empty/about:blank start from surfacing as an address.
    if (!details.isMainFrame || decideAllowedUrl(details.url).kind !== 'allow') return;
    pendingNavigationUrl = details.url;
    pushNavigationState();
  }

  // The new document has committed (did-navigate/did-navigate-in-page) or the
  // load has settled (did-stop-loading): the live URL is authoritative again,
  // so the pending target is dropped before the state is pushed.
  function onNavigationSettled(): void {
    pendingNavigationUrl = undefined;
    pushNavigationState();
  }

  // A main-frame commit means there is now a document to show; record it before
  // the state push below so `hasDocument` is true in the very push that reports
  // the commit.
  function onCommitted(): void {
    hasDocument = true;
    onNavigationSettled();
  }

  view.webContents.on('did-start-navigation', onStartNavigation);
  view.webContents.on('did-navigate', onCommitted);
  view.webContents.on('did-navigate-in-page', onCommitted);
  view.webContents.on('did-start-loading', pushNavigationState);
  view.webContents.on('did-stop-loading', onNavigationSettled);

  // How long a chrome-initiated goBack/goForward/reload waits to see whether
  // it produced any navigation at all before giving up and reporting `ok`.
  // Only reached by a command that triggers no load (e.g. Refresh before any
  // page has ever loaded) - a real navigation fires `did-start-loading`
  // essentially synchronously, long before this elapses.
  const NAVIGATION_START_GRACE_MS = 200;

  /**
   * Runs `command` (a `goBack`/`goForward`/`reload` call) and resolves once
   * its navigation settles, translating a genuine failure into a structured
   * {@link ChromeNavigationOutcome} instead of the fire-and-forget `void`
   * these commands used to be. This is what makes a reload/back/forward of a
   * down server explicit to the caller (`browserController.ts`) the same way
   * `switchServer`'s `loadURL` rejection already is - previously `did-fail-
   * load` was not observed at all for these three commands, so the renderer
   * never learned the reload failed and the error banner from an earlier
   * failed navigation, once dismissed, never came back.
   *
   * `did-fail-load` can fire more than once for a single command (main frame
   * plus subframes) and can also fire for a merely-*cancelled* load (a Stop,
   * or a newer navigation superseding this one) with `ERR_ABORTED`/
   * `ERR_FAILED` - exactly the two codes the renderer's own
   * `handleVoidResult` already treats as "not a real error"
   * (`browserToolbar.ts`). Both are filtered out here so cancellation is
   * never reported as a network failure; only a genuine main-frame failure
   * is kept, and only the first one, since every command triggers exactly
   * one top-level navigation.
   */
  function runNavigationCommand(command: () => void): Promise<ChromeNavigationOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let started = false;
      let failure: { errorCode: string; failedUrl: string } | undefined;

      function cleanup(): void {
        view.webContents.removeListener('did-start-loading', onStartLoading);
        view.webContents.removeListener('did-fail-load', onFailLoad);
        view.webContents.removeListener('did-stop-loading', onStopLoading);
        clearTimeout(graceTimer);
      }

      function finish(outcome: ChromeNavigationOutcome): void {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(outcome);
      }

      function onStartLoading(): void {
        started = true;
      }

      function onFailLoad(
        _event: unknown,
        _errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean,
      ): void {
        if (!isMainFrame || settled || failure !== undefined) return;
        const code = extractChromiumErrorCodeFromText(errorDescription);
        if (code === undefined || code === 'ERR_ABORTED' || code === 'ERR_FAILED') return;
        failure = { errorCode: code, failedUrl: validatedURL };
      }

      function onStopLoading(): void {
        finish(failure ? { ok: false, ...failure } : { ok: true });
      }

      view.webContents.on('did-start-loading', onStartLoading);
      view.webContents.on('did-fail-load', onFailLoad);
      view.webContents.on('did-stop-loading', onStopLoading);

      const graceTimer = setTimeout(() => {
        if (!started) finish({ ok: true });
      }, NAVIGATION_START_GRACE_MS);

      command();
    });
  }

  // Top-level navigation guard for the browser view itself: http(s) only. Cross-
  // *origin* http(s) navigation is deliberately still allowed here (an SSO
  // redirect chain legitimately leaves the host origin for an IdP origin and
  // comes back), matching `decideAllowedUrl`'s own scheme-only (not origin)
  // restriction - reused here rather than duplicated so every entry point into
  // the view enforces identically the one rule that actually matters for this
  // guard.
  view.webContents.on('will-navigate', (navigationEvent, targetUrl) => {
    if (decideAllowedUrl(targetUrl).kind !== 'allow') {
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
    view.webContents.removeListener('preload-error', onPreloadError);
    windowOpenRouter.closeAll();
    if (!options.window.isDestroyed()) {
      options.window.contentView.removeChildView(view);
    }
    if (!view.webContents.isDestroyed()) {
      view.webContents.close();
    }
  }

  return {
    webContents: view.webContents,
    windowOpenRouter,
    setBounds,
    getNavigationState,
    goBack: () => runNavigationCommand(() => view.webContents.navigationHistory.goBack()),
    goForward: () => runNavigationCommand(() => view.webContents.navigationHistory.goForward()),
    reload: () => runNavigationCommand(() => view.webContents.reload()),
    stop: () => view.webContents.stop(),
    loadURL: (url: string) => view.webContents.loadURL(url),
    destroy,
  };
}
