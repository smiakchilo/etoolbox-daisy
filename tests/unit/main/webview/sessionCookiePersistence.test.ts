import { describe, expect, it } from 'vitest';
import {
  buildPersistCookieDetails,
  SESSION_COOKIE_PERSISTENCE_MAX_AGE_SECONDS,
  shouldPersistSessionCookie,
  type SessionCookieCandidate,
} from '../../../../src/main/webview';

/** A plain-HTTP AEM `login-token` as Chromium reports it to `cookies.on('changed')`. */
function sessionCookie(overrides: Partial<SessionCookieCandidate> = {}): SessionCookieCandidate {
  return {
    name: 'login-token',
    value: 'token-value',
    domain: 'cloud.localhost.hpe.com',
    path: '/',
    secure: false,
    httpOnly: true,
    sameSite: 'lax',
    session: true,
    hostOnly: true,
    ...overrides,
  };
}

/** Removes a key entirely, exercising the "flag absent" case `exactOptionalPropertyTypes` forbids setting to `undefined`. */
function without<K extends keyof SessionCookieCandidate>(
  cookie: SessionCookieCandidate,
  key: K,
): SessionCookieCandidate {
  const copy = { ...cookie };
  delete copy[key];
  return copy;
}

const NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

describe('shouldPersistSessionCookie', () => {
  it('persists an insecure session cookie (the local HTTP AEM case)', () => {
    expect(shouldPersistSessionCookie(sessionCookie(), false)).toBe(true);
  });

  it('never persists a cookie that already carries an expiry', () => {
    expect(shouldPersistSessionCookie(sessionCookie({ session: false }), false)).toBe(false);
  });

  it('never persists a cookie whose session flag is absent', () => {
    expect(shouldPersistSessionCookie(without(sessionCookie(), 'session'), false)).toBe(false);
  });

  it('leaves Secure cookies alone', () => {
    expect(shouldPersistSessionCookie(sessionCookie({ secure: true }), false)).toBe(false);
  });

  it('treats a missing secure flag as insecure', () => {
    expect(shouldPersistSessionCookie(without(sessionCookie(), 'secure'), false)).toBe(true);
  });

  it('never re-creates a cookie that is being removed', () => {
    expect(shouldPersistSessionCookie(sessionCookie(), true)).toBe(false);
  });

  it('rejects a nameless cookie', () => {
    expect(shouldPersistSessionCookie(sessionCookie({ name: '' }), false)).toBe(false);
  });

  it('rejects a cookie with no domain', () => {
    expect(shouldPersistSessionCookie(without(sessionCookie(), 'domain'), false)).toBe(false);
    expect(shouldPersistSessionCookie(sessionCookie({ domain: '' }), false)).toBe(false);
  });
});

describe('buildPersistCookieDetails', () => {
  it('re-creates a host-only cookie with an explicit expiry, without widening it to subdomains', () => {
    const details = buildPersistCookieDetails(sessionCookie(), NOW_MS);

    expect(details).toEqual({
      url: 'http://cloud.localhost.hpe.com/',
      name: 'login-token',
      value: 'token-value',
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: Math.floor(NOW_MS / 1000) + SESSION_COOKIE_PERSISTENCE_MAX_AGE_SECONDS,
    });
  });

  it('does not include a domain key for a host-only cookie', () => {
    const details = buildPersistCookieDetails(sessionCookie(), NOW_MS);

    expect(details !== undefined && Object.prototype.hasOwnProperty.call(details, 'domain')).toBe(
      false,
    );
  });

  it('keeps the domain on a domain cookie, re-using Electron’s normalized leading dot', () => {
    const details = buildPersistCookieDetails(
      sessionCookie({ domain: '.hpe.com', hostOnly: false }),
      NOW_MS,
    );

    expect(details?.url).toBe('http://hpe.com/');
    expect(details?.domain).toBe('.hpe.com');
  });

  it('defaults an absent or empty path to /', () => {
    expect(buildPersistCookieDetails(without(sessionCookie(), 'path'), NOW_MS)?.url).toBe(
      'http://cloud.localhost.hpe.com/',
    );
    expect(buildPersistCookieDetails(sessionCookie({ path: '' }), NOW_MS)?.url).toBe(
      'http://cloud.localhost.hpe.com/',
    );
  });

  it('uses an https URL and the Secure flag when the cookie is secure', () => {
    const details = buildPersistCookieDetails(sessionCookie({ secure: true }), NOW_MS);

    expect(details?.url).toBe('https://cloud.localhost.hpe.com/');
    expect(details?.secure).toBe(true);
  });

  it('preserves a non-default SameSite policy', () => {
    expect(buildPersistCookieDetails(sessionCookie({ sameSite: 'strict' }), NOW_MS)?.sameSite).toBe(
      'strict',
    );
  });

  it('returns undefined rather than ever building an unusable URL', () => {
    expect(buildPersistCookieDetails(without(sessionCookie(), 'domain'), NOW_MS)).toBeUndefined();
    expect(buildPersistCookieDetails(sessionCookie({ domain: '' }), NOW_MS)).toBeUndefined();
    expect(buildPersistCookieDetails(sessionCookie({ domain: '.' }), NOW_MS)).toBeUndefined();
  });
});
