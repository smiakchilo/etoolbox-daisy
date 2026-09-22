import { app } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import {
  BROWSER_CERTIFICATE_BLOCKED_CHANNEL,
  BROWSER_STATE_CHANGED_CHANNEL,
  BROWSER_SWITCH_STATE_CHANGED_CHANNEL,
} from '../../shared';
import type {
  ApproveCertificateExceptionRequest,
  BrowserIpcError,
  BrowserIpcVoidResult,
  ViewBounds,
} from '../../shared';
import type { AppSettings } from '../../shared';
import type { ProxyConfig, ServerId } from '../../shared';
import { parseNavigationTarget } from '../../shared';
import { applyServerTargetingChange, loadSettings, saveSettings } from '../settingsStore';
import type { AemSession } from '../aem';
import type { ProxyPlainCredentials } from '../aem';
import { resolveEffectiveProxy } from '../aem';
import type { SecretStore } from '../secretStore';
import { toLoggableUrl, type DiagnosticCode, type Logger } from '../logger';
import {
  createAemBrowserView,
  type AemBrowserView,
  type AemBrowserViewOptions,
  type ChromeNavigationOutcome,
} from './aemBrowserView';
import { ServerSwitchController } from './serverSwitch';
import { describeNetworkError } from './networkErrorCopy';
import { decideAddressNavigation } from './unknownOrigin';
import { createCertificateBlockedListener } from './certificatePrompt';
import { attachProxyReconciliation } from './proxyReconciliation';
import {
  attachNavigationEpochTracking,
  createNavigationEpochTracker,
  type NavigationEpochBumpReason,
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
 * which exercises it through the `createAemView` seam below instead of a
 * real `WebContentsView`/`screen`.
 */
export interface BrowserControllerOptions {
  readonly settingsDir: string;
  readonly secretStore: SecretStore;
  readonly logger: Logger;
  readonly aemSession: AemSession;
  readonly window: BrowserWindow;
  readonly aemPreloadPath: string;
  /** The app's own chat-pane renderer `WebContents` - the only trusted push target. */
  readonly rendererWebContents: WebContents;
  /**
   * Test seam: overrides how the AEM `WebContentsView` is constructed.
   * Defaults to the real {@link createAemBrowserView}. Unit tests inject a
   * fake `AemBrowserView` here so this module's own orchestration logic -
   * decision dispatch, settings persistence, certificate handling - can be
   * exercised without a real Electron `WebContentsView`/`screen`/
   * `BrowserWindow`.
   */
  readonly createAemView?: (viewOptions: AemBrowserViewOptions) => AemBrowserView;
}

/**
 * The identity of the AEM server the view is currently showing - the
 * "where do requests go" fact the AEM tool pipeline (`src/main/index.ts`)
 * binds every `aem_get_json` call to. Deliberately a narrower projection of
 * `ServerConfig` than the full config: only the fields a tool request needs
 * to address and stamp itself (`bridgeBroker.ts`'s `CurrentAemContext`,
 * `aemTool.ts`'s `CurrentAemToolContext`), never proxy/TLS/label/colour.
 */
export interface ActiveAemServer {
  readonly serverId: ServerId;
  readonly origin: string;
  readonly revision: number;
}

export interface BrowserController {
  readonly aemView: AemBrowserView;
  /**
   * Which document the AEM view is currently showing. The tool broker stamps
   * every outgoing request with `current()` and refuses any reply that no
   * longer matches, so that a result produced by a page the user has since
   * navigated away from is never presented as describing the page they are
   * looking at now.
   */
  readonly navigationEpoch: NavigationEpochTracker;
  /**
   * The server the AEM view is currently showing, or `undefined` when none
   * has been selected yet (no server configured, or the view has not
   * switched to one in this run). Reflects the settings this controller
   * itself most recently read or wrote via `switchServer`/`navigate` or a
   * certificate-exception change to the active server - never a fabricated
   * placeholder. It does NOT observe settings changes made through the
   * separate Settings IPC surface (`ipc/settings.ts`), which has no channel
   * back into this controller; that is a pre-existing gap in cross-module
   * settings sync, not something this accessor papers over.
   */
  activeServer(): ActiveAemServer | undefined;
  /**
   * The URL of the document the AEM view is currently showing, or `undefined`
   * when it has none (no page loaded yet, an empty `about:blank` start, or a
   * destroyed view). Read fresh on every call: this is what the agent's
   * per-prompt page context is derived from, so it must describe where the
   * user is right now rather than where they were when a chat opened.
   */
  currentDocumentUrl(): string | undefined;
  navigate(rawValue: string): Promise<BrowserIpcVoidResult>;
  switchServer(serverId: ServerId): Promise<BrowserIpcVoidResult>;
  goBack(): Promise<BrowserIpcVoidResult>;
  goForward(): Promise<BrowserIpcVoidResult>;
  reload(): Promise<BrowserIpcVoidResult>;
  /** Stops any in-flight load in the AEM view (the toolbar's Stop control while a navigation is loading). */
  stop(): BrowserIpcVoidResult;
  setViewBounds(bounds: ViewBounds): void;
  approveCertificateException(
    request: ApproveCertificateExceptionRequest,
  ): Promise<BrowserIpcVoidResult>;
  /** Re-applies every persisted TLS exception to the live session. Call once at startup, before the AEM view loads anything. */
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

function toActiveServer(server: AppSettings['hosts'][number]): ActiveAemServer {
  return { serverId: server.id, origin: server.origin, revision: server.revision };
}

/**
 * Resolves a proxy-library entry's password into plaintext, if one is
 * configured. `secretStore.get` is async, which is why this exists as its own
 * step run *before* `ServerSwitchController.switchTo` rather than inline in
 * `resolveProxyCredentials` below - `AemSession.switchProxy`'s
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
  const { settingsDir, secretStore, logger, aemSession, window, rendererWebContents } = options;

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

  // The proxy-library entry currently applied to the AEM session, or
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

  // The server the AEM view is currently showing, or `undefined` before the
  // first successful `switchServer`/`navigate` in this run. Updated here -
  // not re-derived from disk on every read - because `activeServer()` must
  // be synchronous (it backs `AgentChatControllerDeps.currentAemServerContext`,
  // itself read fresh on every tool call - see that interface's doc comment)
  // while settings I/O is not. See `BrowserController.activeServer`'s own doc
  // comment for what this does and does not track.
  let activeServerState: ActiveAemServer | undefined;

  const buildAemView = options.createAemView ?? createAemBrowserView;
  const aemView = buildAemView({
    window,
    aemSession: aemSession.session,
    aemPreloadPath: options.aemPreloadPath,
    logger,
    onNavigationStateChange: (state) => {
      rendererWebContents.send(BROWSER_STATE_CHANGED_CHANNEL, state);
    },
  });

  const navigationEpoch = createNavigationEpochTracker();

  /**
   * Whether `url` is on the active AEM server's own origin. A same-origin
   * navigation changes the page but not the AEM context, so it must not
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
    aemView.webContents,
    navigationEpoch,
    {
      isSameOriginNavigation,
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
  const detachProxyReconciliation = attachProxyReconciliation(aemView.webContents, (url) => {
    reconcileProxyForUrl(url);
  });

  const switchController = new ServerSwitchController({
    getView: () => aemView,
    closePopups: () => aemView.windowOpenRouter.closeAll(),
    aemSession: {
      switchProxy: (proxy, resolveCredentials) => aemSession.switchProxy(proxy, resolveCredentials),
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
    aemSession: aemSession.session,
    listExceptions: () => aemSession.listCertificateExceptions(),
    onBlocked: (info, url) => {
      logger.warn('BROWSER_CERTIFICATE_BLOCKED');
      certificateRetryTarget = { url, origin: info.origin };
      rendererWebContents.send(BROWSER_CERTIFICATE_BLOCKED_CHANNEL, info);
    },
  });
  // A second, purely observational `certificate-error` listener alongside
  // the AEM session's own decisive one - see `certificatePrompt.ts`'s module
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
      await aemSession.applyProxy(proxy, () => currentCredentials);
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

  async function switchServer(
    serverId: ServerId,
    targetUrl?: string,
  ): Promise<BrowserIpcVoidResult> {
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

    // Bumped *before* the switch is attempted, not after it succeeds. From this
    // point the view is no longer reliably showing the document that any
    // in-flight tool request was issued against, and a request invalidated by a
    // switch that then fails is the harmless direction of the error - whereas a
    // reply from the outgoing server accepted as describing the incoming one is
    // not. `did-start-navigation` also fires during the switch and bumps again;
    // the epoch only has to move forward, never to move exactly once.
    navigationEpoch.bump('server_switch');

    const outcome = await switchController.switchTo(server, targetUrl);
    if (!outcome.ok) {
      // Whatever the view now shows - a half-loaded document, an error page,
      // or (for "already_switching") whatever a *different* in-flight switch
      // leaves it showing - it is not reliably `server`, so no server is
      // reported as active rather than leaving a stale or guessed one in
      // place. Mirrors the epoch bump just above: the same event that makes
      // in-flight requests untrustworthy makes the "which server is this"
      // answer untrustworthy too.
      activeServerState = undefined;
      // The proxy may or may not have been applied before the failure, so
      // forget what is in effect and let the next navigation reconcile it.
      appliedProxyKey = undefined;
      if (outcome.reason === 'network_error') {
        // Checked first (rather than last) because "network_error" is the
        // only union member with a single-literal `reason`; narrowing on it
        // positively lets the compiler exclude this whole member from what
        // remains below, instead of trying to narrow a property that is
        // itself a union (`"already_switching" | "no_active_view"`) via two
        // sequential equality checks.
        //
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
      if (outcome.reason === 'already_switching') {
        return fail({
          code: 'switch_in_progress',
          message: 'a server switch is already in progress',
        });
      }
      return fail({ code: 'no_active_view', message: 'no AEM view is available' });
    }
    activeServerState = toActiveServer(server);
    appliedProxyKey = currentProxy?.id ?? '';
    logger.info('BROWSER_SWITCH_COMPLETED');
    return ok();
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
    await aemSession.approveCertificateException(request.exception);
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
    const url = aemView.getNavigationState().url;
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
        await aemSession.approveCertificateException(server.tlsException);
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
   * (`aemBrowserView.ts`) for the bug this closes: a dismissed error banner
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

  async function goBack(): Promise<BrowserIpcVoidResult> {
    return mapNavigationOutcome(await aemView.goBack());
  }
  async function goForward(): Promise<BrowserIpcVoidResult> {
    return mapNavigationOutcome(await aemView.goForward());
  }
  async function reload(): Promise<BrowserIpcVoidResult> {
    return mapNavigationOutcome(await aemView.reload());
  }
  function stop(): BrowserIpcVoidResult {
    aemView.stop();
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
    aemView.destroy();
  }

  return {
    aemView,
    navigationEpoch,
    activeServer: () => activeServerState,
    currentDocumentUrl,
    navigate,
    switchServer,
    goBack,
    goForward,
    reload,
    stop,
    setViewBounds: (bounds) => aemView.setBounds(bounds),
    approveCertificateException,
    hydrateCertificateExceptions,
    destroy,
  };
}
