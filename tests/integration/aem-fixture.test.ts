import { afterEach, describe, expect, it } from 'vitest';
import {
  AEM_SESSION_COOKIE,
  FIXTURE_PASSWORD,
  FIXTURE_USERNAME,
  IDP_SESSION_COOKIE,
  startAemOrigin,
  startSsoIdp,
  type AemOrigin,
  type SsoIdp,
} from './support/testAemServer';

/**
 * Proves the step 05 AEM/IdP fixture behaves the way the Electron E2E matrix
 * will assume. A fixture that silently mis-implements its own redirect chain
 * would make a genuine application bug look like a passing test, so the
 * fixture is verified here against a plain HTTP client - no Electron, no
 * Chromium - before anything is concluded from it.
 *
 * Only plain HTTP is exercised: the TLS variants exist for Chromium's
 * certificate handling, which Node's client cannot meaningfully stand in for.
 */

const started: (AemOrigin | SsoIdp)[] = [];

/** Registers a started server for teardown and hands it straight back. */
function track<T extends AemOrigin | SsoIdp>(server: T): T {
  started.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((server) => server.close()));
});

/** Extracts one cookie's value from a `Set-Cookie` header, ignoring attributes. */
function cookieValue(setCookie: string | null, name: string): string | undefined {
  if (setCookie === null) {
    return undefined;
  }
  const match = new RegExp(`(?:^|, )${name}=([^;]*)`).exec(setCookie);
  return match?.[1];
}

describe('AEM fixture - local login form', () => {
  it('redirects an unauthenticated request to the login form and preserves the target', async () => {
    const aem = track(await startAemOrigin());

    const response = await fetch(aem.url('/content/site.html'), { redirect: 'manual' });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login?next=%2Fcontent%2Fsite.html');
  });

  it('rejects wrong credentials without minting a session', async () => {
    const aem = track(await startAemOrigin());

    const response = await fetch(aem.url('/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: FIXTURE_USERNAME, password: 'wrong', next: '/' }),
      redirect: 'manual',
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('mints an HttpOnly session cookie that unlocks protected content', async () => {
    const aem = track(await startAemOrigin());

    const login = await fetch(aem.url('/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username: FIXTURE_USERNAME,
        password: FIXTURE_PASSWORD,
        next: '/content/site.html',
      }),
      redirect: 'manual',
    });

    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toBe('/content/site.html');
    const setCookie = login.headers.get('set-cookie');
    expect(setCookie).toContain('HttpOnly');
    const session = cookieValue(setCookie, AEM_SESSION_COOKIE);
    expect(session).toBeTruthy();

    const content = await fetch(aem.url('/content/site.html'), {
      headers: { Cookie: `${AEM_SESSION_COOKIE}=${String(session)}` },
      redirect: 'manual',
    });
    expect(content.status).toBe(200);
    await expect(content.text()).resolves.toContain('AEM content');
  });

  it('stops honouring a session once it is invalidated', async () => {
    const aem = track(await startAemOrigin());
    const login = await fetch(aem.url('/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username: FIXTURE_USERNAME,
        password: FIXTURE_PASSWORD,
        next: '/',
      }),
      redirect: 'manual',
    });
    const session = cookieValue(login.headers.get('set-cookie'), AEM_SESSION_COOKIE);
    const cookieHeader = { Cookie: `${AEM_SESSION_COOKIE}=${String(session)}` };

    const before = await fetch(aem.url('/whoami'), { headers: cookieHeader });
    await expect(before.json()).resolves.toEqual({
      authenticated: true,
      user: FIXTURE_USERNAME,
    });

    aem.invalidateSessions();

    const after = await fetch(aem.url('/whoami'), { headers: cookieHeader });
    await expect(after.json()).resolves.toEqual({ authenticated: false, user: null });
  });
});

describe('AEM fixture - SSO redirection to another origin and back', () => {
  it('bounces to the IdP, returns with an assertion, and mints the AEM session', async () => {
    const sharedSecret = 'fixture-sso-secret';
    const idp = await startSsoIdp({ sharedSecret });
    started.push(idp);
    const aem = track(await startAemOrigin({ sso: { origin: idp.origin, sharedSecret } }));

    // Hop 1: AEM -> IdP, carrying where to come back to.
    const toIdp = await fetch(aem.url('/content/site.html'), { redirect: 'manual' });
    expect(toIdp.status).toBe(302);
    const authorizeUrl = new URL(String(toIdp.headers.get('location')));
    expect(authorizeUrl.origin).toBe(idp.origin);
    expect(authorizeUrl.origin).not.toBe(aem.origin);
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(`${aem.origin}/sso/callback`);

    // Hop 2: sign in at the IdP -> back to AEM with a signed assertion.
    const idpLogin = await fetch(authorizeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username: FIXTURE_USERNAME,
        password: FIXTURE_PASSWORD,
        next: '/content/site.html',
      }),
      redirect: 'manual',
    });
    expect(idpLogin.status).toBe(302);
    const idpSession = cookieValue(idpLogin.headers.get('set-cookie'), IDP_SESSION_COOKIE);
    expect(idpSession).toBeTruthy();
    const callbackUrl = new URL(String(idpLogin.headers.get('location')));
    expect(callbackUrl.origin).toBe(aem.origin);
    expect(callbackUrl.searchParams.get('assertion')).toBeTruthy();

    // Hop 3: AEM consumes the assertion and issues its own session.
    const callback = await fetch(callbackUrl, { redirect: 'manual' });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/content/site.html');
    const aemSession = cookieValue(callback.headers.get('set-cookie'), AEM_SESSION_COOKIE);
    expect(aemSession).toBeTruthy();

    const content = await fetch(aem.url('/content/site.html'), {
      headers: { Cookie: `${AEM_SESSION_COOKIE}=${String(aemSession)}` },
      redirect: 'manual',
    });
    expect(content.status).toBe(200);
  });

  it('makes the second round trip silent once the IdP itself has a session', async () => {
    const sharedSecret = 'fixture-sso-secret';
    const idp = await startSsoIdp({ sharedSecret });
    started.push(idp);
    const aem = track(await startAemOrigin({ sso: { origin: idp.origin, sharedSecret } }));

    const authorize = `${idp.origin}/authorize?redirect_uri=${encodeURIComponent(`${aem.origin}/sso/callback`)}&next=%2F`;
    const first = await fetch(authorize, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username: FIXTURE_USERNAME,
        password: FIXTURE_PASSWORD,
        next: '/',
      }),
      redirect: 'manual',
    });
    const idpSession = cookieValue(first.headers.get('set-cookie'), IDP_SESSION_COOKIE);

    // No form, no credentials - straight back to AEM. This is the "internal
    // SSO redirect" case that must not be mistaken for a sign-in prompt.
    const second = await fetch(authorize, {
      headers: { Cookie: `${IDP_SESSION_COOKIE}=${String(idpSession)}` },
      redirect: 'manual',
    });
    expect(second.status).toBe(302);
    expect(new URL(String(second.headers.get('location'))).origin).toBe(aem.origin);
  });

  it('refuses a tampered assertion', async () => {
    const sharedSecret = 'fixture-sso-secret';
    const idp = await startSsoIdp({ sharedSecret });
    started.push(idp);
    const aem = track(await startAemOrigin({ sso: { origin: idp.origin, sharedSecret } }));

    const forged = await fetch(
      `${aem.url('/sso/callback')}?assertion=${encodeURIComponent('daisy.not-a-real-mac')}&next=%2F`,
      { redirect: 'manual' },
    );

    expect(forged.status).toBe(403);
    expect(forged.headers.get('set-cookie')).toBeNull();
  });
});

describe('AEM fixture - auxiliary flows and challenge shapes', () => {
  it('serves a popup launcher and a popup that sets its own cookie', async () => {
    const aem = track(await startAemOrigin());
    const login = await fetch(aem.url('/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username: FIXTURE_USERNAME,
        password: FIXTURE_PASSWORD,
        next: '/',
      }),
      redirect: 'manual',
    });
    const cookie = `${AEM_SESSION_COOKIE}=${String(cookieValue(login.headers.get('set-cookie'), AEM_SESSION_COOKIE))}`;

    const launcher = await fetch(aem.url('/popup-launcher'), { headers: { Cookie: cookie } });
    expect(launcher.status).toBe(200);
    await expect(launcher.text()).resolves.toContain('open-popup');

    const popup = await fetch(aem.url('/popup'), { headers: { Cookie: cookie } });
    expect(popup.status).toBe(200);
    expect(popup.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('issues an origin 401 that is distinguishable from a proxy 407', async () => {
    const aem = track(await startAemOrigin({ basicAuthRealm: 'aem-origin' }));

    const challenged = await fetch(aem.url('/'), { redirect: 'manual' });
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get('www-authenticate')).toBe('Basic realm="aem-origin"');

    const allowed = await fetch(aem.url('/whoami'), {
      headers: {
        Authorization: `Basic ${Buffer.from(`${FIXTURE_USERNAME}:${FIXTURE_PASSWORD}`).toString('base64')}`,
      },
    });
    expect(allowed.status).toBe(200);
  });

  it('can run two independent instances on the same hostname, different ports', async () => {
    const first = track(await startAemOrigin());
    const second = track(await startAemOrigin());

    expect(new URL(first.origin).hostname).toBe(new URL(second.origin).hostname);
    expect(first.port).not.toBe(second.port);
    expect(first.origin).not.toBe(second.origin);
  });

  it('records every request it handled, with whether it was authenticated', async () => {
    const aem = track(await startAemOrigin());

    await fetch(aem.url('/whoami'));

    expect(aem.log).toEqual([
      {
        method: 'GET',
        path: '/whoami',
        authenticated: false,
        authorizationHeaderPresent: false,
      },
    ]);
  });
});
