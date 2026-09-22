import { originsMatch, parseNavigationTarget } from '../../shared';
import type { ServerConfig } from '../../shared';

/**
 * The unknown-origin policy (implementation-plan.md step 05;
 * requirements-decisions.md section 3: "An origin typed manually that is not
 * a configured server must prompt the user to add a server - never silently
 * navigate and never auto-create the entry").
 *
 * This function is deliberately the *only* place that policy is decided, and
 * it is deliberately never consulted for anything except a manually-typed
 * address. That is what makes it correct rather than merely convenient: an
 * SSO redirect chain or a popup request routed in place is page-driven
 * navigation happening on the already-loaded `WebContentsView` (see
 * `aemBrowserView.ts`'s navigation guard and `windowOpenRouter.ts`), which
 * never calls this function at all - there is no redirect-chain heuristic to
 * get subtly wrong ("was this origin reached via N hops from a configured
 * server?"), because the two cases are distinguished by *how* the navigation
 * was initiated, not by inspecting where it ends up. A user typing an address
 * always goes through `browser:navigate` (this module); a page redirecting
 * itself never does.
 */
export type AddressNavigationDecision =
  | { readonly kind: 'navigate'; readonly server: ServerConfig; readonly url: string }
  | { readonly kind: 'invalid_address' }
  | { readonly kind: 'unknown_origin'; readonly origin: string };

/**
 * Decides what a manually-typed address-bar value means against the
 * currently configured servers. Plain HTTP is accepted here exactly when (and
 * only when) it resolves to a configured server - "explicitly configured",
 * per requirements-decisions.md section 4, means a `ServerConfig` entry
 * already exists for it, never that the user merely typed an `http://`
 * address once.
 *
 * Authorization is decided on the *origin* alone, while the returned `url`
 * carries the full path the user asked for. A path can never widen access:
 * whatever it contains, the request still goes to an origin that already has
 * a `ServerConfig`, so the unknown-origin prompt cannot be sidestepped by
 * appending one.
 */
export function decideAddressNavigation(
  value: string,
  servers: readonly ServerConfig[],
): AddressNavigationDecision {
  const parsed = parseNavigationTarget(value);
  if (!parsed.ok) {
    return { kind: 'invalid_address' };
  }
  const match = servers.find((server) => originsMatch(server.origin, parsed.origin));
  if (!match) {
    return { kind: 'unknown_origin', origin: parsed.origin };
  }
  return { kind: 'navigate', server: match, url: parsed.url };
}
