import { HOST_PROXY_NONE, originsMatch } from '../../shared';
import type { AppSettings, ProxyConfig } from '../../shared';

/**
 * Per-origin proxy resolution for the AEM pane
 * (implementation-plan.md step 05; requirements-decisions.md section 4).
 *
 * A Chromium proxy setting applies to the whole session, so "which proxy
 * applies" is answered per *origin*: the AEM view reconciles the session proxy
 * whenever it lands on a new origin, and this module is the one place that
 * decision is made. It is pure and Electron-free, so the policy is directly
 * unit-testable.
 *
 * The rules, in order:
 *
 *  1. If `origin` matches a configured host, that host's `proxyId` decides:
 *     an explicit library entry is used, `HOST_PROXY_NONE` means a direct
 *     connection, and an absent `proxyId` means "(Default)" - fall through to
 *     rule 2.
 *  2. Otherwise (an origin with no configured host, e.g. Adobe's IMS login
 *     origin during an SSO redirect), the `browser.proxy` default is used, or
 *     a direct connection when there is none.
 *
 * A host therefore only ever *overrides* the default; it never implicitly
 * inherits the active agent's proxy or another host's (requirements-decisions
 * section 4: proxies are never implicitly inherited between the AEM and
 * Copilot sides).
 */
export function findProxyEntry(
  settings: AppSettings,
  proxyId: string | undefined,
): ProxyConfig | undefined {
  if (proxyId === undefined || proxyId === HOST_PROXY_NONE) return undefined;
  return settings.proxies.find((proxy) => proxy.id === proxyId);
}

/**
 * The library entry the AEM view should reach `origin` through, or `undefined`
 * for an explicit direct connection. See this module's doc comment for the
 * rules.
 */
export function resolveEffectiveProxy(
  settings: AppSettings,
  origin: string,
): ProxyConfig | undefined {
  const host = settings.hosts.find((candidate) => originsMatch(candidate.origin, origin));
  if (host !== undefined && host.proxyId !== undefined) {
    // An explicit selection (a real entry, or "No proxy") always wins over the
    // default; only an absent `proxyId` falls through to `browser.proxy`.
    return findProxyEntry(settings, host.proxyId);
  }
  return findProxyEntry(settings, settings.browser.proxy);
}
