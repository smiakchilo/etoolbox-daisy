import { describe, expect, it } from 'vitest';
import { MAX_COOKIE_DIGESTS } from '../../../../src/main/logger';
import {
  classifyAuthCookie,
  createAuthDiagnostics,
  digestCookieJar,
  hostKey,
  toCookieDigest,
} from '../../../../src/main/webview/authDiagnostics';

const ORIGIN = 'http://cloud.localhost.hpe.com:4502';

describe('classifyAuthCookie', () => {
  it.each([
    'login-token',
    'Login-Token',
    'JSESSIONID',
    'saml_request_path',
    'sling.formauth',
    'XSRF-TOKEN',
  ])('treats %s as an authentication cookie', (name) => {
    expect(classifyAuthCookie(name)).toBeDefined();
  });

  it.each(['theme', 'cq-authoring-mode', '_ga'])('ignores %s', (name) => {
    expect(classifyAuthCookie(name)).toBeUndefined();
  });
});

describe('toCookieDigest', () => {
  const now = 1_000_000;

  it('never carries the cookie value or its raw name', () => {
    const digest = toCookieDigest(
      { name: 'my-secret-token-name', httpOnly: true, expirationDate: now / 1000 + 60 },
      now,
    );
    const text = JSON.stringify(digest);
    expect(text).not.toContain('my-secret');
    expect(digest).toMatchObject({ httpOnly: true, session: false, expiresInMs: 60_000 });
  });

  it('reports a cookie without an expiry as a session cookie with no expiry figure', () => {
    const digest = toCookieDigest({ name: 'login-token' }, now);
    expect(digest).toMatchObject({ httpOnly: false, session: true });
    expect(digest).not.toHaveProperty('expiresInMs');
  });

  it('reports an already expired cookie as a negative remaining time', () => {
    const digest = toCookieDigest({ name: 'login-token', expirationDate: now / 1000 - 5 }, now);
    expect(digest?.expiresInMs).toBe(-5000);
  });

  it('returns nothing for a cookie that is not an authentication cookie', () => {
    expect(toCookieDigest({ name: 'theme' }, now)).toBeUndefined();
  });
});

describe('digestCookieJar', () => {
  it('keeps authentication cookies only', () => {
    const digests = digestCookieJar([{ name: 'theme' }, { name: 'login-token' }], 0);
    expect(digests).toHaveLength(1);
  });

  it('is bounded', () => {
    const jar = Array.from({ length: MAX_COOKIE_DIGESTS + 10 }, () => ({ name: 'token' }));
    expect(digestCookieJar(jar, 0)).toHaveLength(MAX_COOKIE_DIGESTS);
  });
});

describe('hostKey', () => {
  it('lets a dotted cookie domain meet the origin it was set for', () => {
    expect(hostKey('.Cloud.Localhost.hpe.com')).toBe(hostKey(ORIGIN));
  });
});

describe('createAuthDiagnostics', () => {
  it('claims the snapshot once per sign-in episode', () => {
    const diagnostics = createAuthDiagnostics();
    expect(diagnostics.claimSnapshot(ORIGIN)).toBe(true);
    expect(diagnostics.claimSnapshot(ORIGIN)).toBe(false);
    diagnostics.noteSignIn(ORIGIN, 10);
    expect(diagnostics.claimSnapshot(ORIGIN)).toBe(true);
  });

  it('keeps episodes of different hosts apart', () => {
    const diagnostics = createAuthDiagnostics();
    expect(diagnostics.claimSnapshot(ORIGIN)).toBe(true);
    expect(diagnostics.claimSnapshot('http://other.example')).toBe(true);
  });

  it('reports the session age since the last sign-in', () => {
    const diagnostics = createAuthDiagnostics();
    expect(diagnostics.signInAgeMs(ORIGIN, 500)).toBeUndefined();
    diagnostics.noteSignIn(ORIGIN, 100);
    expect(diagnostics.signInAgeMs(ORIGIN, 500)).toBe(400);
  });

  it('remembers the last authentication cookie change and ignores other cookies', () => {
    const diagnostics = createAuthDiagnostics();
    const domain = 'cloud.localhost.hpe.com';
    expect(diagnostics.noteCookieChange({ name: 'theme', domain }, 'explicit', false, 100)).toBe(
      undefined,
    );
    expect(diagnostics.lastCookieChange(ORIGIN, 150)).toBeUndefined();

    const label = diagnostics.noteCookieChange(
      { name: 'login-token', domain },
      'expired',
      true,
      200,
    );
    expect(label).toBe('login-token');
    expect(diagnostics.lastCookieChange(ORIGIN, 250)).toEqual({
      name: 'login-token',
      cause: 'expired',
      removed: true,
      ageMs: 50,
    });
  });
});
