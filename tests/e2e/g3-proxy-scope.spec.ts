import { _electron as electron, expect, test } from '@playwright/test';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { WebContentsView } from 'electron';
import { issueUntrustedLeafCert } from '../integration/support/testCa';
import { startTestProxy, type TestProxyHandle } from '../integration/support/testProxy';

/**
 * Technical gate G3, proxy half (docs/requirements-decisions.md §10).
 *
 *   1. Does `session.setProxy()` route page-initiated `fetch()` - both plain
 *      HTTP and HTTPS via CONNECT - and not merely top-level navigation?
 *   2. After switching proxies, does anything still use the OLD proxy?
 *      (G3 stop condition: "old sockets/windows use the wrong proxy".)
 *   3. Does proxy auth (407) work for fetch, and can a PROXY challenge be
 *      told apart from an AEM/IdP 401 so credentials are never misrouted?
 *
 * NOTE: Chromium bypasses proxies for loopback addresses by default, so every
 * `setProxy` call here passes `proxyBypassRules: "<-loopback>"`. Without it
 * these experiments would appear to pass while proving nothing at all,
 * because the traffic would never reach the test proxy.
 *
 * Everything here is local and offline. Run with:
 *   npm run build && npx playwright test tests/e2e/g3-proxy-scope.spec.ts
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results/g3-proxy-scratch');
const PROXY_USER = 'daisy-proxy-user';
const PROXY_PASS = 'daisy-proxy-pass';

interface ServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

interface LoginEvent {
  readonly url: string;
  readonly isProxy: boolean;
  readonly host: string;
  readonly port: number;
  readonly realm: string;
}

interface ProxyCreds {
  user: string;
  pass: string;
  supply: boolean;
}

function definedEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/** Plain HTTP origin. `/401` returns a server (NOT proxy) auth challenge. */
async function startOrigin(label: string): Promise<ServerHandle> {
  const server = createHttpServer((req, res) => {
    if (req.url?.startsWith('/401') === true) {
      res.writeHead(401, {
        'www-authenticate': 'Basic realm="aem-origin"',
        'access-control-allow-origin': '*',
      });
      res.end('origin auth required');
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify({ origin: label }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function startHttpsOrigin(cert: { key: string; cert: string }): Promise<ServerHandle> {
  const server = createHttpsServer({ key: cert.key, cert: cert.cert }, (_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify({ origin: 'https-origin' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function summarise(proxy: TestProxyHandle): string {
  if (proxy.log.length === 0) {
    return '(no requests)';
  }
  return proxy.log
    .map((entry) => {
      if (entry.kind === 'plain-http-forward') {
        return `plain-http-forward ${entry.method} ${entry.url}`;
      }
      if (entry.kind === 'connect-attempt') {
        return `connect-attempt ${entry.target} auth=${String(entry.authHeaderPresent)}`;
      }
      return entry.kind;
    })
    .join('\n    ');
}

test('G3: proxy selection, switching and 407 apply to page-initiated fetch', async () => {
  test.setTimeout(240_000);

  const httpsCert = await issueUntrustedLeafCert('localhost');
  const originHttp = await startOrigin('http-origin');
  const originHttps = await startHttpsOrigin(httpsCert);
  const pageHost = await startOrigin('page-host');

  const proxyA = await startTestProxy();
  const proxyB = await startTestProxy();
  const proxyAuth = await startTestProxy({
    auth: { username: PROXY_USER, password: PROXY_PASS },
  });

  mkdirSync(scratchBase, { recursive: true });
  const scratchRoot = mkdtempSync(path.join(scratchBase, 'probe-'));
  const home = path.join(scratchRoot, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });

  const application = await electron.launch({
    args: [mainEntry],
    env: {
      ...definedEnv(process.env),
      USERPROFILE: home,
      HOME: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
    },
  });

  try {
    await application.evaluate(
      ({ app, session, BrowserWindow, WebContentsView: View }, args) => {
        const loginEvents: LoginEvent[] = [];
        const creds: ProxyCreds = { user: '', pass: '', supply: false };
        Reflect.set(globalThis, 'g3LoginEvents', loginEvents);
        Reflect.set(globalThis, 'g3Creds', creds);

        const aemSession = session.fromPartition('persist:g3-proxy');

        // Approve exactly the https origin's self-signed certificate, so the
        // CONNECT experiment can complete instead of dying at the handshake.
        app.on('certificate-error', (event, _wc, url, _error, _cert, callback) => {
          let origin: string;
          try {
            origin = new URL(url).origin;
          } catch {
            origin = '';
          }
          if (origin === args.httpsOrigin) {
            event.preventDefault();
            callback(true);
            return;
          }
          callback(false);
        });

        app.on('login', (event, _wc, details, authInfo, callback) => {
          loginEvents.push({
            url: details.url,
            isProxy: authInfo.isProxy,
            host: authInfo.host,
            port: authInfo.port,
            realm: authInfo.realm,
          });
          // Only ever answer PROXY challenges - never hand proxy credentials
          // to an origin or an identity provider.
          if (creds.supply && authInfo.isProxy) {
            event.preventDefault();
            callback(creds.user, creds.pass);
            return;
          }
          callback();
        });

        const win = new BrowserWindow({ show: false, width: 900, height: 700 });
        const view = new View({
          webPreferences: {
            session: aemSession,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        win.contentView.addChildView(view);
        view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
        Reflect.set(globalThis, 'g3Win', win);
        Reflect.set(globalThis, 'g3View', view);
      },
      { httpsOrigin: `https://localhost:${String(originHttps.port)}` },
    );

    const setProxy = (port: number, closeConnections: boolean): Promise<void> =>
      application.evaluate(
        async ({ session }, args) => {
          const aemSession = session.fromPartition('persist:g3-proxy');
          await aemSession.setProxy({
            proxyRules: `http://127.0.0.1:${String(args.port)}`,
            // Without this, loopback targets never reach the proxy at all.
            proxyBypassRules: '<-loopback>',
          });
          if (args.closeConnections) {
            await aemSession.closeAllConnections();
          }
        },
        { port, closeConnections },
      );

    const loadPage = (viewKey: string, port: number): Promise<void> =>
      application.evaluate(
        async (_api, args) => {
          const view = Reflect.get(globalThis, args.viewKey) as WebContentsView;
          await view.webContents.loadURL(`http://localhost:${String(args.port)}/`);
        },
        { viewKey, port },
      );

    const doFetch = (url: string, viewKey = 'g3View'): Promise<string> =>
      application.evaluate(
        (_api, args) => {
          const view = Reflect.get(globalThis, args.viewKey) as WebContentsView;
          return view.webContents.executeJavaScript(
            `fetch(${JSON.stringify(args.url)} + "?t=" + Date.now())
             .then(r => r.status + ":" + r.statusText)
             .catch(e => "FAIL:" + String(e && e.message))`,
            true,
          ) as Promise<string>;
        },
        { url, viewKey },
      );

    const readLoginEvents = (): Promise<LoginEvent[]> =>
      application.evaluate(() =>
        (Reflect.get(globalThis, 'g3LoginEvents') as LoginEvent[]).slice(),
      );

    const httpTarget = `http://localhost:${String(originHttp.port)}/data`;
    const httpsTarget = `https://localhost:${String(originHttps.port)}/data`;

    // --- EXPERIMENT 1: does setProxy apply to page-initiated fetch? --------
    await setProxy(proxyA.port, true);
    await loadPage('g3View', pageHost.port);
    const httpViaA = await doFetch(httpTarget);
    const httpsViaA = await doFetch(httpsTarget);
    console.log('EXP 1: fetch http ->', httpViaA, '| fetch https ->', httpsViaA);
    console.log('  proxy A log:\n    ' + summarise(proxyA));

    expect(httpViaA).toContain('200');
    expect(httpsViaA).toContain('200');
    // The decisive part: the FETCH (not just the page load) must appear in
    // the proxy log - absolute-URI GET for http, CONNECT for https.
    expect(
      proxyA.log.some(
        (entry) => entry.kind === 'plain-http-forward' && entry.url.includes('/data'),
      ),
      'page-initiated http fetch must be proxied',
    ).toBe(true);
    expect(
      proxyA.log.some((entry) => entry.kind === 'connect-attempt'),
      'page-initiated https fetch must use CONNECT through the proxy',
    ).toBe(true);
    expect(proxyB.log.length, 'the unselected proxy must see nothing').toBe(0);

    // --- EXPERIMENT 2: switching must leave nothing on the old proxy -------
    const aBeforeSwitch = proxyA.log.length;
    await setProxy(proxyB.port, true);
    const httpViaB = await doFetch(httpTarget);
    const httpsViaB = await doFetch(httpsTarget);
    console.log('EXP 2: after switch, fetch http ->', httpViaB, '| https ->', httpsViaB);
    expect(httpViaB).toContain('200');
    expect(httpsViaB).toContain('200');
    expect(
      proxyA.log.length - aBeforeSwitch,
      'no traffic may reach the OLD proxy after a switch',
    ).toBe(0);
    expect(proxyB.log.length, 'the newly selected proxy must carry the traffic').toBeGreaterThan(0);

    // A view that already existed BEFORE the switch must also move over -
    // this is the "old windows use the wrong proxy" stop condition.
    await application.evaluate(({ session, WebContentsView: View }) => {
      const aemSession = session.fromPartition('persist:g3-proxy');
      const second = new View({
        webPreferences: {
          session: aemSession,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      const win = Reflect.get(globalThis, 'g3Win') as Electron.BrowserWindow;
      win.contentView.addChildView(second);
      second.setBounds({ x: 0, y: 0, width: 400, height: 300 });
      Reflect.set(globalThis, 'g3Second', second);
    });
    await loadPage('g3Second', pageHost.port);

    const aBeforeSecondSwitch = proxyA.log.length;
    const bBeforeSecondSwitch = proxyB.log.length;
    await setProxy(proxyA.port, true);
    const secondViewFetch = await doFetch(httpTarget, 'g3Second');
    console.log('EXP 2: pre-existing view after switch ->', secondViewFetch);
    expect(secondViewFetch).toContain('200');
    expect(
      proxyB.log.length - bBeforeSecondSwitch,
      'a view created BEFORE the switch must not use the old proxy',
    ).toBe(0);
    expect(
      proxyA.log.length - aBeforeSecondSwitch,
      'a view created BEFORE the switch must use the new proxy',
    ).toBeGreaterThan(0);

    // --- EXPERIMENT 3: 407 for fetch, and 407 vs an origin 401 ------------
    await setProxy(proxyAuth.port, true);
    const unauthed = await doFetch(httpTarget);
    const proxyChallenges = await readLoginEvents();
    console.log('EXP 3a: unanswered 407 ->', unauthed);
    console.log('  challenge:', JSON.stringify(proxyChallenges[0]));
    expect(unauthed, 'an unanswered 407 must fail the fetch').toContain('FAIL');
    expect(proxyChallenges[0]?.isProxy, 'a 407 must be reported as a proxy challenge').toBe(true);
    expect(proxyChallenges[0]?.port, "the challenge must name the SELECTED proxy's port").toBe(
      proxyAuth.port,
    );

    await application.evaluate(
      (_api, args) => {
        const creds = Reflect.get(globalThis, 'g3Creds') as ProxyCreds;
        creds.user = args.user;
        creds.pass = args.pass;
        creds.supply = true;
      },
      { user: PROXY_USER, pass: PROXY_PASS },
    );
    await setProxy(proxyAuth.port, true);

    const authedHttp = await doFetch(httpTarget);
    const authedHttps = await doFetch(httpsTarget);
    console.log('EXP 3b: with credentials, http ->', authedHttp, '| https ->', authedHttps);
    expect(authedHttp).toContain('200');
    expect(authedHttps).toContain('200');
    expect(
      proxyAuth.log.some((entry) => entry.kind === 'connect-attempt' && entry.authHeaderPresent),
      'the authenticated CONNECT must carry proxy credentials',
    ).toBe(true);

    // An ORIGIN 401 must never look like a proxy challenge, or proxy
    // credentials could be offered to AEM or an identity provider.
    await application.evaluate(() => {
      (Reflect.get(globalThis, 'g3LoginEvents') as LoginEvent[]).length = 0;
    });
    const origin401 = await doFetch(`http://localhost:${String(originHttp.port)}/401`);
    await application.evaluate(
      async (_api, args) => {
        const view = Reflect.get(globalThis, 'g3View') as WebContentsView;
        try {
          await view.webContents.loadURL(`http://localhost:${String(args.port)}/401`);
        } catch {
          // Navigation failure is fine; only the login event matters here.
        }
      },
      { port: originHttp.port },
    );
    const originChallenges = await readLoginEvents();
    console.log('EXP 3c: origin 401 ->', origin401);
    console.log('  challenge:', JSON.stringify(originChallenges[0]));

    expect(originChallenges.length, 'the origin challenge must be observed').toBeGreaterThan(0);
    expect(
      originChallenges[0]?.isProxy,
      'an origin 401 must NOT be reported as a proxy challenge',
    ).toBe(false);
    expect(originChallenges[0]?.port, "the origin challenge must name the origin's port").toBe(
      originHttp.port,
    );
  } finally {
    await application.close().catch(() => undefined);
    await Promise.all([
      proxyA.close(),
      proxyB.close(),
      proxyAuth.close(),
      originHttp.close(),
      originHttps.close(),
      pageHost.close(),
    ]);
    try {
      rmSync(scratchRoot, { recursive: true, force: true });
    } catch {
      // Windows can hold handles briefly after Electron exits.
    }
  }
});
