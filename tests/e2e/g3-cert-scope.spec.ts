import { _electron as electron, expect, test } from '@playwright/test';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { WebContentsView } from 'electron';
import { issueUntrustedLeafCert } from '../integration/support/testCa';

/**
 * Technical gate G3, certificate half (docs/requirements-decisions.md §10).
 *
 * G3 requires that "precisely scoped certificate exceptions apply to browser
 * fetch, not only page navigation", and stops if "trust extends to another
 * address or certificate".
 *
 * docs/implementation-plan.md step 05 warns that "a hostname-only API cannot
 * establish port-scoped pinning". `session.setCertificateVerifyProc()`
 * receives a `hostname` with no port; the `certificate-error` event receives
 * a full URL. So the decisive case is two HTTPS servers on the SAME hostname
 * with the SAME certificate, differing only by PORT: only a port-aware API
 * can approve one while still rejecting the other, and no fingerprint check
 * can separate them.
 *
 * Everything here is local and offline. Run with:
 *   npm run build && npx playwright test tests/e2e/g3-cert-scope.spec.ts
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results/g3-scratch');

interface ServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

interface VerifyCall {
  readonly keys: readonly string[];
  readonly hostname: string;
  readonly hasPortField: boolean;
  readonly errorCode: number;
  readonly verificationResult: string;
  readonly certFingerprint: string;
}

interface CertErrorCall {
  readonly url: string;
  readonly origin: string;
  readonly error: string;
  readonly certFingerprint: string;
  readonly decision: 'ALLOWED' | 'REJECTED';
}

interface CertException {
  origin: string;
  fingerprint: string;
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

async function startHttps(
  cert: { key: string; cert: string },
  body: string,
  fixedPort = 0,
): Promise<ServerHandle> {
  const server = createHttpsServer({ key: cert.key, cert: cert.cert }, (_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify({ served: body }));
  });
  await new Promise<void>((resolve) => server.listen(fixedPort, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function startPageHost(): Promise<ServerHandle> {
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><meta charset=utf-8><title>g3</title><body>g3 page host');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('G3: certificate exceptions are scoped to an exact origin and certificate', async () => {
  test.setTimeout(180_000);

  // One hostname ("localhost") for every server, so only the port differs.
  const sharedCert = await issueUntrustedLeafCert('localhost');
  const otherCert = await issueUntrustedLeafCert('localhost');

  const serverA = await startHttps(sharedCert, 'A-shared-cert');
  const serverB = await startHttps(sharedCert, 'B-shared-cert-different-port');
  const serverC = await startHttps(otherCert, 'C-different-cert');
  const pageHost = await startPageHost();

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

  let serverASwapped: ServerHandle | undefined;

  try {
    await application.evaluate(
      async ({ app, session, BrowserWindow, WebContentsView: View }, args) => {
        const verifyCalls: unknown[] = [];
        const certErrorCalls: unknown[] = [];
        const exceptions: CertException[] = [];
        Reflect.set(globalThis, 'g3VerifyCalls', verifyCalls);
        Reflect.set(globalThis, 'g3CertErrorCalls', certErrorCalls);
        Reflect.set(globalThis, 'g3Exceptions', exceptions);

        const aemSession = session.fromPartition('persist:g3-probe');

        // Pure observation: always defer to Chromium, so this file measures
        // the `certificate-error` path in isolation. Recording Object.keys
        // shows whether a port is exposed here at all.
        aemSession.setCertificateVerifyProc((request, callback) => {
          verifyCalls.push({
            keys: Object.keys(request),
            hostname: request.hostname,
            hasPortField: Object.keys(request).includes('port'),
            errorCode: request.errorCode,
            verificationResult: request.verificationResult,
            certFingerprint: request.certificate.fingerprint,
          });
          callback(-3);
        });

        // The product rule: an exception is bound to an EXACT origin
        // (scheme + host + port) AND the certificate fingerprint. Both match,
        // or the request is refused.
        app.on('certificate-error', (event, _wc, url, error, certificate, callback) => {
          const fingerprint = certificate.fingerprint;
          let origin = '';
          try {
            origin = new URL(url).origin;
          } catch {
            origin = '';
          }
          const matched = exceptions.some(
            (exception) => exception.origin === origin && exception.fingerprint === fingerprint,
          );
          certErrorCalls.push({
            url,
            origin,
            error,
            certFingerprint: fingerprint,
            decision: matched ? 'ALLOWED' : 'REJECTED',
          });
          if (matched) {
            event.preventDefault();
            callback(true);
            return;
          }
          callback(false);
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

        await view.webContents.loadURL(`http://localhost:${String(args.page)}/`);
      },
      { page: pageHost.port },
    );

    const runFetch = (port: number): Promise<string> =>
      application.evaluate(
        (_api, args) => {
          const view = Reflect.get(globalThis, 'g3View') as WebContentsView;
          return view.webContents.executeJavaScript(
            `fetch("https://localhost:${String(args.port)}/probe?t=" + Date.now())
             .then(r => r.text()).then(t => "OK:" + t)
             .catch(e => "FAIL:" + String(e && e.message))`,
            true,
          ) as Promise<string>;
        },
        { port },
      );

    const navigate = (port: number): Promise<string> =>
      application.evaluate(
        async (_api, args) => {
          const view = Reflect.get(globalThis, 'g3View') as WebContentsView;
          try {
            await view.webContents.loadURL(`https://localhost:${String(args.port)}/nav`);
            return 'NAV-OK';
          } catch (error) {
            return `NAV-FAIL:${String(error instanceof Error ? error.message : error)}`;
          }
        },
        { port },
      );

    const readVerify = (): Promise<VerifyCall[]> =>
      application.evaluate(() =>
        (Reflect.get(globalThis, 'g3VerifyCalls') as VerifyCall[]).slice(),
      );

    const readCertErrors = (): Promise<CertErrorCall[]> =>
      application.evaluate(() =>
        (Reflect.get(globalThis, 'g3CertErrorCalls') as CertErrorCall[]).slice(),
      );

    const setExceptions = (next: CertException[]): Promise<void> =>
      application.evaluate(
        (_api, args) => {
          const exceptions = Reflect.get(globalThis, 'g3Exceptions') as CertException[];
          exceptions.length = 0;
          exceptions.push(...args.next);
        },
        { next },
      );

    // --- PHASE 1: with no exception, TLS must fail closed for fetch --------
    const baselineA = await runFetch(serverA.port);
    const baselineC = await runFetch(serverC.port);
    console.log('PHASE 1 (no exception): A ->', baselineA, '| C ->', baselineC);
    expect(baselineA, 'untrusted TLS must fail closed for fetch').toContain('FAIL');
    expect(baselineC, 'untrusted TLS must fail closed for fetch').toContain('FAIL');

    const verifyCalls = await readVerify();
    const certErrors = await readCertErrors();
    console.log('verifyProc request keys:', JSON.stringify(verifyCalls[0]?.keys));
    console.log('certificate-error origins:', certErrors.map((call) => call.origin).join(', '));

    // The plan's warning, confirmed against this Electron build rather than
    // against the documentation: verifyProc cannot express a port.
    expect(verifyCalls.length, 'verifyProc must have been consulted').toBeGreaterThan(0);
    expect(
      verifyCalls[0]?.hasPortField,
      'setCertificateVerifyProc must not expose a port (hostname-only)',
    ).toBe(false);
    // ...while certificate-error carries a full URL, port included, and it
    // fires for fetch - not only for top-level navigation.
    expect(certErrors.length, 'certificate-error must fire for fetch').toBeGreaterThan(0);
    expect(certErrors[0]?.origin).toMatch(/^https:\/\/localhost:\d+$/);

    // --- PHASE 2: approve ONLY origin A, by exact origin + fingerprint -----
    const originA = `https://localhost:${String(serverA.port)}`;
    const fingerprintA = certErrors.find((call) => call.origin === originA)?.certFingerprint ?? '';
    expect(fingerprintA, 'must observe a fingerprint for origin A').not.toBe('');
    await setExceptions([{ origin: originA, fingerprint: fingerprintA }]);

    const resultA = await runFetch(serverA.port);
    const resultB = await runFetch(serverB.port);
    const resultC = await runFetch(serverC.port);
    console.log(
      `PHASE 2: A(${String(serverA.port)}) -> ${resultA} | ` +
        `B(${String(serverB.port)}, SAME cert) -> ${resultB} | ` +
        `C(${String(serverC.port)}, other cert) -> ${resultC}`,
    );

    // G3 stop condition: "trust extends to another address". B serves a
    // BYTE-IDENTICAL certificate on the same hostname and differs only by
    // port, so this is what proves port-scoped pinning is genuinely enforced.
    expect(resultA, 'approved origin must be reachable').toContain('OK:');
    expect(resultB, 'same certificate on a non-approved PORT must stay rejected').toContain('FAIL');
    expect(resultC, 'a different certificate must stay rejected').toContain('FAIL');

    // --- PHASE 3: navigation must honour the same scoping ------------------
    const navA = await navigate(serverA.port);
    const navB = await navigate(serverB.port);
    console.log('PHASE 3: navigate A ->', navA, '| navigate B ->', navB);
    expect(navA).toBe('NAV-OK');
    expect(navB).toContain('NAV-FAIL');

    // --- PHASE 4: Chromium caches the ALLOW decision -----------------------
    // Revoking the exception alone does NOT take effect: Chromium no longer
    // consults us for a (host, port, cert) pair it has already been told to
    // trust. This is a real constraint on the Settings "remove exception" UX.
    await setExceptions([]);
    const afterRevoke = await runFetch(serverA.port);
    console.log('PHASE 4: after revoking the exception, A ->', afterRevoke);
    expect(
      afterRevoke,
      'documents observed behaviour: the cached ALLOW survives mere revocation',
    ).toContain('OK:');

    // --- PHASE 5: closeAllConnections() clears that cache ------------------
    await application.evaluate(async ({ session }) => {
      await session.fromPartition('persist:g3-probe').clearHostResolverCache();
    });
    const afterResolverCache = await runFetch(serverA.port);
    console.log('PHASE 5: after clearHostResolverCache(), A ->', afterResolverCache);
    expect(afterResolverCache, 'clearHostResolverCache does NOT clear SSL decisions').toContain(
      'OK:',
    );

    await application.evaluate(async ({ session }) => {
      await session.fromPartition('persist:g3-probe').closeAllConnections();
    });
    const afterCloseConnections = await runFetch(serverA.port);
    console.log('PHASE 5: after closeAllConnections(), A ->', afterCloseConnections);
    expect(
      afterCloseConnections,
      'closeAllConnections() must re-arm the certificate decision',
    ).toContain('FAIL');

    // --- PHASE 6: a changed certificate forces a new decision --------------
    // Re-approve origin A pinned to the ORIGINAL fingerprint, then serve a
    // DIFFERENT certificate on the very same origin.
    await setExceptions([{ origin: originA, fingerprint: fingerprintA }]);
    const reusedPort = serverA.port;
    await serverA.close();
    serverASwapped = await startHttps(otherCert, 'A-SWAPPED-CERT', reusedPort);

    const swapped = await runFetch(reusedPort);
    console.log('PHASE 6: same origin, different certificate ->', swapped);
    // G3 stop condition: "trust extends to another certificate".
    expect(
      swapped,
      'a changed certificate on an approved origin must require a NEW decision',
    ).toContain('FAIL');

    const finalErrors = await readCertErrors();
    const swapEntry = finalErrors[finalErrors.length - 1];
    expect(swapEntry?.decision).toBe('REJECTED');
    expect(
      swapEntry?.certFingerprint,
      'the rejected certificate must be the NEW one, not the pinned one',
    ).not.toBe(fingerprintA);
  } finally {
    await application.close().catch(() => undefined);
    await Promise.all([
      serverA.close().catch(() => undefined),
      serverB.close(),
      serverC.close(),
      pageHost.close(),
      serverASwapped ? serverASwapped.close() : Promise.resolve(),
    ]);
    try {
      rmSync(scratchRoot, { recursive: true, force: true });
    } catch {
      // Windows can hold handles briefly after Electron exits.
    }
  }
});
