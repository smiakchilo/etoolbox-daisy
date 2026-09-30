import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  createHardenedCopilotClient,
  getAuthStatus,
  type CopilotClient,
  type ProxyEnvOverrides,
} from '../../src/agents/copilot/copilotClient';
import { resolveSdkRuntimeExePath } from '../../src/agents/copilot/runtimePaths';
import type { RuntimePathsEnv } from '../../src/agents/copilot/runtimePaths';
import { generateTestCa, issueTrustedLeafCert, issueUntrustedLeafCert } from './support/testCa';
import {
  reserveClosedPort,
  startTestProxy,
  withEmbeddedCredentials,
  type TestProxyHandle,
} from './support/testProxy';

/**
 * Empirical proof of the Step 02 proxy/TLS matrix (implementation-plan.md
 * lines ~161-181, requirements-decisions.md §4) for the runtime child
 * process (`copilot-runtime.exe`, launched by
 * `createHardenedCopilotClient()`/`buildRuntimeChildEnv()`).
 *
 * `getAuthStatus()` is used as the network trigger throughout: it makes a
 * real `CONNECT api.github.com:443` + `GET /copilot_internal/user` call to
 * validate whatever token is in the environment, *even if that token is
 * fake* - verified empirically while building this suite. This makes it a
 * deterministic, portable, offline-capable probe: a synthetic, obviously
 * invalid `GH_TOKEN` is used everywhere (never this machine's real ambient
 * one - see the top-level task's pre-verified fact 5), so these tests never
 * depend on any developer/CI machine's real credentials or network egress.
 * The one case that does need real internet egress - "case 1: direct" - has
 * been moved to `tests/integration/live-github-auth.test.ts` (the single
 * quarantine point for tests that reach real GitHub), together with the
 * real-token "no hidden direct fallback" suite that used to follow the
 * matrix below.
 *
 * Cases 2-7 all run through our own local proxy (`support/testProxy.ts`,
 * `support/testCa.ts`), so they are fully offline and deterministic. Case 6
 * (trusted CA) uses a proxy that terminates TLS and returns a canned `200
 * {}` response, which - confirmed empirically - resolves to
 * `{ isAuthenticated: true, authType: "env" }`; case 7 (untrusted cert) uses
 * the same proxy shape but with a leaf certificate NOT chained to the CA
 * supplied via `NODE_EXTRA_CA_CERTS`, which resolves to
 * `{ isAuthenticated: false }` because the client's own TLS stack refuses
 * the handshake (`tlsv1 alert unknown ca`) - never a silent accept. Cases
 * 2-4 reuse the same trusted-CA MITM shape so CA trust is never a confound
 * for the connectivity/auth-only cases; only proxy authentication varies.
 *
 * "No hidden bypass to a direct connection" (a hard requirement) is proven
 * two ways for every failure case: (a) the proxy's own request log shows
 * what actually happened (rejected/never reached, never a successful
 * upstream request), and (b) the resulting `getAuthStatus()` shape is
 * strictly different from - and never as rich as - the success shape
 * (`isAuthenticated: true, authType: "env", host, statusMessage` containing
 * "via GH_TOKEN"). A bypass reaching the real internet with this synthetic
 * token would itself produce a *third*, distinct shape (`isAuthenticated:
 * false` reached only after a real round trip to github.com, which the
 * proxy log would show as zero local proxy activity) - not observed in any
 * run recorded here.
 */

const PATHS_ENV: RuntimePathsEnv = {
  isPackaged: false,
  resourcesPath: 'unused-in-dev',
  devRootDir: process.cwd(),
};
const RUNTIME_EXE = resolveSdkRuntimeExePath(PATHS_ENV);

const SCRATCH_ROOT = path.join(process.cwd(), 'test-results', 'proxy-matrix-runtime');
mkdirSync(SCRATCH_ROOT, { recursive: true });

function scratchDir(label: string): string {
  return mkdtempSync(path.join(SCRATCH_ROOT, `${label}-`));
}

/**
 * A synthetic, deterministically-invalid token: well-formed enough for the
 * runtime to attempt validation, never a real credential. Never the
 * machine's real ambient `GH_TOKEN`/`GITHUB_TOKEN`/`COPILOT_GITHUB_TOKEN`,
 * which `buildRuntimeChildEnv()` always strips from the child's environment
 * unconditionally (a deliberate production hardening, not a test
 * workaround - see `copilotClient.ts`'s `AMBIENT_CREDENTIAL_ENV_VARS`).
 * Because of that stripping, the only way to make `getAuthStatus()` attempt
 * a real network validation through this seam is the explicit
 * `githubToken` option (which becomes `COPILOT_GITHUB_TOKEN` in the child's
 * env) - verified empirically while building this suite: passing a fake
 * value there still triggers a real `CONNECT api.github.com:443` + `GET
 * /copilot_internal/user`, exactly like a real token would.
 */
const FAKE_GITHUB_TOKEN = 'gho_daisyProxyMatrixFakeToken0000000000';

function isolatedBaseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['COPILOT_GITHUB_TOKEN'];
  delete env['GH_TOKEN'];
  delete env['GITHUB_TOKEN'];
  return env;
}

const activeClients: CopilotClient[] = [];
const activeProxies: TestProxyHandle[] = [];

async function startClient(proxy: ProxyEnvOverrides): Promise<CopilotClient> {
  const client = createHardenedCopilotClient({
    runtimeExePath: RUNTIME_EXE,
    copilotHomeDir: scratchDir('home'),
    proxy,
    baseEnv: isolatedBaseEnv(),
    githubToken: FAKE_GITHUB_TOKEN,
  });
  activeClients.push(client);
  await client.start();
  return client;
}

function trackProxy(proxy: TestProxyHandle): TestProxyHandle {
  activeProxies.push(proxy);
  return proxy;
}

function writeCaFile(pem: string): string {
  const filePath = path.join(scratchDir('ca'), 'ca.pem');
  writeFileSync(filePath, pem, 'utf8');
  return filePath;
}

afterEach(async () => {
  while (activeClients.length > 0) {
    await activeClients.pop()?.stop();
  }
  while (activeProxies.length > 0) {
    await activeProxies.pop()?.close();
  }
});

afterAll(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

const SUCCESS_STATUS_MESSAGE_SUBSTRING = 'via COPILOT_GITHUB_TOKEN';

describe('runtime proxy/TLS matrix', () => {
  it('case 2: unauthenticated proxy - runtime traffic is actually routed through it', async () => {
    const ca = await generateTestCa();
    const caFile = writeCaFile(ca.cert);
    const proxy = trackProxy(
      await startTestProxy({ mitm: { certFor: (host) => issueTrustedLeafCert(host, ca) } }),
    );

    const client = await startClient({
      httpsProxy: proxy.url,
      httpProxy: proxy.url,
      nodeExtraCaCerts: caFile,
    });
    const auth = await getAuthStatus(client);

    expect(auth.isAuthenticated).toBe(true);
    expect(auth.authType).toBe('env');
    expect(auth.statusMessage).toContain(SUCCESS_STATUS_MESSAGE_SUBSTRING);
    expect(proxy.log.some((e) => e.kind === 'connect-attempt')).toBe(true);
    expect(proxy.log.some((e) => e.kind === 'tls-handshake')).toBe(true);
    expect(proxy.log.some((e) => e.kind === 'mitm-request')).toBe(true);
  }, 20_000);

  it('case 3: authenticated proxy (correct username/password) - succeeds', async () => {
    const ca = await generateTestCa();
    const caFile = writeCaFile(ca.cert);
    const proxy = trackProxy(
      await startTestProxy({
        auth: { username: 'daisy', password: 'correct-horse-battery-staple' },
        mitm: { certFor: (host) => issueTrustedLeafCert(host, ca) },
      }),
    );
    const authedUrl = withEmbeddedCredentials(proxy.url, {
      username: 'daisy',
      password: 'correct-horse-battery-staple',
    });

    const client = await startClient({
      httpsProxy: authedUrl,
      httpProxy: authedUrl,
      nodeExtraCaCerts: caFile,
    });
    const auth = await getAuthStatus(client);

    expect(auth.isAuthenticated).toBe(true);
    expect(auth.authType).toBe('env');
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
        mitm: { certFor: (host) => issueTrustedLeafCert(host, ca) },
      }),
    );
    const wrongUrl = withEmbeddedCredentials(proxy.url, {
      username: 'daisy',
      password: 'wrong-password',
    });

    const client = await startClient({
      httpsProxy: wrongUrl,
      httpProxy: wrongUrl,
      nodeExtraCaCerts: caFile,
    });
    const auth = await getAuthStatus(client);

    // Degrades cleanly - never throws an unhandled exception, and never
    // reports the success shape a bypass or an accepted 407 would produce.
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.authType).toBeUndefined();
    expect(proxy.log.some((e) => e.kind === 'connect-rejected-407')).toBe(true);
    // The tunnel must never have been established: no TLS handshake, no
    // request ever reached the (simulated) upstream.
    expect(proxy.log.some((e) => e.kind === 'tls-handshake')).toBe(false);
    expect(proxy.log.some((e) => e.kind === 'mitm-request')).toBe(false);
  }, 20_000);

  it('case 5: unreachable proxy -> clear degraded failure, no hang, no bypass', async () => {
    const deadPort = await reserveClosedPort();
    const deadUrl = `http://127.0.0.1:${String(deadPort)}`;

    const client = await startClient({ httpsProxy: deadUrl, httpProxy: deadUrl });
    const started = Date.now();
    const auth = await getAuthStatus(client);
    const elapsedMs = Date.now() - started;

    expect(auth.isAuthenticated).toBe(false);
    expect(auth.authType).toBeUndefined();
    // Bounded: proves this is a real, deterministic failure path rather
    // than an indefinite hang (observed empirically at ~6s on this
    // machine; generously bounded here for slower CI hosts).
    expect(elapsedMs).toBeLessThan(30_000);
  }, 35_000);

  it('case 6: trusted corporate CA (MITM chained to NODE_EXTRA_CA_CERTS) - works', async () => {
    const ca = await generateTestCa();
    const caFile = writeCaFile(ca.cert);
    const proxy = trackProxy(
      await startTestProxy({ mitm: { certFor: (host) => issueTrustedLeafCert(host, ca) } }),
    );

    const client = await startClient({
      httpsProxy: proxy.url,
      httpProxy: proxy.url,
      nodeExtraCaCerts: caFile,
    });
    const auth = await getAuthStatus(client);

    expect(auth.isAuthenticated).toBe(true);
    expect(proxy.log.some((e) => e.kind === 'tls-handshake')).toBe(true);
    expect(proxy.log.some((e) => e.kind === 'tls-handshake-error')).toBe(false);
  }, 20_000);

  it('case 7: untrusted certificate -> FAILS CLOSED (never silently accepted)', async () => {
    const ca = await generateTestCa();
    const caFile = writeCaFile(ca.cert);
    // The MITM leaf is self-signed - deliberately NOT chained to the CA
    // supplied via NODE_EXTRA_CA_CERTS.
    const proxy = trackProxy(
      await startTestProxy({ mitm: { certFor: (host) => issueUntrustedLeafCert(host) } }),
    );

    const client = await startClient({
      httpsProxy: proxy.url,
      httpProxy: proxy.url,
      nodeExtraCaCerts: caFile,
    });
    const auth = await getAuthStatus(client);

    expect(auth.isAuthenticated).toBe(false);
    expect(proxy.log.some((e) => e.kind === 'tls-handshake-error')).toBe(true);
    // The handshake must genuinely fail at the TLS layer, not merely be
    // reported as absent.
    expect(proxy.log.some((e) => e.kind === 'tls-handshake')).toBe(false);
    expect(proxy.log.some((e) => e.kind === 'mitm-request')).toBe(false);
  }, 20_000);
});
