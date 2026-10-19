import type { WebContents } from 'electron';

/**
 * Wires the browser view's main-frame navigations to a per-origin proxy
 * reconciliation (implementation-plan.md step 05; requirements-decisions.md
 * section 4).
 *
 * A Chromium proxy setting applies to the whole session, so "which proxy
 * applies to the current request" is answered by re-applying the session proxy
 * whenever the view's main frame heads to a new origin. `did-start-navigation`
 * fires as the frame begins the navigation, and `will-redirect` fires before a
 * server-side redirect is followed, so a cross-origin SSO hop (an host to
 * Adobe's IMS) is seen even though it is part of one logical load.
 *
 * This is deliberately a *separate* listener from
 * `attachNavigationEpochTracking`, which owns the tool-invalidation epoch:
 * the two react to the same event but for unrelated reasons, and coupling them
 * would make either one's future change silently affect the other. Sub-frame
 * and same-document navigations are ignored - neither changes the top-level
 * document's origin.
 *
 * `onMainFrameNavigation` is fire-and-forget: the callback's own async work
 * (a settings read, a secret lookup, `setProxy`) must not block Chromium's
 * event dispatch, and a failure there is non-fatal (the navigation simply
 * proceeds on the previously applied proxy).
 */
export function attachProxyReconciliation(
  webContents: WebContents,
  onMainFrameNavigation: (url: string) => void,
): () => void {
  const onStartNavigation = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
  ): void => {
    if (!details.isMainFrame || details.isSameDocument) return;
    onMainFrameNavigation(details.url);
  };

  const onWillRedirect = (
    details: Electron.Event<Electron.WebContentsWillRedirectEventParams>,
  ): void => {
    if (!details.isMainFrame || details.isSameDocument) return;
    onMainFrameNavigation(details.url);
  };

  webContents.on('did-start-navigation', onStartNavigation);
  webContents.on('will-redirect', onWillRedirect);

  return () => {
    if (webContents.isDestroyed()) return;
    webContents.off('did-start-navigation', onStartNavigation);
    webContents.off('will-redirect', onWillRedirect);
  };
}
