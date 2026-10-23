import type { WebContents } from 'electron';
import { toLoggableUrl, type Logger } from '../logger';
import type { StoredCredential } from './credentialVault';
import { buildCredentialFillScript } from './fillScript';

/**
 * Prefilling a saved sign-in, per `WebContents`.
 *
 * This attaches to *every* `WebContents` in the browser pane's session - the
 * pane itself and every popup window a page opens through `window.open` - so
 * an identity-provider dialog that is a real window is prefilled too, without
 * `windowOpenRouter.ts` knowing anything about credentials. The session check
 * that keeps the shell's own renderer out lives in `index.ts`, where the one
 * `Session` is in scope.
 *
 * **The origin gate is here, before anything is injected.** Main reads the URL
 * the document committed to, and only builds a fill script when the vault has a
 * credential for exactly that origin. A page on another origin is never sent a
 * script at all - not even an empty one - so the feature is invisible to every
 * site the user browses that has no saved sign-in.
 *
 * Two moments prefill a page: `dom-ready` (the first paint of a new document)
 * and `did-navigate-in-page` (a single-page application changing route without
 * a load - the shape Adobe's and Microsoft's identity providers both use). A
 * re-injection into the same document is safe: the script retires its own
 * previous listener and observer first (see `fillScript.ts`).
 */
export interface CredentialAutofillDeps {
  readonly listForOrigin: (origin: string) => readonly StoredCredential[];
  readonly logger: Logger;
}

/** A canonical http(s) origin, or `undefined` for anything else. */
export function originOf(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return parsed.origin;
}

/** Attaches the prefill hooks; returns a detach function. */
export function attachCredentialAutofill(
  webContents: WebContents,
  deps: CredentialAutofillDeps,
): () => void {
  async function prefill(): Promise<void> {
    if (webContents.isDestroyed()) return;
    const origin = originOf(webContents.getURL());
    if (origin === undefined) return;
    const credentials = deps.listForOrigin(origin);
    if (credentials.length === 0) return;
    try {
      const filled: unknown = await webContents.executeJavaScript(
        buildCredentialFillScript(credentials),
      );
      // Only a successful prefill is logged, and only the origin: a page load on
      // a saved origin that has no form (a content page after signing in) is the
      // common case and would otherwise fill the log.
      if (filled === true) {
        deps.logger.info('CREDENTIAL_PREFILLED', { url: toLoggableUrl(`${origin}/`) });
      }
    } catch {
      // A page that navigated away, a destroyed frame, a CSP-exotic document:
      // all mean "not filled", never a broken page.
      deps.logger.warn('CREDENTIAL_PREFILL_FAILED', { count: 1 });
    }
  }

  const onLoaded = (): void => {
    void prefill();
  };
  const onInPageNavigation = (_event: Electron.Event, _url: string, isMainFrame: boolean): void => {
    if (isMainFrame) void prefill();
  };

  webContents.on('dom-ready', onLoaded);
  webContents.on('did-navigate-in-page', onInPageNavigation);
  return () => {
    webContents.off('dom-ready', onLoaded);
    webContents.off('did-navigate-in-page', onInPageNavigation);
  };
}
