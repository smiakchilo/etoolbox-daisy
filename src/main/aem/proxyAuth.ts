import { extractProxyTarget } from './proxyPolicy';
import type { ProxyConfig } from '../../shared';

/**
 * Proxy-vs-origin authentication disambiguation
 * (implementation-plan.md step 05; requirements-decisions.md section 4:
 * "supply proxy credentials only for the proxy challenge itself, never for
 * the AEM server's own login"; docs/verification.md "Step 05 prerequisite -
 * technical gate G3", finding 5).
 *
 * G3 proved this is reliably distinguishable at the Electron API level: a
 * `login` event's `authInfo` gives `isProxy`, `host`, `port`, `scheme`,
 * `realm`, and a real proxy 407 reported `isProxy:true, host:127.0.0.1,
 * port:<proxy port>` while a real AEM 401 on the very same machine reported
 * `isProxy:false, host:localhost, port:<origin port>`. This module turns
 * that observation into a policy that is deliberately conservative: it is
 * not enough for `isProxy` to be true, the challenge's host and port must
 * also match the *currently selected* proxy exactly. Requirements-decisions
 * section 4 explicitly calls out the case this guards against: an AEM
 * instance and the configured proxy happening to share a host but differ
 * only by port must never be confused for one another - matching `isProxy`
 * alone, without the host/port check, would not catch a compromised or
 * misconfigured proxy stack that claims `isProxy:true` for a non-proxy
 * origin.
 */

/** A `login` event's `authInfo`, reduced to the fields the decision needs. */
export interface ProxyLoginChallenge {
  readonly isProxy: boolean;
  readonly host: string;
  readonly port: number;
}

export type ProxyAuthDecision =
  { readonly supply: true } | { readonly supply: false; readonly reason: string };

/**
 * Decides whether `challenge` is the currently selected proxy's own
 * authentication challenge. Host comparison is case-insensitive (hostnames
 * are not case-sensitive); port comparison is exact. Pure and
 * Electron-free, so this security property is directly unit-testable.
 */
export function decideProxyAuth(
  challenge: ProxyLoginChallenge,
  selectedProxy: ProxyConfig | undefined,
): ProxyAuthDecision {
  if (!challenge.isProxy) {
    return { supply: false, reason: 'not_a_proxy_challenge' };
  }
  if (selectedProxy === undefined) {
    return { supply: false, reason: 'no_proxy_configured' };
  }
  const target = extractProxyTarget(selectedProxy);
  if (
    challenge.host.toLowerCase() !== target.host.toLowerCase() ||
    challenge.port !== target.port
  ) {
    return { supply: false, reason: 'host_or_port_mismatch' };
  }
  return { supply: true };
}

// ---------------------------------------------------------------------------
// Electron-facing wiring
// ---------------------------------------------------------------------------

/**
 * Narrow structural shapes, not Electron's real `Event`/`AuthInfo` types -
 * same rationale as `certificateExceptions.ts`'s `CertificateErrorEventLike`
 * family: a real `app.on("login", listener)` registration still type-checks
 * (Electron's real argument types are strictly more specific), and a unit
 * test can pass a plain object literal.
 */
export interface LoginEventLike {
  preventDefault(): void;
}

/** Already-resolved plaintext credentials for the current proxy. Resolving a `ProxyCredentials.secretRef` into this is the caller's job (via `secretStore.ts`), kept out of this module so it never has to know about secret storage. */
export interface ProxyPlainCredentials {
  readonly username: string;
  readonly password: string;
}

export type ProxyLoginListener = (
  event: LoginEventLike,
  webContents: unknown,
  // Electron's real `login` event carries this as its third argument,
  // ahead of `authInfo`; kept here (typed `unknown`, unused) purely so this
  // listener's parameter order/count matches `app.on("login", ...)`'s real
  // signature positionally - it is not read by this policy.
  authenticationResponseDetails: unknown,
  authInfo: ProxyLoginChallenge,
  callback: (username?: string, password?: string) => void,
) => void;

export interface ProxyLoginListenerDeps {
  readonly selectedProxy: ProxyConfig | undefined;
  /** Resolved lazily (not eagerly at listener-creation time) so a rotated secret is always read fresh for each challenge. */
  readonly resolveCredentials: () => ProxyPlainCredentials | undefined;
}

/**
 * Builds the `app.on("login", ...)` listener. Only ever *decides* in the
 * supply direction: `event.preventDefault()` + `callback(username, password)`.
 *
 * Every other path - an AEM or IdP 401, or a proxy challenge for which no
 * credentials are configured - simply returns, touching neither
 * `preventDefault()` nor `callback`. Per Electron's documented contract
 * ("The default behavior is to cancel all authentications. To override this
 * you should prevent the default behavior with `event.preventDefault()` and
 * call `callback(username, password)`"), returning cancels the authentication
 * and returns the auth error to the page - which is exactly the intended
 * outcome, and is not a hang.
 *
 * A bare `callback()` would reach the same outcome for a lone listener, but
 * `login` is an `app`-global event whose `callback` is one-time: a second
 * registered listener (a test harness, a later feature) would invoke the same
 * one-time callback and Electron throws `TypeError: One-time callback was
 * called more than once`, an uncaught main-process exception that surfaces as
 * a modal error dialog and wedges the app. Declining to answer unless we are
 * actually overriding the default removes that footgun - the same rule
 * `createCertificateErrorListener` follows for `certificate-error`.
 */
export function createProxyLoginListener(deps: ProxyLoginListenerDeps): ProxyLoginListener {
  return (event, _webContents, _authenticationResponseDetails, authInfo, callback) => {
    const decision = decideProxyAuth(authInfo, deps.selectedProxy);
    if (!decision.supply) {
      return;
    }
    const credentials = deps.resolveCredentials();
    if (credentials === undefined) {
      return;
    }
    event.preventDefault();
    callback(credentials.username, credentials.password);
  };
}
