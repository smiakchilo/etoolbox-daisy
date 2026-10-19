import { app, session } from 'electron';
import type { Session } from 'electron';
import type { ProxyConfig } from '../../shared';
import { type Logger, toLoggableUrl } from '../logger';
import {
  createCertificateErrorListener,
  createCertificateExceptionStore,
  type CertificateExceptionRecord,
} from './certificateExceptions';
import { applyProxySwitch, applySessionProxy, type ProxySwitchOptions } from './proxyPolicy';
import { createProxyLoginListener, type ProxyPlainCredentials } from './proxyAuth';
import { createResponseHeaderFilter, type ResponseHeaderRule } from './responseHeaderFilter';
import { buildPersistCookieDetails, shouldPersistSessionCookie } from './sessionCookiePersistence';

/**
 * The single persistent browser session (implementation-plan.md step 05;
 * requirements-decisions.md section 3: "one shared, persistent Electron
 * session/profile for all host connections - not one partition per server").
 * A single shared profile, not one per configured server, is what lets a
 * proxy or certificate exception decision made for one server stay in effect
 * when the user switches to another server on the same origin, and is what
 * keeps `session.closeAllConnections()` (see `certificateExceptions.ts`,
 * `proxyPolicy.ts`) meaningfully scoped to "every host connection" rather than
 * needing to be replayed across N partitions.
 *
 * This module is intentionally the only one of the four that imports real
 * Electron *values* (`app`, `session`) rather than only types - it is pure
 * wiring, with no independently-interesting decision logic of its own to
 * unit-test; every security-relevant decision it wires together
 * (`decideCertificateTrust`, `decideProxyAuth`, `buildProxyConfig`) already
 * has its own direct unit tests in `certificateExceptions.ts`/
 * `proxyAuth.ts`/`proxyPolicy.ts`. This mirrors the existing convention in
 * `windows.ts`/`security.ts`/`csp.ts`, none of which have a dedicated unit
 * test file either.
 */
export const VIEW_SESSION_PARTITION = 'persist:webview';

/** The small API the window layer uses to route host connections through this session's proxy/certificate policy. */
export interface ViewSession {
  /** The underlying Electron session. The app's own UI must load from a different session, never this one - see requirements-decisions.md section 3. */
  readonly session: Session;

  /**
   * Performs the sequential proxy switch (`proxyPolicy.ts`'s
   * `applyProxySwitch`) and records which proxy is "selected" for
   * `proxyAuth.ts`'s challenge matching. `resolveCredentials` is stored, not
   * invoked, until an actual proxy `login` challenge arrives - it is called
   * fresh on every challenge, so a credential rotated after this call still
   * takes effect without a further `switchProxy` call.
   */
  switchProxy(
    proxy: ProxyConfig | undefined,
    resolveCredentials: () => ProxyPlainCredentials | undefined,
    options?: ProxySwitchOptions,
  ): Promise<void>;

  /**
   * Re-applies the proxy without closing connections, for the per-navigation
   * reconciliation `browserController.ts` performs when the view lands on an
   * origin whose effective proxy differs from the one currently applied.
   * `switchProxy` remains the sequential switch used for explicit server
   * changes (it closes connections); this is the lightweight sibling that
   * must not abort an in-flight navigation.
   */
  applyProxy(
    proxy: ProxyConfig | undefined,
    resolveCredentials: () => ProxyPlainCredentials | undefined,
    options?: ProxySwitchOptions,
  ): Promise<void>;

  /** Approves a certificate exception and closes all connections so the new decision takes effect immediately (see `certificateExceptions.ts`). */
  approveCertificateException(record: CertificateExceptionRecord): Promise<void>;

  listCertificateExceptions(): readonly CertificateExceptionRecord[];
}

export interface ViewSessionOptions {
  /** Optional diagnostics sink for a failed cookie promotion. */
  readonly logger?: Logger;
  /**
   * The response-header rules this session applies (`responseHeaderFilter.ts`).
   * Omitted uses the default rule list; supplying one here is how a future
   * host- or content-specific rule is switched on without touching the session
   * wiring.
   */
  readonly responseHeaderRules?: readonly ResponseHeaderRule[];
}

/**
 * Creates the one browser session for the app's lifetime and wires the
 * `certificate-error`/`login` policy onto it. Must be called at most once;
 * calling it twice would register two listener pairs on `app` for the same
 * partition, double-invoking every decision.
 *
 * Also promotes insecure *session* cookies to persistent ones (see
 * `sessionCookiePersistence.ts` for the exact rule and why): a plain-HTTP dev
 * instance mints AEM's `login-token` without an expiry, so without this a
 * developer re-authenticates on every launch.
 */
export function createViewSession(options: ViewSessionOptions = {}): ViewSession {
  const viewSession = session.fromPartition(VIEW_SESSION_PARTITION);
  const certificateStore = createCertificateExceptionStore(viewSession);
  const responseHeaderFilter = createResponseHeaderFilter(options.responseHeaderRules);

  // The browser pane is for reading and previewing, never for saving files (owner
  // decision: a DAM asset link is "a preview experience - not downloaded or
  // offered to download"). Every rule that rewrites a response runs here, before
  // Chromium decides whether the response is a document or a download; the
  // default rule (`responseHeaderFilter.ts`) drops an `attachment` disposition
  // from a renderable response, because AEM serves a DAM asset's own URL that way
  // and the link would otherwise become a download this session cancels.
  //
  // Electron keeps one `onHeadersReceived` listener per session, so a future
  // response rewrite must be a rule in that filter, never a second listener here.
  viewSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders;
    if (headers === undefined) {
      callback({});
      return;
    }
    const filtered = responseHeaderFilter.filter({
      url: details.url,
      responseHeaders: headers,
    });
    if (filtered === undefined) {
      callback({});
      return;
    }
    options.logger?.info('VIEW_RESPONSE_HEADERS_REWRITTEN', {
      url: toLoggableUrl(details.url),
      count: filtered.ruleIds.length,
    });
    callback({ responseHeaders: filtered.headers });
  });

  viewSession.on('will-download', (event) => {
    options.logger?.info('VIEW_DOWNLOAD_BLOCKED');
    event.preventDefault();
  });

  viewSession.cookies.on('changed', (_event, cookie, _cause, removed) => {
    if (!shouldPersistSessionCookie(cookie, removed)) return;
    const details = buildPersistCookieDetails(cookie, Date.now());
    if (details === undefined) return;
    // Re-setting a session cookie with an `expirationDate` is what writes it
    // to disk. The resulting `changed` event carries `session: false` and is
    // ignored here, so this cannot recurse. A rejection is non-fatal: the
    // login still works for this run, it just will not survive the next
    // launch - so it is logged, not thrown.
    void viewSession.cookies
      .set(details)
      .catch(() => options.logger?.warn('VIEW_SESSION_COOKIE_PERSIST_FAILED'));
  });

  let currentProxy: ProxyConfig | undefined;
  let currentResolveCredentials: () => ProxyPlainCredentials | undefined = () => undefined;

  app.on(
    'certificate-error',
    createCertificateErrorListener({ viewSession, store: certificateStore }),
  );

  app.on(
    'login',
    createProxyLoginListener({
      // A getter, not a plain field: `switchProxy` below mutates
      // `currentProxy` after this listener is created once, and the listener
      // must always see the latest selection rather than a snapshot from
      // registration time.
      get selectedProxy() {
        return currentProxy;
      },
      resolveCredentials: () => currentResolveCredentials(),
    }),
  );

  return {
    session: viewSession,

    async switchProxy(proxy, resolveCredentials, options) {
      await applyProxySwitch(viewSession, proxy, options);
      currentProxy = proxy;
      currentResolveCredentials = resolveCredentials;
    },

    async applyProxy(proxy, resolveCredentials, options) {
      await applySessionProxy(viewSession, proxy, options);
      currentProxy = proxy;
      currentResolveCredentials = resolveCredentials;
    },

    approveCertificateException: (record) => certificateStore.approve(record),
    listCertificateExceptions: () => certificateStore.list(),
  };
}
