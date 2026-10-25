import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { assertNoPlaintextCredentials } from '../../src/agents/copilot/auth';
import { generateTestCa, issueTrustedLeafCert, issueUntrustedLeafCert } from './support/testCa';
import { resolveCopilotCliExe } from '../support/copilotCliPath';
import {
  reserveClosedPort,
  startTestProxy,
  withEmbeddedCredentials,
  type TestProxyHandle,
} from './support/testProxy';
import { cleanupVaultEntry, runSyntheticWebFlowLogin } from './support/syntheticLogin';

/**
 * Empirical proof of the Step 02 proxy/TLS matrix (implementation-plan.md
 * lines ~161-181, requirements-decisions.md §4) for the login child process
 * (`copilot.exe login --web-flow`, launched by
 * `startWebFlowLogin()`/`buildLoginChildEnv()`).
 *
 * The web flow has two networking phases with very different proxy/TLS
 * relevance:
 *
 *  1. The CLI prints an authorize URL and opens it in the SYSTEM BROWSER,
 *     which then talks to GitHub's own servers and eventually redirects to a
 *     random loopback port the CLI is listening on. This phase is made by
 *     the browser, not the CLI - it has its own network configuration and
 *     this app must not (and does not) try to make it proxy-aware. See the
 *     top-level task's hard requirements.
 *  2. Once the loopback callback fires, the CLI itself makes two outbound
 *     HTTPS calls with its OWN HTTP client: `POST
 *     https://github.com/login/oauth/access_token` (exchange the code for a
 *     token), then `GET https://api.github.com/copilot_internal/user`
 *     (resolve the account). *These* calls honour `HTTPS_PROXY`/
 *     `NODE_EXTRA_CA_CERTS` - verified empirically while building this
 *     suite - which is exactly the portion this matrix needs to prove.
 *
 * `runSyntheticWebFlowLogin()` (see `support/syntheticLogin.ts`) removes the
 * need for a real browser or a real GitHub account: it reads the authorize
 * URL the CLI itself printed, then makes the same HTTP GET request a
 * browser's redirect would make to the CLI's own loopback server, with a
 * synthetic (deliberately invalid) authorization code. Everything from that
 * point on is the real, unmodified production code path.
 *
 * All cases here use a local MITM proxy (`support/testProxy.ts`,
 * `support/testCa.ts`) that terminates TLS itself and returns a canned JSON
 * body containing both an `access_token` and a `login` field - confirmed
 * empirically to satisfy both the token-exchange response shape the CLI
 * expects AND the user-lookup response shape, producing a genuine `Signed in
 * successfully as <login>.` / exit code 0 - so these tests are fully
 * offline, deterministic, and never depend on any real GitHub account or
 * internet egress. The one case that did need real internet egress and a
 * human ("case 1: direct") has been moved to
 * `tests/integration/live-github-auth.test.ts` (the single quarantine point
 * for tests that reach real GitHub).
 *
 * "No hidden bypass to a direct connection" is proven the same way as in
 * `proxy-runtime.test.ts`: the proxy's own request log shows exactly what
 * happened (or, for the unreachable-proxy case, that nothing could have
 * happened because nothing is listening there), and every failure case's
 * error message is inspected to confirm it names the actual failure
 * encountered while trying to reach the proxy/upstream - not a distinct
 * "reached the real internet with a bad code" shape (which, empirically,
 * produces a *different* error: a real `invalid_grant` from GitHub, never
 * observed in any run recorded here because the synthetic code never leaves
 * this machine).
 */

const CLI_EXE = resolveCopilotCliExe();

const SCRATCH_ROOT = path.join(process.cwd(), 'test-results', 'proxy-matrix-login');
mkdirSync(SCRATCH_ROOT, { recursive: true });

function scratchHomeDir(): string {
  return mkdtempSync(path.join(SCRATCH_ROOT, 'home-'));
}

function writeCaFile(pem: string): string {
  const dir = mkdtempSync(path.join(SCRATCH_ROOT, 'ca-'));
  const filePath = path.join(dir, 'ca.pem');
  writeFileSync(filePath, pem, 'utf8');
  return filePath;
}

/**
 * The login used everywhere the MITM proxy fabricates a successful token
 * exchange + user lookup. Synthetic, never a real account - see
 * `syntheticLogin.ts`'s `cleanupVaultEntry` doc comment for why the
 * corresponding OS vault entry is cleaned up after each test that reaches
 * this shape.
 */
const FAKE_LOGIN = 'daisy-proxy-matrix-fake-login';

function mitmSuccessResponse(): string {
  const body = JSON.stringify({
    access_token: 'gho_daisyProxyMatrixFakeLoginToken00000',
    token_type: 'bearer',
    login: FAKE_LOGIN,
  });
  return `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${String(
    Buffer.byteLength(body),
  )}\r\n\r\n${body}`;
}

const activeProxies: TestProxyHandle[] = [];
function trackProxy(proxy: TestProxyHandle): TestProxyHandle {
  activeProxies.push(proxy);
  return proxy;
}

afterEach(async () => {
  while (activeProxies.length > 0) {
    await activeProxies.pop()?.close();
  }
  // Best-effort: only actually removes anything for the cases that reached
  // a real (synthetic) success and wrote a vault entry.
  await cleanupVaultEntry(FAKE_LOGIN);
});

afterAll(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

describe('login proxy/TLS matrix', () => {
  it('case 2: unauthenticated proxy - login traffic is actually routed through it', async () => {
    const ca = await generateTestCa();
    const caFile = writeCaFile(ca.cert);
    const proxy = trackProxy(
      await startTestProxy({
        mitm: {
          certFor: (host) => issueTrustedLeafCert(host, ca),
          response: mitmSuccessResponse(),
        },
      }),
    );
    const copilotHomeDir = scratchHomeDir();

    const result = await runSyntheticWebFlowLogin(CLI_EXE, {
      copilotHomeDir,
      proxy: { httpsProxy: proxy.url, httpProxy: proxy.url, nodeExtraCaCerts: caFile },
      timeoutMs: 15_000,
    });

    expect(result.outcome.status).toBe('success');
    expect(
      proxy.log.some((e) => e.kind === 'connect-attempt' && e.target === 'github.com:443'),
    ).toBe(true);
    expect(proxy.log.some((e) => e.kind === 'tls-handshake' && e.target === 'github.com:443')).toBe(
      true,
    );
    expect(
      proxy.log.some(
        (e) =>
          e.kind === 'mitm-request' && e.requestLine.startsWith('POST /login/oauth/access_token'),
      ),
    ).toBe(true);
    expect(
      proxy.log.some(
        (e) => e.kind === 'mitm-request' && e.requestLine.startsWith('GET /copilot_internal/user'),
      ),
    ).toBe(true);

    // The real production write path: a vault-backed credential, never
    // plaintext, proving this was not a bypass that fabricated success.
    await expect(assertNoPlaintextCredentials(copilotHomeDir)).resolves.toBeUndefined();
  }, 20_000);

  it('case 3: authenticated proxy (correct username/password) - succeeds', async () => {
    const ca = await generateTestCa();
    const caFile = writeCaFile(ca.cert);
    const proxy = trackProxy(
      await startTestProxy({
        auth: { username: 'daisy', password: 'correct-horse-battery-staple' },
        mitm: {
          certFor: (host) => issueTrustedLeafCert(host, ca),
          response: mitmSuccessResponse(),
        },
      }),
    );
    const authedUrl = withEmbeddedCredentials(proxy.url, {
      username: 'daisy',
      password: 'correct-horse-battery-staple',
    });

    const result = await runSyntheticWebFlowLogin(CLI_EXE, {
      copilotHomeDir: scratchHomeDir(),
      proxy: { httpsProxy: authedUrl, httpProxy: authedUrl, nodeExtraCaCerts: caFile },
      timeoutMs: 15_000,
    });

    expect(result.outcome.status).toBe('success');
    const connectAttempts = proxy.log.filter((e) => e.kind === 'connect-attempt');
    expect(connectAttempts.length).toBeGreaterThan(0);
    expect(connectAttempts.every((e) => e.kind === 'connect-attempt' && e.authHeaderPresent)).toBe(
      true,
    );
    expect(proxy.log.some((e) => e.kind === 'connect-rejected-407')).toBe(false);
  }, 20_000);

  it('case 4: incorrect proxy password -> 407, handled as a clear failure (no bypass)', async () => {
    const ca = await generateTestCa();
    const caFile = writeCaFile(ca.cert);
    const proxy = trackProxy(
      await startTestProxy({
        auth: { username: 'daisy', password: 'correct-horse-battery-staple' },
        mitm: {
          certFor: (host) => issueTrustedLeafCert(host, ca),
          response: mitmSuccessResponse(),
        },
      }),
    );
    const wrongUrl = withEmbeddedCredentials(proxy.url, {
      username: 'daisy',
      password: 'wrong-password',
    });
    const copilotHomeDir = scratchHomeDir();

    const result = await runSyntheticWebFlowLogin(CLI_EXE, {
      copilotHomeDir,
      proxy: { httpsProxy: wrongUrl, httpProxy: wrongUrl, nodeExtraCaCerts: caFile },
      timeoutMs: 15_000,
    });

    expect(result.outcome.status).toBe('failed');
    if (result.outcome.status === 'failed') {
      // Names the actual request that failed - the token exchange - never
      // a generic/silent failure a bypass would produce.
      expect(result.outcome.message).toContain('login/oauth/access_token');
    }
    expect(proxy.log.some((e) => e.kind === 'connect-rejected-407')).toBe(true);
    // The tunnel must never have been established: no TLS handshake, no
    // request ever reached the (simulated) upstream.
    expect(proxy.log.some((e) => e.kind === 'tls-handshake')).toBe(false);
    expect(proxy.log.some((e) => e.kind === 'mitm-request')).toBe(false);
    await expect(assertNoPlaintextCredentials(copilotHomeDir)).resolves.toBeUndefined();
  }, 20_000);

  it('case 5: unreachable proxy -> clear degraded failure, no hang, no bypass', async () => {
    const deadPort = await reserveClosedPort();
    const deadUrl = `http://127.0.0.1:${String(deadPort)}`;

    const result = await runSyntheticWebFlowLogin(CLI_EXE, {
      copilotHomeDir: scratchHomeDir(),
      proxy: { httpsProxy: deadUrl, httpProxy: deadUrl },
      timeoutMs: 15_000,
    });

    expect(result.outcome.status).toBe('failed');
    if (result.outcome.status === 'failed') {
      expect(result.outcome.message).toContain('login/oauth/access_token');
    }
    // Bounded: proves this is a real, deterministic failure path rather
    // than an indefinite hang (observed empirically at ~4.1s on this
    // machine; generously bounded here for slower CI hosts).
    expect(result.elapsedMsSinceCallback).toBeLessThan(30_000);
  }, 35_000);

  it('case 6: trusted corporate CA (MITM chained to NODE_EXTRA_CA_CERTS) - works', async () => {
    const ca = await generateTestCa();
    const caFile = writeCaFile(ca.cert);
    const proxy = trackProxy(
      await startTestProxy({
        mitm: {
          certFor: (host) => issueTrustedLeafCert(host, ca),
          response: mitmSuccessResponse(),
        },
      }),
    );

    const result = await runSyntheticWebFlowLogin(CLI_EXE, {
      copilotHomeDir: scratchHomeDir(),
      proxy: { httpsProxy: proxy.url, httpProxy: proxy.url, nodeExtraCaCerts: caFile },
      timeoutMs: 15_000,
    });

    expect(result.outcome.status).toBe('success');
    expect(proxy.log.some((e) => e.kind === 'tls-handshake')).toBe(true);
    expect(proxy.log.some((e) => e.kind === 'tls-handshake-error')).toBe(false);
  }, 20_000);

  it('case 7: untrusted certificate -> FAILS CLOSED (never silently accepted)', async () => {
    const ca = await generateTestCa();
    const caFile = writeCaFile(ca.cert);
    // The MITM leaf is self-signed - deliberately NOT chained to the CA
    // supplied via NODE_EXTRA_CA_CERTS.
    const proxy = trackProxy(
      await startTestProxy({
        mitm: { certFor: (host) => issueUntrustedLeafCert(host), response: mitmSuccessResponse() },
      }),
    );
    const copilotHomeDir = scratchHomeDir();

    const result = await runSyntheticWebFlowLogin(CLI_EXE, {
      copilotHomeDir,
      proxy: { httpsProxy: proxy.url, httpProxy: proxy.url, nodeExtraCaCerts: caFile },
      timeoutMs: 15_000,
    });

    expect(result.outcome.status).toBe('failed');
    if (result.outcome.status === 'failed') {
      expect(result.outcome.message).toContain('login/oauth/access_token');
    }
    // The attempt went through the proxy (no direct-connection bypass)...
    expect(
      proxy.log.some((e) => e.kind === 'connect-attempt' && e.target === 'github.com:443'),
    ).toBe(true);
    // ...but not a single byte of application data was sent over the
    // untrusted tunnel. Where the rejection surfaces on the proxy side is
    // client-specific: a verifier that checks the chain during the handshake
    // yields `tls-handshake-error`, while the CLI's current client (@github/
    // copilot 1.0.83) validates the chain after the handshake completes, so
    // the proxy logs `tls-handshake` and the client then drops the tunnel.
    // Either way, no request reaching the MITM is what "fails closed" means.
    expect(proxy.log.some((e) => e.kind === 'mitm-request')).toBe(false);
    await expect(assertNoPlaintextCredentials(copilotHomeDir)).resolves.toBeUndefined();
  }, 20_000);
});
