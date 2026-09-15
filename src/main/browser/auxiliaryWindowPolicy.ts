/**
 * Auxiliary-window policy (implementation-plan.md step 05;
 * requirements-decisions.md section 3: "Auxiliary HTTP(S) windows opened by
 * AEM/auth flows get no privileged preload, share the AEM profile, and close
 * on server switch. Reject unexpected file:/custom schemes and arbitrary
 * `shell.openExternal` calls.").
 *
 * This is deliberately the *only* affirmative case the AEM view's
 * `setWindowOpenHandler` allows - everything else, including `file:`, any
 * other custom scheme, and any non-http(s) URL, is denied outright. The
 * default posture (`security.ts`'s `installWebContentsSecurityGuard`) is
 * already deny-everything for the app UI's own webContents; this module is
 * the one narrow, reviewed exception carved out for the AEM
 * `WebContentsView` specifically, not a relaxation of that default.
 */
export type AuxiliaryWindowDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: 'unsupported_scheme' | 'malformed' };

/** Decides whether a `window.open`/`target="_blank"` request from the AEM view may open an auxiliary window. Pure so the one security-relevant decision here has a direct unit test with no real Electron `WebContents` involved. */
export function decideAuxiliaryWindowOpen(targetUrl: string): AuxiliaryWindowDecision {
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
