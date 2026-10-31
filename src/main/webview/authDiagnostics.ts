import {
  type AuthCookieLabel,
  type CookieChangeCause,
  type CookieChangeDigest,
  type CookieDigest,
  MAX_COOKIE_DIGESTS,
} from '../logger';

/** The part of an Electron cookie a diagnostic may read. The value is deliberately absent. */
export interface CookieFacts {
  readonly name: string;
  readonly domain?: string | undefined;
  readonly httpOnly?: boolean | undefined;
  readonly session?: boolean | undefined;
  readonly expirationDate?: number | undefined;
}

/**
 * Classifies a cookie name into the closed label a log line may carry, or
 * `undefined` for a cookie that is not an authentication cookie. The name
 * itself is a string a page chose and is never logged.
 */
export function classifyAuthCookie(name: string): AuthCookieLabel | undefined {
  const lower = name.toLowerCase();
  if (lower === 'login-token') return 'login-token';
  if (lower === 'jsessionid') return 'JSESSIONID';
  if (lower.startsWith('saml')) return 'saml';
  if (lower.includes('sling')) return 'sling';
  if (lower.includes('token')) return 'token';
  return undefined;
}

/** What a log line may say about a cookie; `undefined` when it is not an authentication cookie. */
export function toCookieDigest(cookie: CookieFacts, nowMs: number): CookieDigest | undefined {
  const name = classifyAuthCookie(cookie.name);
  if (name === undefined) return undefined;
  const session = cookie.session === true || cookie.expirationDate === undefined;
  return {
    name,
    httpOnly: cookie.httpOnly === true,
    session,
    ...(session || cookie.expirationDate === undefined
      ? {}
      : { expiresInMs: Math.round(cookie.expirationDate * 1000 - nowMs) }),
  };
}

/** The digests to log for a cookie jar: authentication cookies only, bounded. */
export function digestCookieJar(
  cookies: readonly CookieFacts[],
  nowMs: number,
): readonly CookieDigest[] {
  const digests: CookieDigest[] = [];
  for (const cookie of cookies) {
    const digest = toCookieDigest(cookie, nowMs);
    if (digest !== undefined) digests.push(digest);
    if (digests.length >= MAX_COOKIE_DIGESTS) break;
  }
  return digests;
}

/** A host name, the key a host-only cookie and an origin share. */
export function hostKey(originOrDomain: string): string {
  try {
    return new URL(originOrDomain).hostname.toLowerCase();
  } catch {
    return originOrDomain.replace(/^\./, '').toLowerCase();
  }
}

interface HostRecord {
  signedInAt?: number;
  lastChange?: { name: AuthCookieLabel; cause: CookieChangeCause; removed: boolean; at: number };
  snapshotTaken: boolean;
}

export interface AuthDiagnostics {
  /** A sign-in was submitted for this origin: a new episode begins. */
  noteSignIn(origin: string, nowMs: number): void;
  /** An authentication cookie changed in the pane's session. */
  noteCookieChange(
    cookie: CookieFacts,
    cause: CookieChangeCause,
    removed: boolean,
    nowMs: number,
  ): AuthCookieLabel | undefined;
  /** Milliseconds since the last sign-in on this origin, when one was seen. */
  signInAgeMs(origin: string, nowMs: number): number | undefined;
  /** The last authentication-cookie change on this origin. */
  lastCookieChange(origin: string, nowMs: number): CookieChangeDigest | undefined;
  /** True exactly once per sign-in episode: the caller logs the snapshot when it is. */
  claimSnapshot(origin: string): boolean;
}

/** Per-host memory of the sign-in episode, so a diagnostic can say how old a session was when it died. */
export function createAuthDiagnostics(): AuthDiagnostics {
  const hosts = new Map<string, HostRecord>();
  const recordFor = (key: string): HostRecord => {
    let record = hosts.get(key);
    if (record === undefined) {
      record = { snapshotTaken: false };
      hosts.set(key, record);
    }
    return record;
  };
  return {
    noteSignIn(origin, nowMs) {
      const record = recordFor(hostKey(origin));
      record.signedInAt = nowMs;
      record.snapshotTaken = false;
    },
    noteCookieChange(cookie, cause, removed, nowMs) {
      const name = classifyAuthCookie(cookie.name);
      if (name === undefined) return undefined;
      recordFor(hostKey(cookie.domain ?? '')).lastChange = { name, cause, removed, at: nowMs };
      return name;
    },
    signInAgeMs(origin, nowMs) {
      const at = hosts.get(hostKey(origin))?.signedInAt;
      return at === undefined ? undefined : Math.max(0, nowMs - at);
    },
    lastCookieChange(origin, nowMs) {
      const change = hosts.get(hostKey(origin))?.lastChange;
      return change === undefined
        ? undefined
        : {
            name: change.name,
            cause: change.cause,
            removed: change.removed,
            ageMs: Math.max(0, nowMs - change.at),
          };
    },
    claimSnapshot(origin) {
      const record = recordFor(hostKey(origin));
      if (record.snapshotTaken) return false;
      record.snapshotTaken = true;
      return true;
    },
  };
}
