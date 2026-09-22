import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { GeneratedCert } from './testCa';

/**
 * A local stand-in for an AEM Author instance plus the corporate IdP that
 * fronts it, used by the step 05 Electron E2E matrix
 * (implementation-plan.md step 05 "Success": login form and HttpOnly session,
 * SSO redirection to another origin and back, popup flow, two ports on the
 * same hostname, cookies surviving restart).
 *
 * This is deliberately a *real* HTTP(S) origin rather than an in-memory fake
 * like `tests/support/fakeAemFixtures.ts`. The properties under test are
 * Chromium's: whether a cookie is actually withheld from script because it is
 * HttpOnly, whether a cross-origin redirect chain preserves the session,
 * whether a popup shares the profile. None of those can be observed against
 * an object that never touches the network stack.
 *
 * Nothing here is a security boundary and no value in it is secret. The
 * credentials are fixed constants so a failing test reads unambiguously.
 */

/** The only credentials the fixture login form accepts. */
export const FIXTURE_USERNAME = 'daisy';
export const FIXTURE_PASSWORD = 'correct-horse';

/** Name of the AEM session cookie. Mirrors AEM's own `login-token` in spirit. */
export const AEM_SESSION_COOKIE = 'daisy_aem_session';
/**
 * A *persistent* companion to {@link AEM_SESSION_COOKIE}, carrying `Max-Age`
 * the way AEM's "keep me signed in" login-token does.
 *
 * Both exist because they have genuinely different lifetimes and the
 * distinction is the whole point of the restart test: a cookie with no
 * `Expires`/`Max-Age` is a session cookie and Chromium is *correct* to discard
 * it when the browser process exits, even inside a `persist:` partition.
 * Asserting that the session cookie survives a restart would therefore be
 * asserting a bug. Minting both lets a test show the real contract - session
 * cookie gone, persistent cookie kept, and the user still signed in.
 */
export const AEM_REMEMBER_COOKIE = 'daisy_aem_remember';
/** Name of the IdP's own cookie, which is what makes the *second* SSO round trip silent. */
export const IDP_SESSION_COOKIE = 'daisy_idp_session';
/** Set by the popup page, so a test can prove the popup shared the profile. */
export const POPUP_COOKIE = 'daisy_popup_visited';

export interface AemRequestLogEntry {
  readonly method: string;
  readonly path: string;
  /** True when the request arrived carrying a valid AEM session cookie. */
  readonly authenticated: boolean;
  /** True when an `Authorization` header was present (used by the 401 tests). */
  readonly authorizationHeaderPresent: boolean;
}

export interface SsoBinding {
  /** Origin of the IdP to bounce unauthenticated requests to. */
  readonly origin: string;
  /**
   * Shared secret used to sign the assertion the IdP hands back. Both sides
   * hold it because the fixture models a pre-established trust relationship,
   * not a discovery protocol.
   */
  readonly sharedSecret: string;
}

export interface AemOriginOptions {
  /** Supply to serve HTTPS. Omit for the plain-HTTP case (plan line 292). */
  readonly tls?: GeneratedCert;
  /**
   * Bind to a specific port instead of an ephemeral one. Needed only by the
   * certificate-replacement test, which must restart on the *same* origin
   * with a different certificate.
   */
  readonly port?: number;
  /** When set, unauthenticated requests redirect to this IdP instead of a local form. */
  readonly sso?: SsoBinding;
  /**
   * When set, every request must carry matching HTTP Basic credentials or the
   * origin answers 401. This exists to produce an *origin* challenge that is
   * distinguishable from a *proxy* 407 (plan lines 293-294).
   */
  readonly basicAuthRealm?: string;
}

export interface AemOrigin {
  /** e.g. `https://localhost:52413` - exactly what `new URL(href).origin` yields. */
  readonly origin: string;
  readonly port: number;
  /** Every request the fixture handled, in order. */
  readonly log: readonly AemRequestLogEntry[];
  /** Absolute URL for a fixture path, e.g. `url("/content/site.html")`. */
  url(path: string): string;
  /** Forgets all issued sessions without restarting, to test re-authentication. */
  invalidateSessions(): void;
  close(): Promise<void>;
}

export interface SsoIdp {
  readonly origin: string;
  readonly port: number;
  readonly log: readonly AemRequestLogEntry[];
  url(path: string): string;
  close(): Promise<void>;
}

function signAssertion(sharedSecret: string, subject: string): string {
  const mac = createHmac('sha256', sharedSecret).update(subject).digest('base64url');
  return `${subject}.${mac}`;
}

function verifyAssertion(sharedSecret: string, assertion: string): string | undefined {
  const separator = assertion.lastIndexOf('.');
  if (separator <= 0) {
    return undefined;
  }
  const subject = assertion.slice(0, separator);
  return signAssertion(sharedSecret, subject) === assertion ? subject : undefined;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq > 0 && trimmed.slice(0, eq) === name) {
      return trimmed.slice(eq + 1);
    }
  }
  return undefined;
}

/**
 * `Secure` is only attached over TLS: Chromium rejects a `Secure` cookie from
 * a plain-HTTP origin, which would make the plain-HTTP fixture silently fail
 * to hold a session and look like an application bug.
 */
function sessionCookie(name: string, value: string, secure: boolean): string {
  const attributes = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

/**
 * As {@link sessionCookie}, but with `Max-Age`, which is precisely what makes
 * Chromium write it to disk and reload it in the next process.
 */
function persistentCookie(
  name: string,
  value: string,
  secure: boolean,
  maxAgeSeconds: number,
): string {
  return `${sessionCookie(name, value, secure)}; Max-Age=${String(maxAgeSeconds)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loginFormHtml(actionPath: string, next: string, message: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Sign in</title></head>
<body>
<h1 id="login-heading">Sign in</h1>
<p id="login-message">${escapeHtml(message)}</p>
<form id="login-form" method="POST" action="${escapeHtml(actionPath)}">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label>User <input id="username" name="username" type="text" autocomplete="username"></label>
<label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
<button id="submit" type="submit">Sign in</button>
</form>
</body></html>`;
}

function send(
  response: http.ServerResponse,
  status: number,
  headers: Readonly<Record<string, string | readonly string[]>>,
  body: string,
): void {
  response.writeHead(status, { 'Content-Length': Buffer.byteLength(body), ...headers });
  response.end(body);
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function listen(server: http.Server | https.Server, port: number | undefined): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port ?? 0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: http.Server | https.Server): Promise<void> {
  return new Promise((resolve) => {
    // Without this, a keep-alive socket held by Chromium keeps `close()`
    // pending until its idle timeout and the test times out instead of failing.
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
}

/**
 * Starts the IdP that {@link startAemOrigin} bounces to when configured with
 * `sso`. Kept separate so a test can put it on a genuinely different origin -
 * the cross-origin hop is the part that matters.
 */
export async function startSsoIdp(options: {
  readonly sharedSecret: string;
  readonly tls?: GeneratedCert;
}): Promise<SsoIdp> {
  const log: AemRequestLogEntry[] = [];
  const secure = options.tls !== undefined;
  const sessions = new Set<string>();

  const handler = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    void (async () => {
      const requestUrl = new URL(request.url ?? '/', `http://placeholder`);
      const idpSession = readCookie(request.headers.cookie, IDP_SESSION_COOKIE);
      const signedIn = idpSession !== undefined && sessions.has(idpSession);
      log.push({
        method: request.method ?? 'GET',
        path: requestUrl.pathname,
        authenticated: signedIn,
        authorizationHeaderPresent: request.headers.authorization !== undefined,
      });

      if (requestUrl.pathname !== '/authorize') {
        send(response, 404, { 'Content-Type': 'text/plain' }, 'idp: not found');
        return;
      }

      const redirectUri = requestUrl.searchParams.get('redirect_uri');
      if (redirectUri === null) {
        send(response, 400, { 'Content-Type': 'text/plain' }, 'idp: missing redirect_uri');
        return;
      }
      const next = requestUrl.searchParams.get('next') ?? '/';

      const completeSignIn = (): void => {
        const target = new URL(redirectUri);
        target.searchParams.set('assertion', signAssertion(options.sharedSecret, FIXTURE_USERNAME));
        target.searchParams.set('next', next);
        send(response, 302, { Location: target.toString() }, '');
      };

      // An existing IdP session makes the redirect silent - this is what
      // distinguishes an "internal SSO redirect" from a real sign-in prompt,
      // the distinction requirements-decisions.md section 3 asks us to honour.
      if (signedIn) {
        completeSignIn();
        return;
      }

      if (request.method === 'POST') {
        const form = new URLSearchParams(await readBody(request));
        if (
          form.get('username') === FIXTURE_USERNAME &&
          form.get('password') === FIXTURE_PASSWORD
        ) {
          const id = randomUUID();
          sessions.add(id);
          const target = new URL(redirectUri);
          target.searchParams.set(
            'assertion',
            signAssertion(options.sharedSecret, FIXTURE_USERNAME),
          );
          target.searchParams.set('next', form.get('next') ?? next);
          send(
            response,
            302,
            {
              Location: target.toString(),
              'Set-Cookie': sessionCookie(IDP_SESSION_COOKIE, id, secure),
            },
            '',
          );
          return;
        }
        const retry = `${requestUrl.pathname}${requestUrl.search}`;
        send(
          response,
          401,
          { 'Content-Type': 'text/html; charset=utf-8' },
          loginFormHtml(retry, next, 'Wrong user or password.'),
        );
        return;
      }

      const action = `${requestUrl.pathname}${requestUrl.search}`;
      send(
        response,
        200,
        { 'Content-Type': 'text/html; charset=utf-8' },
        loginFormHtml(action, next, 'Corporate single sign-on.'),
      );
    })();
  };

  const server =
    options.tls === undefined
      ? http.createServer(handler)
      : https.createServer({ key: options.tls.key, cert: options.tls.cert }, handler);

  const port = await listen(server, undefined);
  const origin = `${secure ? 'https' : 'http'}://localhost:${String(port)}`;
  return {
    origin,
    port,
    log,
    url: (path) => `${origin}${path}`,
    close: () => closeServer(server),
  };
}

/**
 * Starts the AEM stand-in. Routes:
 *
 * - `GET /` and `GET /content/*` - protected; without a session cookie it
 *   redirects to the local login form, or to the IdP when `sso` is set.
 * - `GET|POST /login` - the local login form.
 * - `GET /sso/callback` - consumes the IdP assertion and mints the session.
 * - `GET /popup-launcher` - page with a button that opens `/popup`.
 * - `GET /popup` - sets {@link POPUP_COOKIE} and reports that it loaded.
 * - `GET /whoami` - JSON describing the caller's session, for assertions.
 * - `GET /logout` - clears the session cookie.
 */
export async function startAemOrigin(options: AemOriginOptions = {}): Promise<AemOrigin> {
  const log: AemRequestLogEntry[] = [];
  const secure = options.tls !== undefined;
  const sessions = new Set<string>();
  const remembered = new Set<string>();
  let selfOrigin = '';

  const handler = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    void (async () => {
      const requestUrl = new URL(request.url ?? '/', selfOrigin);
      const sessionId = readCookie(request.headers.cookie, AEM_SESSION_COOKIE);
      const rememberId = readCookie(request.headers.cookie, AEM_REMEMBER_COOKIE);
      // Either credential signs the caller in. The persistent one is what
      // carries the session across an application restart, exactly as AEM's
      // long-lived login-token does.
      const authenticated =
        (sessionId !== undefined && sessions.has(sessionId)) ||
        (rememberId !== undefined && remembered.has(rememberId));
      log.push({
        method: request.method ?? 'GET',
        path: requestUrl.pathname,
        authenticated,
        authorizationHeaderPresent: request.headers.authorization !== undefined,
      });

      // Checked before anything else: a Basic-auth origin must challenge even
      // for the login form, otherwise the "origin 401 vs proxy 407" test would
      // be measuring the wrong response.
      if (options.basicAuthRealm !== undefined) {
        const header = request.headers.authorization ?? '';
        const expected = `Basic ${Buffer.from(`${FIXTURE_USERNAME}:${FIXTURE_PASSWORD}`).toString('base64')}`;
        if (header !== expected) {
          send(
            response,
            401,
            {
              'WWW-Authenticate': `Basic realm="${options.basicAuthRealm}"`,
              'Content-Type': 'text/plain',
            },
            'aem: unauthorized',
          );
          return;
        }
      }

      const mintSession = (): readonly string[] => {
        const id = randomUUID();
        sessions.add(id);
        const rememberToken = randomUUID();
        remembered.add(rememberToken);
        return [
          sessionCookie(AEM_SESSION_COOKIE, id, secure),
          persistentCookie(AEM_REMEMBER_COOKIE, rememberToken, secure, 60 * 60 * 24 * 7),
        ];
      };

      switch (requestUrl.pathname) {
        case '/whoami': {
          send(
            response,
            200,
            { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
            JSON.stringify({ authenticated, user: authenticated ? FIXTURE_USERNAME : null }),
          );
          return;
        }

        case '/logout': {
          if (sessionId !== undefined) {
            sessions.delete(sessionId);
          }
          if (rememberId !== undefined) {
            remembered.delete(rememberId);
          }
          send(
            response,
            302,
            {
              Location: '/',
              'Set-Cookie': [
                `${AEM_SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`,
                `${AEM_REMEMBER_COOKIE}=; Path=/; HttpOnly; Max-Age=0`,
              ],
            },
            '',
          );
          return;
        }

        case '/popup': {
          send(
            response,
            200,
            {
              'Content-Type': 'text/html; charset=utf-8',
              'Set-Cookie': sessionCookie(POPUP_COOKIE, '1', secure),
            },
            `<!doctype html><html><head><meta charset="utf-8"><title>Popup</title></head>
<body><p id="popup-status">popup-loaded</p>
<button id="close-popup" onclick="window.close()">Close</button></body></html>`,
          );
          return;
        }

        case '/popup-launcher': {
          // `window.open` is driven by a click rather than on load so the test
          // controls exactly when the popup appears, and so a window-open policy
          // sees a user gesture like it would in real AEM.
          send(
            response,
            200,
            { 'Content-Type': 'text/html; charset=utf-8' },
            `<!doctype html><html><head><meta charset="utf-8"><title>Launcher</title></head>
<body><p id="launcher-status">launcher-loaded</p>
<button id="open-popup" onclick="window.open('/popup', 'daisy-popup', 'width=420,height=520')">Open popup</button>
</body></html>`,
          );
          return;
        }

        case '/sso/callback': {
          if (options.sso === undefined) {
            send(response, 404, { 'Content-Type': 'text/plain' }, 'aem: sso not configured');
            return;
          }
          const assertion = requestUrl.searchParams.get('assertion');
          const subject =
            assertion === null ? undefined : verifyAssertion(options.sso.sharedSecret, assertion);
          if (subject === undefined) {
            send(response, 403, { 'Content-Type': 'text/plain' }, 'aem: bad assertion');
            return;
          }
          send(
            response,
            302,
            {
              Location: requestUrl.searchParams.get('next') ?? '/',
              'Set-Cookie': mintSession(),
            },
            '',
          );
          return;
        }

        case '/login': {
          if (options.sso !== undefined) {
            send(response, 404, { 'Content-Type': 'text/plain' }, 'aem: local login disabled');
            return;
          }
          const next = requestUrl.searchParams.get('next') ?? '/';
          if (request.method === 'POST') {
            const form = new URLSearchParams(await readBody(request));
            if (
              form.get('username') === FIXTURE_USERNAME &&
              form.get('password') === FIXTURE_PASSWORD
            ) {
              send(
                response,
                302,
                { Location: form.get('next') ?? next, 'Set-Cookie': mintSession() },
                '',
              );
              return;
            }
            send(
              response,
              401,
              { 'Content-Type': 'text/html; charset=utf-8' },
              loginFormHtml('/login', form.get('next') ?? next, 'Wrong user or password.'),
            );
            return;
          }
          send(
            response,
            200,
            { 'Content-Type': 'text/html; charset=utf-8' },
            loginFormHtml('/login', next, 'Please sign in to AEM.'),
          );
          return;
        }

        default: {
          // ---------------------------------------------------------------
          // Sling-shaped JSON rendering (implementation-plan.md step 06).
          // Modelled on the real DefaultGetServlet: the LAST selector before
          // `.json` is the recursion level, depth 0 is properties-only and
          // depth 1 adds immediate children (verified against
          // apache/sling-org-apache-sling-servlets-get). Unauthenticated
          // requests fall through to the 302-to-login branch below, exactly
          // like any other AEM path, which is what lets a test prove that an
          // unauthenticated tool fetch is refused rather than answered.
          // ---------------------------------------------------------------
          // Sling resolves the resource path as the LONGEST prefix that exists,
          // so a dot inside a node name (`my.file.pdf`) belongs to the resource
          // rather than starting the selector chain. A fixture has no
          // repository to resolve against, so it relies on the fact that this
          // app always emits exactly one recursion selector: match a single
          // trailing selector token, and let everything before it - dots and
          // all - be the resource. A bare `.json` is accepted too, because
          // Sling treats it as `.0.json`.
          const jsonMatch =
            /^(?<resource>\/.*)\.(?<depth>[^./]*)\.json$/.exec(requestUrl.pathname) ??
            /^(?<resource>\/.*)\.json$/.exec(requestUrl.pathname);
          if (jsonMatch?.groups && authenticated) {
            const resource = jsonMatch.groups['resource'] ?? '';
            const depthToken = jsonMatch.groups['depth'];

            // Sling answers 400 when the last selector is present but is not a
            // number, `infinity`, or a formatting selector.
            const depth =
              depthToken === undefined || depthToken === 'tidy' || depthToken === 'harray'
                ? 0
                : depthToken === 'infinity' || depthToken === '-1'
                  ? -1
                  : /^\d+$/.test(depthToken)
                    ? Number(depthToken)
                    : Number.NaN;
            if (Number.isNaN(depth)) {
              send(
                response,
                400,
                { 'Content-Type': 'text/plain' },
                `Invalid recursion selector value '${depthToken ?? ''}'`,
              );
              return;
            }

            // The node this fixture serves for every resource path. `jcr:`
            // names are present deliberately: a namespaced property must
            // survive the whole round trip unmangled.
            const child = {
              'jcr:primaryType': 'nt:unstructured',
              'jcr:title': 'Child node',
              text: 'child body',
            };
            const node: Record<string, unknown> = {
              'jcr:primaryType': 'cq:Page',
              'jcr:title': `Title of ${resource}`,
              'jcr:path': resource,
              unicode: 'проверка',
            };
            if (depth !== 0) {
              node['jcr:content'] = child;
              node['child-two'] = { ...child, 'jcr:title': 'Second child' };
            }
            // Sling's too-many-results answer: HTTP 300 whose body is a valid
            // JSON ARRAY of alternative URLs. It is JSON, and it has a JSON
            // content type, but it is not the resource - a validator that only
            // asks "did this parse?" would accept it as data.
            if (resource.endsWith('/too-many')) {
              send(
                response,
                300,
                { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                JSON.stringify([`${resource}.1.json`, `${resource}.0.json`]),
              );
              return;
            }
            // A path that exists as HTML but answers HTML for .json, modelling
            // a misconfigured renderer - must never be read as data.
            if (resource.endsWith('/html-not-json')) {
              send(
                response,
                200,
                { 'Content-Type': 'text/html; charset=utf-8' },
                '<!doctype html><html><body>not json</body></html>',
              );
              return;
            }
            if (resource.endsWith('/forbidden')) {
              send(response, 403, { 'Content-Type': 'text/plain' }, 'aem: forbidden');
              return;
            }
            if (resource.endsWith('/missing')) {
              send(response, 404, { 'Content-Type': 'text/plain' }, 'aem: not found');
              return;
            }
            if (resource.endsWith('/broken-json')) {
              send(response, 200, { 'Content-Type': 'application/json' }, '{"unterminated": ');
              return;
            }
            // Deliberately larger than 1 MiB: the plan requires proving the
            // user-rejected byte cap has not reappeared.
            if (resource.endsWith('/large')) {
              send(
                response,
                200,
                { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                JSON.stringify({
                  'jcr:primaryType': 'nt:unstructured',
                  blob: 'x'.repeat(1_200_000),
                }),
              );
              return;
            }
            // Redirects to ANOTHER origin, modelling an IdP bounce mid-fetch.
            if (resource.endsWith('/redirect-away') && options.sso !== undefined) {
              send(response, 302, { Location: `${options.sso.origin}/authorize` }, '');
              return;
            }
            send(
              response,
              200,
              { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' },
              JSON.stringify(node),
            );
            return;
          }

          if (!authenticated) {
            const next = `${requestUrl.pathname}${requestUrl.search}`;
            if (options.sso !== undefined) {
              const target = new URL(`${options.sso.origin}/authorize`);
              target.searchParams.set('redirect_uri', `${selfOrigin}/sso/callback`);
              target.searchParams.set('next', next);
              send(response, 302, { Location: target.toString() }, '');
              return;
            }
            send(response, 302, { Location: `/login?next=${encodeURIComponent(next)}` }, '');
            return;
          }
          send(
            response,
            200,
            { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
            `<!doctype html><html><head><meta charset="utf-8"><title>AEM</title></head>
<body><h1 id="aem-heading">AEM content</h1>
<p id="aem-path">${escapeHtml(requestUrl.pathname)}</p>
<p id="aem-user">${FIXTURE_USERNAME}</p>
<p id="cookie-visible-to-script">${escapeHtml('')}</p>
<script>
  // Proves the session cookie is HttpOnly: if it were not, this would print it.
  document.getElementById("cookie-visible-to-script").textContent =
    document.cookie.includes("${AEM_SESSION_COOKIE}") ? "LEAKED" : "hidden";
</script>
</body></html>`,
          );
          return;
        }
      }
    })();
  };

  const server =
    options.tls === undefined
      ? http.createServer(handler)
      : https.createServer({ key: options.tls.key, cert: options.tls.cert }, handler);

  const port = await listen(server, options.port);
  selfOrigin = `${secure ? 'https' : 'http'}://localhost:${String(port)}`;

  return {
    origin: selfOrigin,
    port,
    log,
    url: (path) => `${selfOrigin}${path}`,
    invalidateSessions: () => {
      sessions.clear();
    },
    close: () => closeServer(server),
  };
}
