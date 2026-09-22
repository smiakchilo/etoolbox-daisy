/**
 * The URL policy for the browser pane's remote content
 * (implementation-plan.md step 05; requirements-decisions.md section 3:
 * "Reject unexpected file:/custom schemes and arbitrary `shell.openExternal`
 * calls.").
 *
 * Everything the pane loads - a top-level navigation, a redirect chain, a
 * `target="_blank"` link or a `window.open` request - goes through this one
 * predicate first. Only `http:`/`https:` is allowed; `file:`, the app's own
 * `app:` scheme, `javascript:`, `data:`, a malformed URL and every other
 * non-http(s) value are rejected outright. This is deliberately the one
 * affirmative case the pane's `WebContentsView` permits, not a relaxation of
 * the deny-everything default `security.ts` applies to the app's own UI.
 *
 * Pure so the single security-relevant decision here has a direct unit test
 * with no real Electron `WebContents` involved.
 */
export type UrlDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: 'unsupported_scheme' | 'malformed' };

/** Decides whether `targetUrl` may be loaded (navigation, redirect, or a routed new-window request). */
export function decideAllowedUrl(targetUrl: string): UrlDecision {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return { kind: 'deny', reason: 'malformed' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'deny', reason: 'unsupported_scheme' };
  }
  return { kind: 'allow' };
}
