/**
 * Session-cookie persistence for the AEM pane (deliberate deviation from the
 * step-05 cookie contract; see docs/verification.md, "AEM session cookies for
 * non-TLS hosts now survive restart").
 *
 * Chromium writes a cookie to disk only when it carries an `Expires`/`Max-Age`
 * attribute; a cookie with neither - a *session* cookie - lives in memory and
 * is discarded when the process exits, even inside a `persist:` partition.
 * That is correct browser behaviour, and it is exactly what an out-of-the-box
 * AEM author instance on plain HTTP does: its `login-token` is minted without
 * an expiry, so a developer has to sign in again on every launch.
 *
 * The app therefore promotes a *session* cookie that arrived over an insecure
 * (non-`Secure`) channel to a persistent one, by re-setting the identical
 * cookie with an explicit `expirationDate`. This is the standard Electron
 * mechanism for the problem (`session.cookies.on('changed')` -> `cookies.set`),
 * scoped narrowly:
 *
 *  - **Only session cookies.** A cookie that already carries an expiry - and
 *    every cookie the server sent as persistent - is left exactly as it is.
 *  - **Only insecure cookies.** A `Secure` cookie is only ever usable over
 *    HTTPS, where AEM already mints a persistent token; an `http://` dev
 *    instance cannot set `Secure` at all (Chromium rejects it, and AEM's own
 *    `TokenUtil` only sets it when the request is secure). Restricting to
 *    `secure !== true` therefore targets precisely the local, certificate-less
 *    instances this exists for, and leaves a corporate HTTPS deployment's true
 *    session semantics untouched.
 *
 * A pure decision pair, no Electron import, so every rule above has a direct
 * unit test; `session.ts` is the thin wiring that calls it.
 */

/** The subset of Electron's `Cookie` this module's decision actually reads. */
export interface SessionCookieCandidate {
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
  readonly session?: boolean;
  readonly hostOnly?: boolean;
}

/** The `session.cookies.set()` input that turns a session cookie into a persistent one. */
export interface PersistentCookieDetails {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  readonly path?: string;
  readonly domain?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
  readonly expirationDate: number;
}

/**
 * How long a promoted cookie lives. Deliberately shorter than "forever" and
 * longer than any realistic dev token's server-side validity: a value the
 * server has already invalidated is rejected on the next request and the user
 * signs in again, so a generous ceiling never hides an expired login - it just
 * stops the *browser* from discarding a cookie the server still accepts.
 */
export const SESSION_COOKIE_PERSISTENCE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Whether a `cookies.on('changed')` observation names a session cookie that
 * should be promoted to persistent. `removed` comes from the Electron event
 * verbatim; a cookie being deleted must never be re-created.
 */
export function shouldPersistSessionCookie(
  cookie: SessionCookieCandidate,
  removed: boolean,
): boolean {
  if (removed) return false;
  if (cookie.session !== true) return false;
  if (cookie.secure === true) return false;
  if (cookie.name.length === 0) return false;
  return typeof cookie.domain === 'string' && cookie.domain.length > 0;
}

/**
 * Builds the `set()` input that re-creates `cookie` with an `expirationDate`,
 * preserving every other attribute so the server sees a byte-identical cookie.
 *
 * `url` is reconstructed from the cookie's own domain/scheme/path because
 * `Cookies.set` requires one and the `changed` event does not carry it. A
 * host-only cookie is set without a `domain` (which would silently widen it to
 * every subdomain); a domain cookie keeps the leading dot Electron normalized
 * onto it.
 */
export function buildPersistCookieDetails(
  cookie: SessionCookieCandidate,
  nowMs: number,
): PersistentCookieDetails | undefined {
  const domain = cookie.domain;
  if (typeof domain !== 'string' || domain.length === 0) {
    return undefined;
  }
  const host = domain.startsWith('.') ? domain.slice(1) : domain;
  if (host.length === 0) {
    return undefined;
  }
  const scheme = cookie.secure === true ? 'https' : 'http';
  const path = cookie.path !== undefined && cookie.path.length > 0 ? cookie.path : '/';

  return {
    url: `${scheme}://${host}${path}`,
    name: cookie.name,
    value: cookie.value,
    path,
    ...(cookie.hostOnly === false ? { domain } : {}),
    ...(cookie.secure === true ? { secure: true } : {}),
    ...(cookie.httpOnly === true ? { httpOnly: true } : {}),
    sameSite: cookie.sameSite,
    expirationDate: Math.floor(nowMs / 1000) + SESSION_COOKIE_PERSISTENCE_MAX_AGE_SECONDS,
  };
}
