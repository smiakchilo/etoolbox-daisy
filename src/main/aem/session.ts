import { app, session } from 'electron';
import type { Session } from 'electron';
import type { AemProxyConfig } from '../../shared';
import {
  createCertificateErrorListener,
  createCertificateExceptionStore,
  type CertificateExceptionRecord,
} from './certificateExceptions';
import { applyProxySwitch, type ProxySwitchOptions } from './proxyPolicy';
import { createProxyLoginListener, type ProxyPlainCredentials } from './proxyAuth';

/**
 * The single persistent AEM session (implementation-plan.md step 05;
 * requirements-decisions.md section 3: "one shared, persistent Electron
 * session/profile for all AEM connections - not one partition per server").
 * A single shared profile, not one per configured server, is what lets a
 * proxy or certificate exception decision made for one server stay in effect
 * when the user switches to another server on the same origin, and is what
 * keeps `session.closeAllConnections()` (see `certificateExceptions.ts`,
 * `proxyPolicy.ts`) meaningfully scoped to "every AEM connection" rather than
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
export const AEM_SESSION_PARTITION = 'persist:aem';

/** The small API the window layer uses to route AEM connections through this session's proxy/certificate policy. */
export interface AemSession {
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
    proxy: AemProxyConfig | undefined,
    resolveCredentials: () => ProxyPlainCredentials | undefined,
    options?: ProxySwitchOptions,
  ): Promise<void>;

  /** Approves a certificate exception and closes all connections so the new decision takes effect immediately (see `certificateExceptions.ts`). */
  approveCertificateException(record: CertificateExceptionRecord): Promise<void>;

  listCertificateExceptions(): readonly CertificateExceptionRecord[];
}

/**
 * Creates the one AEM session for the app's lifetime and wires the
 * `certificate-error`/`login` policy onto it. Must be called at most once;
 * calling it twice would register two listener pairs on `app` for the same
 * partition, double-invoking every decision.
 */
export function createAemSession(): AemSession {
  const aemSession = session.fromPartition(AEM_SESSION_PARTITION);
  const certificateStore = createCertificateExceptionStore(aemSession);

  let currentProxy: AemProxyConfig | undefined;
  let currentResolveCredentials: () => ProxyPlainCredentials | undefined = () => undefined;

  app.on(
    'certificate-error',
    createCertificateErrorListener({ aemSession, store: certificateStore }),
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
    session: aemSession,

    async switchProxy(proxy, resolveCredentials, options) {
      await applyProxySwitch(aemSession, proxy, options);
      currentProxy = proxy;
      currentResolveCredentials = resolveCredentials;
    },

    approveCertificateException: (record) => certificateStore.approve(record),
    listCertificateExceptions: () => certificateStore.list(),
  };
}
