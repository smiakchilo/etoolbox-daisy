import { parseNavigationTarget } from '../../../shared';

/**
 * Persistence for the AEM pane's last opened page.
 *
 * Like `paneLayoutStore.ts` this is renderer-local view state and deliberately
 * does not go through `AppSettings`/`settings:*` IPC: the main process never
 * needs to read it, and `localStorage` is scoped to this app's own partition
 * and survives restarts - exactly the required lifetime. The shell reads it
 * once at startup and re-issues the navigation through the ordinary
 * `browser:navigate` path, so a restored page is validated (configured host,
 * scheme, userinfo) by the same code as a typed address, never by a second
 * implementation.
 *
 * Only a page *inside a configured host* is ever remembered: during web SSO
 * the view legitimately passes through an IdP origin (e.g. Adobe IMS), and
 * restoring that would reopen a login page rather than the AEM page the user
 * was on. The caller therefore checks {@link isHostPageUrl} before saving.
 *
 * Every access is guarded: `localStorage` throws rather than returning null
 * when storage is unavailable or over quota, and failing to remember a page
 * must never take the window down with it.
 */

const STORAGE_KEY = 'daisy.mainShell.lastPageUrl';
/** A stored value longer than any plausible address is discarded rather than trusted. */
const MAX_URL_LENGTH = 4000;

/** True when `url` is a navigable http(s) page whose origin is one of `hostOrigins`. */
export function isHostPageUrl(url: string, hostOrigins: readonly string[]): boolean {
  const target = parseNavigationTarget(url);
  if (!target.ok) return false;
  return hostOrigins.some((origin) => origin === target.origin);
}

/** The last remembered page URL, or `undefined` when there is no usable stored value. */
export function loadLastPageUrl(): string | undefined {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return undefined;
  }
  if (raw === null || raw.length === 0 || raw.length > MAX_URL_LENGTH) return undefined;
  // A value written by a different build, hand-edited, or truncated mid-write
  // is discarded rather than trusted: only a real http(s) address is replayed.
  return parseNavigationTarget(raw).ok ? raw : undefined;
}

/** Records a page that is safe to restore. Ignores anything that is not a real http(s) address. */
export function saveLastPageUrl(url: string): void {
  if (!parseNavigationTarget(url).ok || url.length > MAX_URL_LENGTH) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, url);
  } catch {
    // Nothing actionable for the user here - the page still opens this run, it
    // just will not be remembered for the next one.
  }
}
