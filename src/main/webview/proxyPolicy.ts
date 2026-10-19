import type { ProxyConfig as ElectronProxyConfig } from 'electron';
import type { ProxyConfig } from '../../shared';

/**
 * host proxy configuration and the sequential-switch requirement
 * (implementation-plan.md step 05; requirements-decisions.md section 4:
 * "host switching is sequential: ... apply the new proxy
 * configuration, close previous connections, and then load the new
 * address"; docs/verification.md "Step 05 prerequisite - technical gate
 * G3", proxy half).
 *
 * Only the type `ProxyConfig` is imported from `electron` here - a
 * compile-time-only import, erased at build time by `verbatimModuleSyntax` -
 * so every function in this file runs and is testable under plain Node,
 * with no real Electron process required.
 */

export interface ProxySwitchOptions {
  /**
   * Chromium bypasses the proxy for loopback targets (127.0.0.1/localhost)
   * by default. A real corporate host is essentially never on
   * loopback, so leaving Chromium's default in place is correct there; the
   * project's own G3 loopback E2E matrix (`tests/e2e/g3-proxy-scope.spec.ts`)
   * is entirely loopback-only, and needs the opposite - every proxy traffic
   * must reach the local test proxy, which sits on loopback too. Rather than
   * silently defaulting one way or the other, this is an explicit,
   * documented opt-in: set it only for a loopback test fixture, never for a
   * real deployment, where bypassing loopback is the safer default (it stops
   * an attacker-controlled proxy setting from intercepting the app's own
   * local traffic).
   */
  readonly bypassLoopbackForTesting?: boolean;
}

/** The raw `proxyRules` string for one host proxy. Pure, so it is unit-testable without Electron. */
export function buildProxyRules(proxy: ProxyConfig): string {
  // No scheme prefix: an un-prefixed rule applies to every URL scheme,
  // including HTTPS via CONNECT, matching requirements-decisions.md section 4
  // ("An explicit HTTP proxy, HTTPS through CONNECT"). `proxy.url` is already
  // a canonical origin (`originSchema`), so it is exactly one proxy address.
  return proxy.url;
}

/**
 * Builds the `session.setProxy()` input for `proxy`, or explicit direct mode
 * when `proxy` is `undefined` - requirements-decisions.md section 4: "No
 * proxy configured -> Explicit direct mode. Do not pick up an incidental
 * proxy from the user's CLI configuration." `mode: "direct"` is exactly that:
 * it does not fall through to Chromium's `system`/`auto_detect` modes, which
 * would do the opposite of "explicit".
 */
export function buildProxyConfig(
  proxy: ProxyConfig | undefined,
  options: ProxySwitchOptions = {},
): ElectronProxyConfig {
  if (proxy === undefined) {
    return { mode: 'direct' };
  }
  if (options.bypassLoopbackForTesting === true) {
    return {
      mode: 'fixed_servers',
      proxyRules: buildProxyRules(proxy),
      proxyBypassRules: '<-loopback>',
    };
  }
  return { mode: 'fixed_servers', proxyRules: buildProxyRules(proxy) };
}

/** The proxy's host and port, as reported by a `login` event's `authInfo` for comparison in `proxyAuth.ts`. */
export interface ProxyTarget {
  readonly host: string;
  readonly port: number;
}

/**
 * Extracts the host/port `proxyAuth.ts` must match a proxy authentication
 * challenge against. `proxy.url` is a canonical origin (`originSchema`),
 * which omits the port when it is the scheme's default - so the default must
 * be reconstructed here rather than assumed present.
 */
export function extractProxyTarget(proxy: ProxyConfig): ProxyTarget {
  const url = new URL(proxy.url);
  const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return { host: url.hostname, port };
}

/**
 * The two `session` capabilities a proxy switch needs, narrowed from the
 * full Electron `Session` so this is constructible with a plain fake in
 * tests. A real `Session` satisfies this structurally without any cast.
 */
export interface ProxySwitchSession {
  setProxy(config: ElectronProxyConfig): Promise<void>;
  closeAllConnections(): Promise<void>;
}

/**
 * Performs the sequential proxy switch requirements-decisions.md section 4
 * mandates: await `setProxy`, THEN await `closeAllConnections`, and only
 * after both resolve does this function return - callers must not begin
 * loading the new server's address before that, per
 * implementation-plan.md's "Await `setProxy`/`closeAllConnections`; do not
 * reuse old sockets or old WebContents." `closeAllConnections()` is required
 * here independent of whether it is ever strictly necessary for proxy
 * correctness alone (docs/verification.md's "Constraint 2" found no leaking
 * old-proxy socket in the G3 experiments) because it is unconditionally
 * required for certificate-exception revocation (see
 * `certificateExceptions.ts`) whenever a certificate exception changes as
 * part of the same server switch, and matches the sequence
 * requirements-decisions.md section 4 mandates regardless.
 */
export async function applyProxySwitch(
  session: ProxySwitchSession,
  proxy: ProxyConfig | undefined,
  options: ProxySwitchOptions = {},
): Promise<void> {
  await session.setProxy(buildProxyConfig(proxy, options));
  await session.closeAllConnections();
}

/**
 * The `setProxy`-only half of {@link applyProxySwitch}, for the
 * per-navigation proxy reconciliation `browserController.ts` performs when the
 * view lands on an origin whose effective proxy differs from the one currently
 * applied (a cross-origin SSO redirect, or a page-initiated navigation away
 * from a configured host).
 *
 * Deliberately does NOT call `closeAllConnections()`: this runs while a
 * navigation is in flight, and closing every connection would abort the very
 * load it is trying to steer. The full sequential switch (which *does* close
 * connections, per requirements-decisions.md section 4) remains
 * {@link applyProxySwitch}, used for explicit server switches.
 */
export async function applySessionProxy(
  session: Pick<ProxySwitchSession, 'setProxy'>,
  proxy: ProxyConfig | undefined,
  options: ProxySwitchOptions = {},
): Promise<void> {
  await session.setProxy(buildProxyConfig(proxy, options));
}
