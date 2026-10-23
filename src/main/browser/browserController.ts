import { app, shell } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import {
  APP_SHORTCUT_CHANNEL,
  BROWSER_AGENT_NAVIGATION_CHANNEL,
  BROWSER_CERTIFICATE_BLOCKED_CHANNEL,
  BROWSER_FIND_RESULT_CHANNEL,
  BROWSER_STATE_CHANGED_CHANNEL,
  BROWSER_SWITCH_STATE_CHANGED_CHANNEL,
} from '../../shared';
import type {
  AppShortcutAction,
  ApproveCertificateExceptionRequest,
  BrowserIpcError,
  BrowserIpcVoidResult,
  FindRequest,
  FindTarget,
  OpenExternalRequest,
  OpenPageOutcome,
  OpenPageTarget,
  StopFindRequest,
  ViewBounds,
} from '../../shared';
import type { AppSettings } from '../../shared';
import type { ProxyConfig, ServerId } from '../../shared';
import {
  buildNavigationUrl,
  looksLikeLoginUrl,
  parseNavigationTarget,
  validateBrowserPath,
} from '../../shared';
import { applyServerTargetingChange, loadSettings, saveSettings } from '../settingsStore';
import type { ViewSession } from '../webview';
import type { ProxyPlainCredentials } from '../webview';
import { resolveEffectiveProxy } from '../webview';
import type { SecretStore } from '../secretStore';
import { toLoggableUrl, type DiagnosticCode, type Logger } from '../logger';
import { attachShortcutHandling } from '../shortcuts';
import {
  createHostView,
  type HostView,
  type HostViewOptions,
  type ChromeNavigationOutcome,
} from './hostView';
import { ServerSwitchController } from './serverSwitch';
import { describeNetworkError } from './networkErrorCopy';
import { decideAddressNavigation } from './unknownOrigin';
import { createCertificateBlockedListener } from './certificatePrompt';
import { attachProxyReconciliation } from './proxyReconciliation';
import {
  attachNavigationEpochTracking,
  createNavigationEpochTracker,
  type NavigationEpochBumpReason,
  type NavigationEpochInitiator,
  type NavigationEpochTracker,
} from './navigationEpoch';

/**
 * One diagnostic code per epoch-invalidation cause, so a cancelled turn can be
 * told apart from a user Stop in `logs/app.log`: any of these lines immediately
 * before a turn's `cancelling` means the cancellation was automatic, and its
 * code says which event caused it. `BROWSER_SWITCH_STARTED` doubles as the
 * server-switch bump's marker (a switch is the only thing that bumps with
 * `server_switch`).
 */
const NAVIGATION_LOG_CODE_BY_REASON: Readonly<Record<NavigationEpochBumpReason, DiagnosticCode>> = {
  document_navigation: 'BROWSER_NAVIGATION',
  server_switch: 'BROWSER_SWITCH_STARTED',
  render_process_gone: 'BROWSER_RENDER_PROCESS_GONE',
  view_destroyed: 'BROWSER_VIEW_DESTROYED',
};

/**
 * Top-level orchestrator for the browser shell (implementation-plan.md step
 * 05). Everything under `src/main/browser/` up to this point is Electron-
 * light and independently unit-tested; this module composes those pieces
 * plus `settingsStore`/`secretStore` into the one object `src/main/index.ts`
 * needs. Unlike `windows.ts`/`security.ts`/`session.ts`, it does carry
 * decision logic worth testing directly (`navigate`/`switchServer`'s
 * dispatch to the right `BrowserIpcError`, certificate-exception
 * persistence) - see `tests/unit/main/browser/browserController.test.ts`,
 * which exercises it through the `createView` seam below instead of a
 * real `WebContentsView`/`screen`.
 */
export interface BrowserControllerOptions {
  readonly settingsDir: string;
  readonly secretStore: SecretStore;
  readonly logger: Logger;
  readonly viewSession: ViewSession;
  readonly window: BrowserWindow;
  readonly webviewPreloadPath: string;
  /** The app's own chat-pane renderer `WebContents` - the only trusted push target. */
  readonly rendererWebContents: WebContents;
  /** Called after the user zoomed the app shell (not the browser page), to persist its level. */
  readonly onShellZoomChanged?: () => void;
  /**
   * Test seam: overrides how the browser `WebContentsView` is constructed.
   * Defaults to the real {@link createHostView}. Unit tests inject a
   * fake `HostView` here so this module's own orchestration logic -
   * decision dispatch, settings persistence, certificate handling - can be
   * exercised without a real Electron `WebContentsView`/`screen`/
   * `BrowserWindow`.
   */
  readonly createView?: (viewOptions: HostViewOptions) => HostView;
}

/**
 * The identity of the host the view is currently showing - the
 * "where do requests go" fact the tool pipeline (`src/main/index.ts`)
 * binds every `aem_get_json` call to. Deliberately a narrower projection of
 * `ServerConfig` than the full config: only the fields a tool request needs
 * to address and stamp itself (`bridgeBroker.ts`'s `CurrentBridgeContext`,
 * `toolModule.ts`'s `CurrentToolContext`), never proxy/TLS/label/colour.
 */
export interface ActiveHost {
  readonly serverId: ServerId;
  readonly origin: string;
  readonly revision: number;
}

export interface BrowserController {
  readonly hostView: HostView;
  /**
   * Which document the browser view is currently showing. The tool broker stamps
   * every outgoing request with `current()` and refuses any reply that no
   * longer matches, so that a result produced by a page the user has since
   * navigated away from is never presented as describing the page they are
   * looking at now.
   */
  readonly navigationEpoch: NavigationEpochTracker;
  /**
   * The server the browser view is currently showing, or `undefined` when none
   * has been selected yet (no server configured, or the view has not
   * switched to one in this run). Reflects the settings this controller
   * itself most recently read or wrote via `switchServer`/`navigate` or a
   * certificate-exception change to the active server - never a fabricated
   * placeholder. It does NOT observe settings changes made through the
   * separate Settings IPC surface (`ipc/settings.ts`), which has no channel
   * back into this controller; that is a pre-existing gap in cross-module
   * settings sync, not something this accessor papers over.
   */
  activeServer(): ActiveHost | undefined;
  /**
   * The URL of the document the browser view is currently showing, or `undefined`
   * when it has none (no page loaded yet, an empty `about:blank` start, or a
   * destroyed view). Read fresh on every call: this is what the agent's
   * per-prompt page context is derived from, so it must describe where the
   * user is right now rather than where they were when a chat opened.
   */
  currentDocumentUrl(): string | undefined;
  navigate(rawValue: string): Promise<BrowserIpcVoidResult>;
  /**
   * Opens a page on a configured host for the agent (`browser_navigate`). The
   * origin is resolved here from `target.serverId`, never from the tool's
   * arguments. This is an *agent-initiated* navigation: it still bumps the
   * epoch (so in-flight requests from the previous document are discarded),
   * but it does not cancel the agent's own turn - that is the whole point, so
   * the model can resolve a page name on a host it has just moved to.
   */
  openForAgent(target: OpenPageTarget): Promise<OpenPageOutcome>;
  /**
   * Opens a transcript link's URL in the OS default browser. The URL is
   * re-validated here (http(s), no userinfo) so the renderer can never drive an
   * arbitrary `shell.openExternal` - the same narrow, reviewed command
   * `security.ts`'s deny-by-default window guard requires.
   */
  openExternal(request: OpenExternalRequest): Promise<BrowserIpcVoidResult>;
  switchServer(serverId: ServerId): Promise<BrowserIpcVoidResult>;
  goBack(): Promise<BrowserIpcVoidResult>;
  goForward(): Promise<BrowserIpcVoidResult>;
  reload(): Promise<BrowserIpcVoidResult>;
  /**
   * Reloads the open page on the application's own initiative - the answer to a
   * host that stopped recognising the user, so the pane shows the sign-in
   * screen. Like `openForAgent` it is agent-initiated: it does not cancel the
   * running turn. Resolves `false`, doing nothing, when a reload would help
   * nobody: the pane is not on `serverId`'s host, is mid-switch, or already
   * shows a sign-in page.
   */
  reloadForAgent(serverId: ServerId): Promise<boolean>;
  /** Stops any in-flight load in the browser view (the toolbar's Stop control while a navigation is loading). */
  stop(): BrowserIpcVoidResult;
  setViewBounds(bounds: ViewBounds): void;
  /**
   * Runs a `findInPage` request against the named document (`browser` = the host
   * view, `chat` = the shell document). The match count is not returned here; it
   * arrives asynchronously on the target's `found-in-page` event, which is
   * pushed to the shell renderer as `browser:find-result`.
   */
  find(request: FindRequest): BrowserIpcVoidResult;
  /** Ends the target document's find session and clears its highlight. */
  stopFind(request: StopFindRequest): BrowserIpcVoidResult;
  approveCertificateException(
    request: ApproveCertificateExceptionRequest,
  ): Promise<BrowserIpcVoidResult>;
  /** Re-applies every persisted TLS exception to the live session. Call once at startup, before the browser view loads anything. */
  hydrateCertificateExceptions(): Promise<void>;
  destroy(): void;
}

function ok(): BrowserIpcVoidResult {
  return { ok: true };
}
function fail(error: BrowserIpcError): BrowserIpcVoidResult {
  return { ok: false, error };
}
function storageError(message: string): BrowserIpcError {
  return { code: 'storage_error', message };
}

function toActiveServer(server: AppSettings['hosts'][number]): ActiveHost {
  return { serverId: server.id, origin: server.origin, revision: server.revision };
}

/**
 * Converts the renderer's reserved-region rectangle from CSS pixels to
 * device-independent pixels. The two are equal only at 100% page zoom; at any
 * other shell zoom one CSS pixel covers `zoomFactor` DIP, and
 * `WebContentsView.setBounds` speaks DIP. Without this the native view would
 * drift off its slot the moment the shell's text was zoomed.
 */
function scaleBounds(bounds: ViewBounds, factor: number): ViewBounds {
  return {
    x: Math.round(bounds.x * factor),
    y: Math.round(bounds.y * factor),
    width: Math.round(bounds.width * factor),
    height: Math.round(bounds.height * factor),
  };
}

/**
 * Resolves a proxy-library entry's password into plaintext, if one is
 * configured. `secretStore.get` is async, which is why this exists as its own
 * step run *before* `ServerSwitchController.switchTo` rather than inline in
 * `resolveProxyCredentials` below - `ViewSession.switchProxy`'s
 * `resolveCredentials` parameter must be callable synchronously (Electron's
 * `login` event callback is synchronous), so the plaintext value has to
 * already be sitting in memory by the time that closure is invoked.
 */
async function resolveProxyCredentials(
  proxy: ProxyConfig | undefined,
  secretStore: SecretStore,
): Promise<ProxyPlainCredentials | undefined> {
  const credentials = proxy?.credentials;
  if (!credentials) return undefined;
  const password = await secretStore.get(credentials.secretRef);
  if (password === undefined) return undefined;
  return { username: credentials.username, password };
}

export function createBrowserController(options: BrowserControllerOptions): BrowserController {
  const { settingsDir, secretStore, logger, viewSession, window, rendererWebContents } = options;

  // Holds the most recently resolved plaintext credentials for whichever
  // server is currently selected. `switchProxy` stores the closure below,
  // not a value, and calls it fresh on every proxy challenge - but since
  // that call must be synchronous, the actual secret lookup happens ahead of
  // time (in `switchServer`) and is only ever read back out of this cell.
  // Rotating a password without switching servers again requires the
  // "requires_safe_transition" outcome from `applyServerTargetingChange`
  // (settingsStore.ts) to trigger a fresh `switchServer` call for the same
  // server id - not implemented by this module itself, which only owns the
  // switch mechanism, not settings-mutation IPC.
  let currentCredentials: ProxyPlainCredentials | undefined;

  // The proxy-library entry currently applied to the browser session, or
  // `undefined` for a direct connection. `switchProxy`/`applyProxy` store the
  // credentials closure, not the value, so this cell is what that closure
  // reads; it is also what `resolveProxy` hands to `ServerSwitchController`.
  let currentProxy: ProxyConfig | undefined;

  // Which proxy is actually in effect on the session: a library id, `""` for
  // an explicit direct connection, or `undefined` when nothing has been
  // applied yet (the session is then still on Chromium's own default, so the
  // first navigation always reconciles). Compared before every per-navigation
  // re-application so a navigation that stays on the same proxy costs nothing.
  let appliedProxyKey: string | undefined;

  // The full URL of the navigation that was most recently blocked by an
  // untrusted certificate, if any. Set by the observational
  // `certificate-error` listener; consumed by `approveCertificateException`
  // to auto-retry exactly what the human was trying to reach (a deep link,
  // not just the server root), and cleared by any *new* navigation so a stale
  // target is never retried after the user has moved on.
  let certificateRetryTarget: { readonly url: string; readonly origin: string } | undefined;

  // The server the browser view is currently showing, or `undefined` before the
  // first successful `switchServer`/`navigate` in this run. Updated here -
  // not re-derived from disk on every read - because `activeServer()` must
  // be synchronous (it backs `AgentChatControllerDeps.currentHostContext`,
  // itself read fresh on every tool call - see that interface's doc comment)
  // while settings I/O is not. See `BrowserController.activeServer`'s own doc
  // comment for what this does and does not track.
  let activeServerState: ActiveHost | undefined;

  /**
   * Set only while `openForAgent` is deliberately moving the pane for the
   * agent. `attachNavigationEpochTracking`'s `bumpInitiator` reads it, so the
   * switch's own load - and any SSO redirect hop it follows, which is *not* the
   * target URL - is attributed to the agent rather than to the user. Any
   * user-initiated navigation entry point clears it, so a user navigation
   * arriving mid-switch is attributed to the user (and cancels the turn, as it
   * always did).
   */
  let agentNavigation: { readonly targetOrigin: string } | undefined;

  const buildView = options.createView ?? createHostView;
  const hostView = buildView({
    window,
    viewSession: viewSession.session,
    webviewPreloadPath: options.webviewPreloadPath,
    logger,
    onNavigationStateChange: (state) => {
      rendererWebContents.send(BROWSER_STATE_CHANGED_CHANNEL, state);
    },
  });

  // Application-wide keyboard shortcuts, without a menu bar (`src/main/shortcuts.ts`).
  // Attached to *both* `WebContents`: the browser pane is a `WebContentsView`, so a
  // keystroke there never reaches the shell document, and a renderer-only
  // listener would silently do nothing while the browser page has focus. Every
  // resolved action is pushed to the shell renderer, which dispatches it onto
  // its existing handlers; the chat-pane actions are bound on the shell only, so
  // the remote authoring page keeps its own `Ctrl+<letter>` editing shortcuts.
  const sendShortcut = (action: AppShortcutAction): void => {
    rendererWebContents.send(APP_SHORTCUT_CHANNEL, action);
  };
  const focusShell = (): void => rendererWebContents.focus();
  attachShortcutHandling(hostView.webContents, {
    allowChatShortcuts: false,
    send: sendShortcut,
    focusShell,
  });
  attachShortcutHandling(rendererWebContents, {
    allowChatShortcuts: true,
    send: sendShortcut,
    focusShell,
    ...(options.onShellZoomChanged ? { onZoomChanged: options.onShellZoomChanged } : {}),
  });

  // ── Zoom ────────────────────────────────────────────────────────────────
  // Zoom is per-`WebContents` and applied by the shortcut layer
  // (`applyZoom` from `src/main/zoom.ts`), which runs on whichever view the
  // keystroke landed on. 'isolated' keeps each view's level its own (not shared
  // per origin). Not 'manual': in that mode setZoomLevel changes the reported
  // factor but never zooms the page, so the factor-scaled view bounds drifted
  // away from an unzoomed layout. Ctrl+wheel is deliberately not a zoom
  // gesture; Electron only emits `zoom-changed` for it and this app ignores it.
  hostView.webContents.setZoomMode('isolated');
  rendererWebContents.setZoomMode('isolated');

  // ── Find-in-page ────────────────────────────────────────────────────────
  // Both find targets are `WebContents` main owns; the renderer names one
  // logically (`browser` / `chat`) and never touches a view directly. Each
  // target's `found-in-page` results are forwarded to the shell renderer, which
  // routes them to the matching find bar.
  const findTargetContents = (target: FindTarget): WebContents =>
    target === 'browser' ? hostView.webContents : rendererWebContents;
  // The most recent request id issued per target, so a late result from a
  // superseded request is dropped rather than overwriting a newer count.
  let browserFindRequestId = -1;
  let chatFindRequestId = -1;
  interface FoundInPageResult {
    readonly requestId: number;
    readonly matches: number;
    readonly activeMatchOrdinal: number;
  }
  const onFoundInPage = (_event: unknown, result: FoundInPageResult): void => {
    if (result.requestId !== browserFindRequestId) return;
    rendererWebContents.send(BROWSER_FIND_RESULT_CHANNEL, {
      target: 'browser',
      matches: result.matches,
      activeMatchOrdinal: result.activeMatchOrdinal,
    });
  };
  const onShellFoundInPage = (_event: unknown, result: FoundInPageResult): void => {
    if (result.requestId !== chatFindRequestId) return;
    rendererWebContents.send(BROWSER_FIND_RESULT_CHANNEL, {
      target: 'chat',
      matches: result.matches,
      activeMatchOrdinal: result.activeMatchOrdinal,
    });
  };
  hostView.webContents.on('found-in-page', onFoundInPage);
  rendererWebContents.on('found-in-page', onShellFoundInPage);

  function find(request: FindRequest): BrowserIpcVoidResult {
    const contents = findTargetContents(request.target);
    if (contents.isDestroyed()) {
      return fail({ code: 'no_active_view', message: 'there is no view to search' });
    }
    const requestId = contents.findInPage(request.text, {
      forward: request.forward,
      // Electron 44 emits `found-in-page` only for a request carrying
      // `findNext: true` (verified against the built app: `false` produces no
      // result at all). A changed `text` restarts the session at the first
      // match, an unchanged one advances - which is exactly the new-query vs
      // step distinction, expressed by the text alone. See `findRequestSchema`.
      findNext: true,
    });
    if (request.target === 'browser') browserFindRequestId = requestId;
    else chatFindRequestId = requestId;
    return ok();
  }

  function stopFind(request: StopFindRequest): BrowserIpcVoidResult {
    const contents = findTargetContents(request.target);
    if (!contents.isDestroyed()) contents.stopFindInPage('clearSelection');
    return ok();
  }

  const navigationEpoch = createNavigationEpochTracker();

  /**
   * Whether `url` is on the active host's own origin. A same-origin
   * navigation changes the page but not the page context, so it must not
   * invalidate in-flight tool requests or cancel the agent's turn - see
   * `NavigationEpochTrackingOptions`. `false` when no server is active, which
   * makes every navigation invalidate (the safe direction: there is no
   * in-flight turn to preserve in that state anyway).
   */
  function isSameOriginNavigation(url: unknown): boolean {
    // Defensive: an event payload without a URL must not throw inside a
    // listener. A missing URL is treated as "not known same-origin", which
    // invalidates - the safe direction.
    if (typeof url !== 'string') return false;
    const active = activeServerState;
    if (active === undefined) return false;
    const target = parseNavigationTarget(url);
    return target.ok && target.origin === active.origin;
  }

  const detachNavigationEpoch = attachNavigationEpochTracking(
    hostView.webContents,
    navigationEpoch,
    {
      isSameOriginNavigation,
      // While the agent owns the navigation, its load (and any SSO redirect
      // hop) is the agent's; otherwise a bumping navigation is the user's.
      bumpInitiator: () => (agentNavigation !== undefined ? 'agent' : 'user'),
      onSameOriginNavigation: (url) => {
        logger.info('BROWSER_NAVIGATION', { url: toLoggableUrl(url) });
      },
    },
  );

  // Every epoch invalidation is logged with its cause, so an automatic turn
  // cancellation is traceable. The same-origin case is logged by the callback
  // above instead (it does not bump).
  const detachNavigationLog = navigationEpoch.subscribe((change) => {
    logger.info(NAVIGATION_LOG_CODE_BY_REASON[change.reason]);
  });

  // Per-origin proxy reconciliation (requirement 4): whenever the main frame
  // navigates - including a cross-origin SSO redirect - the session proxy is
  // brought in line with the effective proxy for the destination origin, so
  // the view observes the proxy that matches the origin of the current request
  // (a configured host's own selection, or the `browser.proxy` default for an
  // origin that is not a host, e.g. Adobe's IMS).
  const detachProxyReconciliation = attachProxyReconciliation(hostView.webContents, (url) => {
    reconcileProxyForUrl(url);
  });

  const switchController = new ServerSwitchController({
    getView: () => hostView,
    closePopups: () => hostView.windowOpenRouter.closeAll(),
    viewSession: {
      switchProxy: (proxy, resolveCredentials) =>
        viewSession.switchProxy(proxy, resolveCredentials),
    },
    resolveProxy: () => currentProxy,
    resolveProxyCredentials: () => () => currentCredentials,
    onStateChange: (state) => {
      rendererWebContents.send(BROWSER_SWITCH_STATE_CHANGED_CHANNEL, {
        switching: state === 'switching',
      });
    },
  });

  const certificateBlockedListener = createCertificateBlockedListener({
    viewSession: viewSession.session,
    listExceptions: () => viewSession.listCertificateExceptions(),
    onBlocked: (info, url) => {
      logger.warn('BROWSER_CERTIFICATE_BLOCKED');
      certificateRetryTarget = { url, origin: info.origin };
      rendererWebContents.send(BROWSER_CERTIFICATE_BLOCKED_CHANNEL, info);
    },
  });
  // A second, purely observational `certificate-error` listener alongside
  // the browser session's own decisive one - see `certificatePrompt.ts`'s module
  // comment for why registering a second listener is safe here.
  app.on('certificate-error', certificateBlockedListener);

  async function loadSettingsOrThrow(): Promise<AppSettings> {
    const loaded = await loadSettings(settingsDir);
    if (!loaded.ok) {
      throw new Error(loaded.error.message);
    }
    return loaded.value.settings;
  }

  /**
   * Re-applies the session proxy if `origin` resolves to a different proxy than
   * the one currently in effect (requirement 4). Reads settings fresh, so a
   * proxy changed in Settings is honoured on the view's next navigation without
   * a restart. Best-effort: a failed settings read or `setProxy` leaves the
   * previous proxy in place rather than aborting the navigation.
   *
   * Deliberately does not `closeAllConnections()` (see `applyProxy` in
   * `session.ts`): this runs mid-navigation, and closing every connection would
   * abort the very load being steered.
   */
  async function reconcileProxyForOrigin(origin: string): Promise<void> {
    let settings: AppSettings;
    try {
      settings = await loadSettingsOrThrow();
    } catch {
      return;
    }
    const proxy = resolveEffectiveProxy(settings, origin);
    const key = proxy?.id ?? '';
    if (key === appliedProxyKey) return;

    const credentials = await resolveProxyCredentials(proxy, secretStore);
    currentProxy = proxy;
    currentCredentials = credentials;
    try {
      await viewSession.applyProxy(proxy, () => currentCredentials);
      appliedProxyKey = key;
    } catch {
      // Unknown state: force the next navigation to re-apply rather than
      // trusting a proxy that may not have taken effect.
      appliedProxyKey = undefined;
    }
  }

  /** {@link reconcileProxyForOrigin} for a raw navigation URL; a non-URL value is ignored. */
  function reconcileProxyForUrl(rawUrl: string): void {
    // Defensive: an event payload without a URL (an odd emitter, a future
    // Electron shape) must not throw inside an event listener.
    if (typeof rawUrl !== 'string') return;
    const target = parseNavigationTarget(rawUrl);
    if (!target.ok) return;
    void reconcileProxyForOrigin(target.origin);
  }

  async function navigate(rawValue: string): Promise<BrowserIpcVoidResult> {
    // Any user-initiated navigation supersedes a pending certificate-retry
    // target (the renderer's prompt was dismissed by this navigation).
    certificateRetryTarget = undefined;
    let settings: AppSettings;
    try {
      settings = await loadSettingsOrThrow();
    } catch (error) {
      return fail(storageError(error instanceof Error ? error.message : String(error)));
    }
    const decision = decideAddressNavigation(rawValue, settings.hosts);
    if (decision.kind === 'invalid_address') {
      return fail({ code: 'invalid_address', message: `not a valid address: ${rawValue}` });
    }
    if (decision.kind === 'unknown_origin') {
      return fail({
        code: 'unknown_origin',
        message: `${decision.origin} is not a configured server`,
        origin: decision.origin,
      });
    }
    return switchServer(decision.server.id, decision.url);
  }

  /**
   * Hands a validated absolute http(s) URL to the OS default browser. Only the
   * scheme and userinfo are checked (`parseNavigationTarget`); the origin is
   * deliberately not restricted to a configured host, because the whole point
   * is to leave the app for an origin the app does not manage. The validation
   * is what stops a model-authored link from reaching `shell.openExternal` as
   * `file:`/`javascript:`/a custom scheme.
   */
  async function openExternal(request: OpenExternalRequest): Promise<BrowserIpcVoidResult> {
    const parsed = parseNavigationTarget(request.url);
    if (!parsed.ok) {
      return fail({
        code: 'invalid_address',
        message: `not a valid http(s) address: ${request.url}`,
      });
    }
    try {
      await shell.openExternal(parsed.url);
    } catch (error) {
      logger.warn('BROWSER_OPEN_EXTERNAL_FAILED');
      return fail({
        code: 'open_external_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return ok();
  }

  async function switchServer(
    serverId: ServerId,
    targetUrl?: string,
    initiator: NavigationEpochInitiator = 'user',
  ): Promise<BrowserIpcVoidResult> {
    // A user-initiated switch takes the navigation away from the agent: any
    // later bumping navigation is the user's, not a continuation of an agent
    // switch. (An agent switch keeps `agentNavigation` set - `openForAgent`
    // owns that cell.)
    if (initiator === 'user') {
      agentNavigation = undefined;
    }
    // Any user-initiated switch supersedes a pending certificate-retry
    // target (the renderer's prompt was dismissed by this switch).
    certificateRetryTarget = undefined;
    let settings: AppSettings;
    try {
      settings = await loadSettingsOrThrow();
    } catch (error) {
      return fail(storageError(error instanceof Error ? error.message : String(error)));
    }
    const server = settings.hosts.find((candidate) => candidate.id === serverId);
    if (!server) {
      return fail({ code: 'server_not_found', message: `no server with id ${serverId}` });
    }

    // The effective proxy for this host: its own `proxyId` selection, or the
    // `browser.proxy` default when the host has no explicit one. `undefined`
    // means a direct connection.
    currentProxy = resolveEffectiveProxy(settings, server.origin);
    currentCredentials = await resolveProxyCredentials(currentProxy, secretStore);
    // The switch below is about to apply exactly this proxy, so record it as
    // in effect *before* the load starts: the switch's own
    // `did-start-navigation` would otherwise see an unknown key and issue a
    // redundant `applyProxy`. A failure resets it to unknown, so the next
    // navigation re-applies rather than trusting a proxy that may not have
    // taken effect.
    appliedProxyKey = currentProxy?.id ?? '';

    // A same-origin navigation - a transcript link, a CRX/Edit popover, a typed
    // same-host address, a host re-select - changes the page, not the page's
    // context (same origin, same session, same request target), so it must
    // neither invalidate in-flight tool requests nor cancel the agent's turn.
    // This is the *same* rule the Chromium `did-start-navigation` listener
    // applies through `isSameOriginNavigation`; that listener also logs the load
    // as `BROWSER_NAVIGATION`, so a skipped bump here is not silent. A switch to
    // a different origin - or any switch while no server is active - still
    // bumps.
    //
    // Bumped *before* the switch is attempted, not after it succeeds. From this
    // point the view is no longer reliably showing the document that any
    // in-flight tool request was issued against, and a request invalidated by a
    // switch that then fails is the harmless direction of the error - whereas a
    // reply from the outgoing server accepted as describing the incoming one is
    // not. `did-start-navigation` also fires during the switch and bumps again;
    // the epoch only has to move forward, never to move exactly once.
    if (!isSameOriginNavigation(targetUrl ?? server.origin)) {
      navigationEpoch.bump('server_switch', initiator);
    }

    const outcome = await switchController.switchTo(server, targetUrl);
    if (!outcome.ok) {
      if (outcome.reason === 'superseded') {
        // A newer navigation replaced this one before it reached its load, so
        // there is nothing to report and nothing to roll back: the
        // superseding switch owns the active-server/proxy state and will
        // report its own result. Returning a failure here would paint a
        // spurious error row for a navigation the user already replaced.
        logger.info('BROWSER_SWITCH_SUPERSEDED');
        return ok();
      }
      // Whatever the view now shows - a half-loaded document, an error page,
      // or (for "no_active_view") nothing - it is not reliably `server`, so
      // no server is reported as active rather than leaving a stale or
      // guessed one in place. Mirrors the epoch bump just above: the same
      // event that makes in-flight requests untrustworthy makes the "which
      // server is this" answer untrustworthy too.
      //
      // The one exception is a *cancelled* load (`ERR_ABORTED`/`ERR_FAILED`:
      // an SSO redirect or a page-initiated navigation took over). The pane is
      // then showing a real document, the renderer treats it as no error at
      // all, and nothing would ever re-derive the server - so read it back
      // from the view instead of leaving every tool call without a host.
      if (
        outcome.reason === 'network_error' &&
        (outcome.errorCode === 'ERR_ABORTED' || outcome.errorCode === 'ERR_FAILED')
      ) {
        await refreshActiveServerFromView();
      } else {
        activeServerState = undefined;
      }
      // The proxy may or may not have been applied before the failure, so
      // forget what is in effect and let the next navigation reconcile it.
      appliedProxyKey = undefined;
      if (outcome.reason === 'network_error') {
        // The proxy switch or page load rejected with a Chromium `ERR_*`
        // error (see `serverSwitch.ts`'s `extractChromiumErrorCode` doc
        // comment). Surfaced as a structured result carrying that code, not
        // as a thrown error that would escape `ipcMain.handle` as a generic
        // Error the renderer cannot branch on.
        logger.warn('BROWSER_SWITCH_FAILED');
        return fail({
          code: 'network_error',
          // The raw Chromium rejection ("ERR_CONNECTION_REFUSED (-102) loading
          // ...") is kept on `errorCode` for programmatic branching; the
          // message a user sees is the humanised copy (`networkErrorCopy.ts`),
          // built from the code and the address this switch actually tried to
          // load (`targetUrl` when one was given, the server origin otherwise).
          message: describeNetworkError(outcome.errorCode, targetUrl ?? server.origin),
          errorCode: outcome.errorCode,
        });
      }
      return fail({ code: 'no_active_view', message: 'no browser view is available' });
    }
    activeServerState = toActiveServer(server);
    appliedProxyKey = currentProxy?.id ?? '';
    logger.info('BROWSER_SWITCH_COMPLETED');
    return ok();
  }

  /** Two origins' hosts (hostname and port), tolerating an http->https redirect. */
  function sameHost(left: string, right: string): boolean {
    const strip = (origin: string): string => origin.replace(/^https?:\/\//i, '');
    return strip(left) === strip(right);
  }

  /**
   * The agent's navigation capability (`ToolHost.openPage`). Resolves the host
   * from settings, validates the path, and performs an *agent-initiated*
   * switch. `agentNavigation` is set for the whole switch, so the epoch bumps it
   * causes - including an SSO redirect hop, which is not the target URL - are
   * attributed to the agent rather than to the user.
   *
   * A user navigation arriving meanwhile clears `agentNavigation` (via
   * `switchServer`/`goBack`/...), supersedes this switch, and so still cancels
   * the turn. After the switch settles, if the pane did not land on the target
   * host - a supersede, or a page-initiated navigation during the window - the
   * epoch is bumped as a *user* navigation, so an in-page link click mid-switch
   * still cancels the turn.
   *
   * Before the load begins it pushes `browser:agent-navigation`, so the
   * renderer reveals the destination: the agent navigated for the user, so a
   * whole-size panel (Settings, History, the hosts picker) or the home veil
   * must not be left covering the new page.
   */
  async function openForAgent(target: OpenPageTarget): Promise<OpenPageOutcome> {
    let settings: AppSettings;
    try {
      settings = await loadSettingsOrThrow();
    } catch {
      return { kind: 'storage_error' };
    }
    const server = settings.hosts.find((candidate) => candidate.id === target.serverId);
    if (server === undefined) return { kind: 'server_not_found' };

    const path = validateBrowserPath(target.path);
    if (!path.ok) return { kind: 'invalid_path' };
    const built = buildNavigationUrl({ origin: server.origin, path: path.value });
    if (!built.ok) return { kind: 'invalid_path' };

    const switched = !isSameOriginNavigation(built.value);
    // The agent is moving the pane on the user's behalf, so the destination
    // must be visible: tell the renderer to dismiss any whole-size panel (or
    // the home veil) covering the page-view region *before* the load begins,
    // exactly as an external navigation like a transcript link already does.
    // Sent only once the target has validated, so an invalid path or an
    // unknown server reveals nothing.
    rendererWebContents.send(BROWSER_AGENT_NAVIGATION_CHANNEL);
    agentNavigation = { targetOrigin: server.origin };
    try {
      const result = await switchServer(server.id, built.value, 'agent');
      if (!result.ok) {
        switch (result.error.code) {
          case 'network_error':
            return {
              kind: 'network_error',
              errorCode: result.error.errorCode ?? '',
              message: result.error.message,
            };
          case 'server_not_found':
            return { kind: 'server_not_found' };
          case 'storage_error':
            return { kind: 'storage_error' };
          default:
            return { kind: 'no_view' };
        }
      }
      // `switchServer` reports a superseded switch as success (the newer
      // navigation owns the outcome), so confirm the pane actually landed on
      // the target host rather than trusting the return value.
      const landed = currentDocumentUrl();
      const landedTarget = landed === undefined ? undefined : parseNavigationTarget(landed);
      const onTarget =
        activeServerState?.serverId === server.id &&
        landedTarget !== undefined &&
        landedTarget.ok &&
        sameHost(landedTarget.origin, server.origin);
      if (!onTarget || landed === undefined) {
        navigationEpoch.bump('document_navigation', 'user');
        return { kind: 'cancelled' };
      }
      return { kind: 'opened', url: landed, switched };
    } finally {
      agentNavigation = undefined;
    }
  }

  async function withPersistedTlsException(
    serverId: ServerId,
    tlsException: ApproveCertificateExceptionRequest['exception'],
  ): Promise<BrowserIpcVoidResult> {
    let settings: AppSettings;
    try {
      settings = await loadSettingsOrThrow();
    } catch (error) {
      return fail(storageError(error instanceof Error ? error.message : String(error)));
    }
    const outcome = applyServerTargetingChange(settings, serverId, { tlsException });
    if (!outcome.ok) {
      if (outcome.error.kind === 'server_not_found') {
        return fail({ code: 'server_not_found', message: outcome.error.message });
      }
      return fail(storageError(outcome.error.message));
    }
    const saved = await saveSettings(settingsDir, outcome.value.settings);
    if (!saved.ok) {
      return fail(storageError(saved.error.message));
    }
    if (activeServerState !== undefined && activeServerState.serverId === serverId) {
      // A TLS-exception change bumps the server's `revision` (see
      // `applyServerTargetingChange`), and the active server is the one this
      // just changed - keep the reported revision current so a tool request
      // made right after approving a certificate exception is stamped with
      // the revision that is actually now in effect, not a value that is one
      // change stale.
      const updatedServer = outcome.value.settings.hosts.find(
        (candidate) => candidate.id === serverId,
      );
      if (updatedServer !== undefined) {
        activeServerState = toActiveServer(updatedServer);
      }
    }
    return ok();
  }

  async function approveCertificateException(
    request: ApproveCertificateExceptionRequest,
  ): Promise<BrowserIpcVoidResult> {
    // Persist first: if saving fails, the live session is never told about an
    // exception that would not survive a restart.
    const persisted = await withPersistedTlsException(request.serverId, request.exception);
    if (!persisted.ok) return persisted;
    await viewSession.approveCertificateException(request.exception);
    // Auto-retry the navigation that was blocked, if the approval covers the
    // origin it was for (a stale target whose origin differs is dropped, not
    // reused). `navigate` clears the target itself, so it is captured first.
    const retryTarget = certificateRetryTarget;
    if (retryTarget !== undefined && retryTarget.origin === request.exception.origin) {
      const retried = await navigate(retryTarget.url);
      if (!retried.ok) {
        // A load failure in the retry surfaces through the normal
        // navigation-state push (the toolbar shows it as its usual error
        // row), so a retry failure must not flip the otherwise-successful
        // approval result - but it should be visible in the log.
        logger.warn('BROWSER_CERTIFICATE_RETRY_FAILED');
      }
    }
    logger.info('BROWSER_CERTIFICATE_APPROVED');
    return ok();
  }

  /**
   * The URL of the document the view is showing right now, or `undefined` for
   * an empty URL. Deliberately narrow: the agent's page context
   * (`deriveCurrentPageContext`) decides same-origin and content-path safety
   * from this raw value, so nothing is normalized or filtered here.
   */
  function currentDocumentUrl(): string | undefined {
    const url = hostView.getNavigationState().url;
    return url.length > 0 ? url : undefined;
  }

  async function hydrateCertificateExceptions(): Promise<void> {
    let settings: AppSettings;
    try {
      settings = await loadSettingsOrThrow();
    } catch {
      // Reuses the existing "settings file could not be read/parsed" code -
      // hydration failing for that reason is the same underlying fact as
      // `SETTINGS_FILE_CORRUPT`, just observed from a different call site.
      logger.error('SETTINGS_FILE_CORRUPT', { outcome: 'failure' });
      return;
    }
    for (const server of settings.hosts) {
      if (server.tlsException) {
        await viewSession.approveCertificateException(server.tlsException);
      }
    }
  }

  /**
   * Maps a `goBack`/`goForward`/`reload` outcome to the same
   * `BrowserIpcVoidResult` shape `switchServer`'s `network_error` branch
   * produces, reusing the identical humanised copy (`describeNetworkError`).
   * Before this existed, these three commands always returned `ok()`
   * immediately and a failure surfacing later via `did-fail-load` was never
   * reported at all - see `ChromeNavigationOutcome`'s doc comment
   * (`hostView.ts`) for the bug this closes: a dismissed error banner
   * from an earlier failed navigation never reappeared on a same-cause
   * reload/back/forward, because nothing set `errorText` again.
   */
  function mapNavigationOutcome(outcome: ChromeNavigationOutcome): BrowserIpcVoidResult {
    if (outcome.ok) return ok();
    return fail({
      code: 'network_error',
      message: describeNetworkError(outcome.errorCode, outcome.failedUrl),
      errorCode: outcome.errorCode,
    });
  }

  /**
   * Re-derives which server is active from the document the view is now
   * showing, if it is on a configured host. A `goBack`/`goForward`/`reload`
   * success does not go through `switchServer`, so without this the active
   * server would stay stale (Back to a different host) or unset (the renderer
   * restores the previous page after a failed switch with a history back).
   * A URL whose origin is not a configured host - an SSO/IdP hop, a blank
   * view - clears the active server, exactly as `switchServer`'s failure path
   * does.
   */
  async function refreshActiveServerFromView(): Promise<void> {
    let settings: AppSettings;
    try {
      settings = await loadSettingsOrThrow();
    } catch {
      // A failed settings read must not fabricate an active server; leave the
      // previous answer rather than guessing.
      return;
    }
    // Read after the settings I/O, not before: overlapping refreshes (a commit
    // event racing a switch's own settle) must all evaluate the page the view is
    // on *now*, so whichever finishes last cannot write an older answer.
    const url = currentDocumentUrl();
    const target = url === undefined ? undefined : parseNavigationTarget(url);
    if (target === undefined || !target.ok) {
      activeServerState = undefined;
      return;
    }
    const host = settings.hosts.find((candidate) => candidate.origin === target.origin);
    activeServerState = host === undefined ? undefined : toActiveServer(host);
  }

  // A main-frame load that failed leaves Chromium's error page committed under
  // the failed URL. That page is not "the server", so `did-navigate` must not
  // adopt it. Set by `did-fail-load`, cleared when the next main-frame
  // navigation starts.
  let mainFrameLoadFailed = false;

  const onMainFrameNavigationStart = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
  ): void => {
    if (details.isMainFrame && !details.isSameDocument) mainFrameLoadFailed = false;
  };
  const onMainFrameLoadFailed = (
    _event: unknown,
    errorCode: number,
    _errorDescription: string,
    _validatedUrl: string,
    isMainFrame: boolean,
  ): void => {
    // -3 is Chromium's ERR_ABORTED: a cancelled load (an SSO redirect, a newer
    // navigation) that leaves a real document behind, not an error page.
    if (isMainFrame && errorCode !== -3) mainFrameLoadFailed = true;
  };

  /**
   * Keeps the active server in step with what the pane really shows. Without
   * this the active server only changed through `switchServer` and history
   * commands, so a host switch whose load was cancelled by an SSO redirect, or
   * a login that returned to the host on its own, left it unset while the page
   * was plainly a host - and every tool call then failed with "no host
   * is currently selected". A commit during a switch is skipped: the
   * switch writes the result itself when it settles.
   */
  const onMainFrameCommitted = (): void => {
    if (mainFrameLoadFailed || switchController.getState() === 'switching') return;
    void refreshActiveServerFromView();
  };
  hostView.webContents.on('did-start-navigation', onMainFrameNavigationStart);
  hostView.webContents.on('did-fail-load', onMainFrameLoadFailed);
  hostView.webContents.on('did-navigate', onMainFrameCommitted);

  /** A chrome history command that also re-derives the active server on success. */
  async function settleHistoryCommand(
    outcome: ChromeNavigationOutcome,
  ): Promise<BrowserIpcVoidResult> {
    const result = mapNavigationOutcome(outcome);
    if (result.ok) await refreshActiveServerFromView();
    return result;
  }

  async function goBack(): Promise<BrowserIpcVoidResult> {
    agentNavigation = undefined;
    return settleHistoryCommand(await hostView.goBack());
  }
  async function goForward(): Promise<BrowserIpcVoidResult> {
    agentNavigation = undefined;
    return settleHistoryCommand(await hostView.goForward());
  }
  async function reload(): Promise<BrowserIpcVoidResult> {
    agentNavigation = undefined;
    return settleHistoryCommand(await hostView.reload());
  }
  async function reloadForAgent(serverId: ServerId): Promise<boolean> {
    const url = currentDocumentUrl();
    const active = activeServerState;
    // A pane already showing a sign-in page, an identity provider, another host
    // or a navigation in progress has nothing to gain from a reload.
    if (
      url === undefined ||
      active === undefined ||
      active.serverId !== serverId ||
      switchController.getState() === 'switching' ||
      !isSameOriginNavigation(url) ||
      looksLikeLoginUrl(url)
    ) {
      return false;
    }
    rendererWebContents.send(BROWSER_AGENT_NAVIGATION_CHANNEL);
    agentNavigation = { targetOrigin: active.origin };
    try {
      await settleHistoryCommand(await hostView.reload());
      return true;
    } finally {
      agentNavigation = undefined;
    }
  }
  function stop(): BrowserIpcVoidResult {
    hostView.stop();
    return ok();
  }

  function destroy(): void {
    app.removeListener('certificate-error', certificateBlockedListener);
    // Bumped before the view goes away so anything still waiting on a reply
    // from it is invalidated rather than left pending against a dead frame.
    navigationEpoch.bump('view_destroyed');
    detachNavigationEpoch();
    detachNavigationLog();
    detachProxyReconciliation();
    if (!hostView.webContents.isDestroyed()) {
      hostView.webContents.off('did-start-navigation', onMainFrameNavigationStart);
      hostView.webContents.off('did-fail-load', onMainFrameLoadFailed);
      hostView.webContents.off('did-navigate', onMainFrameCommitted);
      hostView.webContents.off('found-in-page', onFoundInPage);
    }
    if (!rendererWebContents.isDestroyed()) {
      rendererWebContents.off('found-in-page', onShellFoundInPage);
    }
    hostView.destroy();
  }

  return {
    hostView,
    navigationEpoch,
    activeServer: () => activeServerState,
    currentDocumentUrl,
    navigate,
    openForAgent,
    openExternal,
    switchServer,
    goBack,
    goForward,
    reload,
    reloadForAgent,
    stop,
    setViewBounds(bounds: ViewBounds): void {
      // The renderer reports CSS pixels; the native view is positioned in DIP.
      // They coincide only at 100% shell zoom (see `scaleBounds`).
      const factor = rendererWebContents.getZoomFactor();
      hostView.setBounds(factor === 1 ? bounds : scaleBounds(bounds, factor));
    },
    find,
    stopFind,
    approveCertificateException,
    hydrateCertificateExceptions,
    destroy,
  };
}
