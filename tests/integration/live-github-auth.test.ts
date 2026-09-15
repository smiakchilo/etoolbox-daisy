import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  assertNoPlaintextCredentials,
  createHardenedCopilotClient,
  createHardenedSession,
  getAuthStatus,
  localSignOut,
  resolveCliExePath,
  resolveSdkRuntimeExePath,
  resumeHardenedSession,
  SKILL_INVOCATION_TOOL,
  startWebFlowLogin,
  type CopilotClient,
  type ProxyEnvOverrides,
} from '../../src/agent';
import type { RuntimePathsEnv } from '../../src/agent/runtimePaths';
import { realGithubLoginApproved, realLoginSuite } from './support/liveAuthPolicy';
import { runSyntheticWebFlowLogin } from './support/syntheticLogin';
import {
  reserveClosedPort,
  startTestProxy,
  withEmbeddedCredentials,
  type TestProxyHandle,
} from './support/testProxy';

/**
 * SINGLE QUARANTINE POINT for every test that authenticates against real
 * GitHub (web-flow sign-ins, and requests made with a real or synthetic
 * `GH_TOKEN`/`githubToken` against the real `api.github.com`/Copilot
 * backend).
 *
 * It exists because re-running such tests while iterating got the project
 * owner's GitHub account rate-limited ("tarpitted"), and repeated automated
 * sign-in/auth traffic against a real account risks tripping corporate
 * suspicious-activity monitoring. Consolidating every such test into this one
 * file, gated behind a single `APPROVED` constant (see below), makes it
 * possible to audit and disable ALL real-GitHub-auth traffic from one place
 * instead of hunting for it across the test suite.
 *
 * Consolidated from three source files:
 *  - `agent-auth-live.test.ts` (deleted; all 5 of its suites moved here in
 *    full),
 *  - `proxy-runtime.test.ts` ("case 1: direct" and the "no hidden direct
 *    fallback (real token, real internet)" suite - the only two of its
 *    suites that reach real GitHub; cases 2-7 stayed behind, MITM-only),
 *  - `proxy-login.test.ts` ("case 1: direct (no proxy, requires real
 *    internet + a human)" - the only one of its suites that reaches real
 *    GitHub; cases 2-7 stayed behind, MITM-only).
 *
 * Anything added later that authenticates against real GitHub - a new
 * web-flow test, a new proxy/matrix case that uses a real or synthetic token
 * against the real backend, anything else that dials out to
 * `api.github.com` with credentials - belongs in THIS file and nowhere else.
 * Do not add a real-auth test to any other file, and do not remove the
 * `APPROVED` gate from any suite here.
 */

/**
 * Live, authenticated end-to-end verification of the Step 02 requirements
 * that cannot be proven without a real GitHub sign-in:
 *
 *  - the bundled `copilot.exe login --web-flow` really authenticates into an
 *    app-owned `COPILOT_HOME` (gate G2),
 *  - the resulting credential is NOT written to that directory in plaintext,
 *  - a hardened session genuinely refuses to execute built-in tools, proven
 *    by the absence of `tool.execution_start` for a prompt that explicitly
 *    demands a file read (gate G5 - behavioural proof, not a system prompt),
 *  - the same restrictions still hold after `resumeHardenedSession`, which
 *    matters because `ResumeSessionConfig` is never persisted by the runtime.
 *
 * Opt-in: this opens a real browser window and consumes a real Copilot
 * request, so it must never run as part of `npm run verify`.
 *
 * **Currently BLOCKED by project policy.** Every suite in this file generates
 * real GitHub authentication traffic - web-flow sign-ins, a deliberately
 * *rejected* token (i.e. a failed auth attempt), and real token auths - and
 * re-running it while iterating on step 02 got an account rate-limited.
 * `DAISY_LIVE_AUTH=1` is no longer sufficient to run any of it; see
 * `support/liveAuthPolicy.ts`. When disabled the suites are skipped
 * explicitly, with the reason visible in the suite name, rather than passing
 * vacuously.
 *
 * The control proving the instrumentation is capable of observing a real tool
 * execution (an unfiltered session DOES emit `tool.execution_start(view)`)
 * was run separately during Step 02 verification and is recorded in
 * docs/verification.md; it is not repeated here because `src/agent` only
 * exposes hardened session constructors by design.
 */
const APPROVED = realGithubLoginApproved;
const LIVE = process.env['DAISY_LIVE_AUTH'] === '1' && APPROVED;

/** Dev-tree path resolution used by every live test in this file. */
function pathsEnvFor(): RuntimePathsEnv {
  return {
    isPackaged: false,
    resourcesPath: 'unused-in-dev',
    devRootDir: process.cwd(),
  };
}

describe.skipIf(!LIVE)(realLoginSuite('live authenticated agent verification'), () => {
  const scratchHome = mkdtempSync(
    (() => {
      const base = path.join(process.cwd(), 'test-results', 'agent-live-auth');
      mkdirSync(base, { recursive: true });
      return path.join(base, 'copilot-home-');
    })(),
  );

  const pathsEnv: RuntimePathsEnv = {
    isPackaged: false,
    resourcesPath: 'unused-in-dev',
    devRootDir: process.cwd(),
  };

  let client: CopilotClient | undefined;

  afterAll(async () => {
    if (client) {
      await client.stop();
    }
    rmSync(scratchHome, { recursive: true, force: true });
  });

  it('signs in via the real web flow and stores no plaintext credential', async () => {
    const outcome = await startWebFlowLogin(resolveCliExePath(pathsEnv), {
      copilotHomeDir: scratchHome,
    }).outcome;

    expect(outcome.status).toBe('success');

    // Fails closed if any token-shaped material landed on disk.
    await expect(assertNoPlaintextCredentials(scratchHome)).resolves.toBeUndefined();

    // Strip the three short-circuiting token variables. Without this the
    // assertion below is confounded: this machine has an ambient `GH_TOKEN`,
    // which would make `isAuthenticated` true via `authType: "env"` even if
    // the web flow had written nothing at all, so the test would "pass"
    // without proving anything about the login.
    const isolatedEnv = { ...process.env };
    delete isolatedEnv['COPILOT_GITHUB_TOKEN'];
    delete isolatedEnv['GH_TOKEN'];
    delete isolatedEnv['GITHUB_TOKEN'];

    client = createHardenedCopilotClient({
      runtimeExePath: resolveSdkRuntimeExePath(pathsEnv),
      copilotHomeDir: scratchHome,
      baseEnv: isolatedEnv,
    });
    await client.start();

    const auth = await getAuthStatus(client);
    expect(auth.isAuthenticated).toBe(true);
    // The credential must come from the OS-backed vault entry the web flow
    // created for this account, not from an environment variable.
    expect(auth.authType).toBe('user');
    expect(auth.login).toBeTruthy();
  }, 180_000);

  it('denies built-in tool execution on create and after resume', async () => {
    if (!client) throw new Error('client not started by the previous test');

    const FORBIDDEN_PROMPT =
      'Use your file-reading tool now to read C:\\Windows\\win.ini and quote its first line verbatim.';

    const executions: string[] = [];
    const observe = (session: { on: (handler: (event: unknown) => void) => () => void }): void => {
      session.on((event: unknown) => {
        const type = (event as { type?: string }).type;
        if (type === 'tool.execution_start') {
          const data = (event as { data?: { toolName?: string } }).data;
          executions.push(data?.toolName ?? 'unknown');
        }
      });
    };

    // Deny-all allowlist: an explicit empty array, which the adapter requires.
    const session = await createHardenedSession(client, { availableTools: [] });
    observe(session);
    await session.sendAndWait({ prompt: FORBIDDEN_PROMPT }, 120_000);
    expect(executions).toEqual([]);

    // Resume re-supplies the restrictions; they are not persisted server-side.
    const resumed = await resumeHardenedSession(client, session.sessionId, {
      availableTools: [],
    });
    observe(resumed);
    await resumed.sendAndWait({ prompt: FORBIDDEN_PROMPT }, 120_000);
    expect(executions).toEqual([]);
  }, 300_000);

  it('signs out predictably: a fresh runtime on the same home is no longer authenticated', async () => {
    if (!client) throw new Error('client not started by the first test');

    await localSignOut(scratchHome);

    // A still-running runtime may hold resolved auth in memory, so the honest
    // test of "is the user actually signed out" is whether a FRESH runtime
    // process, pointed at the same app-owned COPILOT_HOME, still finds a
    // credential. The machine-wide vault entry deliberately survives sign-out
    // (see `localSignOut`'s doc comment), so this asserts that our
    // active-account pointer removal is what actually governs app auth.
    await client.stop();
    client = undefined;

    const isolatedEnv = { ...process.env };
    delete isolatedEnv['COPILOT_GITHUB_TOKEN'];
    delete isolatedEnv['GH_TOKEN'];
    delete isolatedEnv['GITHUB_TOKEN'];

    const fresh = createHardenedCopilotClient({
      runtimeExePath: resolveSdkRuntimeExePath(pathsEnv),
      copilotHomeDir: scratchHome,
      baseEnv: isolatedEnv,
    });
    client = fresh;
    await fresh.start();

    const auth = await getAuthStatus(fresh);
    expect(auth.isAuthenticated).toBe(false);
  }, 120_000);

  it('reports a cancelled login as cancelled, not as success or a crash', async () => {
    // Cancellation is a mandatory step 02 scenario. This spawns the real CLI
    // and terminates it the way the UI's Cancel button does, so it proves the
    // outcome mapping rather than mocking it. It briefly opens a browser tab.
    const handle = startWebFlowLogin(resolveCliExePath(pathsEnv), {
      copilotHomeDir: scratchHome,
    });
    // Give the child a moment to actually start before signalling cancel.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    handle.cancel();

    const outcome = await handle.outcome;
    expect(outcome.status).toBe('cancelled');
  }, 60_000);
});

/**
 * Scenarios that require a specific human action in the browser and therefore
 * cannot be automated. Each is gated behind its own env var so it only runs
 * when a human is present and knows what to do.
 */
describe.skipIf(process.env['DAISY_LIVE_DENY'] !== '1' || !APPROVED)(
  realLoginSuite('login denial (human-driven)'),
  () => {
    const scratchHome = mkdtempSync(
      (() => {
        const base = path.join(process.cwd(), 'test-results', 'agent-live-deny');
        mkdirSync(base, { recursive: true });
        return path.join(base, 'copilot-home-');
      })(),
    );

    afterAll(() => {
      rmSync(scratchHome, { recursive: true, force: true });
    });

    it('surfaces a denied authorization as a clear failure and writes no credential', async () => {
      console.log('\n>>> ACTION REQUIRED: a browser will open. Click Cancel / deny access. <<<\n');
      console.log(
        ">>> Your browser will then show '127.0.0.1 refused to connect' - expected. <<<\n",
      );

      const outcome = await startWebFlowLogin(
        resolveCliExePath({
          isPackaged: false,
          resourcesPath: 'unused-in-dev',
          devRootDir: process.cwd(),
        }),
        { copilotHomeDir: scratchHome, timeoutMs: 30_000 },
      ).outcome;

      // GitHub redirects a denial to the OAuth app's registered callback
      // (`http://127.0.0.1/callback`, no port) rather than the CLI's random
      // loopback port, so the CLI never learns it was denied and never exits.
      // Our timeout is what turns that hang into an actionable failure.
      expect(outcome.status).toBe('failed');
      if (outcome.status === 'failed') {
        expect(outcome.message).toContain('refused to connect');
        console.log('denial message:', outcome.message);
      }

      // No credential material may be left behind by a denied login.
      await expect(assertNoPlaintextCredentials(scratchHome)).resolves.toBeUndefined();
    }, 60_000);
  },
);

/**
 * Requires signing in as a GitHub account that does NOT have a Copilot
 * subscription (or lacks the organization's Copilot permission). Gated behind
 * its own env var because it needs both a human and a specific account.
 */
describe.skipIf(!LIVE || !process.env['GH_TOKEN'])(realLoginSuite('bundled skill'), () => {
  // U9 / plan step 02: "Verify a bundled skill without granting arbitrary
  // file reads." Authenticated with an explicitly supplied token so the test
  // is self-contained and needs no browser; the runtime and session are
  // otherwise identical to the hardened production path.
  const scratchHome = mkdtempSync(
    (() => {
      const base = path.join(process.cwd(), 'test-results', 'agent-live-skill');
      mkdirSync(base, { recursive: true });
      return path.join(base, 'copilot-home-');
    })(),
  );

  let client: CopilotClient | undefined;

  afterAll(async () => {
    if (client) {
      await client.stop();
    }
    rmSync(scratchHome, { recursive: true, force: true });
  });

  it('loads a bundled skill without granting any filesystem tools', async () => {
    const skillDir = path.resolve(process.cwd(), 'resources', 'skills');
    expect(existsSync(path.join(skillDir, 'aem-daisy-conventions', 'SKILL.md'))).toBe(true);

    const isolatedEnv = { ...process.env };
    delete isolatedEnv['COPILOT_GITHUB_TOKEN'];
    delete isolatedEnv['GH_TOKEN'];
    delete isolatedEnv['GITHUB_TOKEN'];

    client = createHardenedCopilotClient({
      runtimeExePath: resolveSdkRuntimeExePath(pathsEnvFor()),
      copilotHomeDir: scratchHome,
      baseEnv: isolatedEnv,
      githubToken: process.env['GH_TOKEN'] ?? '',
    });
    await client.start();

    // `availableTools: []` means the model has no read/write/shell tool at
    // all, so a correct answer can only come from skill content injected into
    // the prompt - it cannot have read SKILL.md itself.
    const session = await createHardenedSession(client, {
      availableTools: [],
      bundledSkillDirectories: [skillDir],
    });

    const toolStarts: string[] = [];
    session.on((event: unknown) => {
      const e = event as { type?: string; data?: { toolName?: string } };
      if (e.type === 'tool.execution_start') {
        toolStarts.push(e.data?.toolName ?? 'unknown');
      }
    });

    // Ask the runtime directly whether the bundled skill was discovered,
    // instead of inferring it from the model's answer (a model will happily
    // invent plausible skill content when no skill is loaded - observed).
    await session.rpc.skills.ensureLoaded();
    const skillList = (await session.rpc.skills.list()) as unknown as {
      skills?: { name?: string; source?: string; enabled?: boolean; path?: string }[];
    };
    const bundled = (skillList.skills ?? []).find((s) => s.name === 'aem-daisy-conventions');
    expect(bundled?.enabled).toBe(true);
    expect(bundled?.path).toBe(path.join(skillDir, 'aem-daisy-conventions', 'SKILL.md'));

    // The session must be offered exactly one tool: the skill helper.
    await session.rpc.tools.initializeAndValidate();
    const toolMeta = (await session.rpc.tools.getCurrentMetadata()) as unknown as {
      tools?: { name?: string }[];
    };
    expect((toolMeta.tools ?? []).map((t) => t.name)).toEqual([SKILL_INVOCATION_TOOL]);

    const reply = await session.sendAndWait(
      {
        prompt:
          'Use the aem-daisy-conventions skill. Reply with the EToolbox Daisy ' +
          'skill verification phrase and nothing else.',
      },
      180_000,
    );
    const text = JSON.stringify(reply);
    console.log('bundled-skill reply:', text.slice(0, 500));
    console.log('bundled-skill tool starts:', JSON.stringify(toolStarts));

    expect(text).toContain('daisy-skill-loaded-ok');
    // The only tool the model may run is the narrow skill-invocation helper.
    // No read/write/shell/git tool may appear.
    expect(toolStarts.filter((name) => name !== SKILL_INVOCATION_TOOL)).toEqual([]);
    expect(toolStarts).toContain(SKILL_INVOCATION_TOOL);
  }, 240_000);
});

describe.skipIf(!LIVE)(realLoginSuite('expired or invalid credential'), () => {
  const scratchHome = mkdtempSync(
    (() => {
      const base = path.join(process.cwd(), 'test-results', 'agent-live-invalid');
      mkdirSync(base, { recursive: true });
      return path.join(base, 'copilot-home-');
    })(),
  );

  let client: CopilotClient | undefined;

  afterAll(async () => {
    if (client) {
      await client.stop();
    }
    rmSync(scratchHome, { recursive: true, force: true });
  });

  it('surfaces an actionable error rather than hanging when the credential is rejected', async () => {
    // Stands in for credential expiration without needing a browser: an
    // explicitly supplied but invalid token exercises exactly the same
    // rejected-credential path the runtime takes when a stored credential has
    // expired. It also covers the Settings token field end to end, since
    // `githubToken` is the only way a token reaches the runtime now that
    // ambient token variables are stripped.
    const isolatedEnv = { ...process.env };
    delete isolatedEnv['COPILOT_GITHUB_TOKEN'];
    delete isolatedEnv['GH_TOKEN'];
    delete isolatedEnv['GITHUB_TOKEN'];

    client = createHardenedCopilotClient({
      runtimeExePath: resolveSdkRuntimeExePath(pathsEnvFor()),
      copilotHomeDir: scratchHome,
      baseEnv: isolatedEnv,
      githubToken: 'gho_thisTokenIsDeliberatelyInvalid0000000000',
    });
    await client.start();

    const session = await createHardenedSession(client, { availableTools: [] });
    const errors: string[] = [];
    session.on((event: unknown) => {
      const e = event as { type?: string; data?: { message?: string } };
      if (e.type === 'session.error') {
        errors.push(e.data?.message ?? '');
      }
    });

    let thrown: string | undefined;
    try {
      await session.sendAndWait({ prompt: 'Say hello.' }, 120_000);
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }

    console.log('invalid-credential thrown:', thrown);
    console.log('invalid-credential session.error events:', JSON.stringify(errors));

    expect(Boolean(thrown) || errors.length > 0).toBe(true);
  }, 180_000);

  it.skipIf(!process.env['GH_TOKEN'])(
    'honours an explicitly supplied valid token (Settings token field)',
    async () => {
      // Uses this machine's ambient GH_TOKEN as a known-good value, but feeds
      // it in the ONLY supported way: explicitly, through the client option.
      // Ambient variables are stripped, so if this authenticates, the explicit
      // path genuinely works end to end.
      const isolatedEnv = { ...process.env };
      delete isolatedEnv['COPILOT_GITHUB_TOKEN'];
      delete isolatedEnv['GH_TOKEN'];
      delete isolatedEnv['GITHUB_TOKEN'];

      const tokenHome = mkdtempSync(path.join(path.dirname(scratchHome), 'token-home-'));
      const tokenClient = createHardenedCopilotClient({
        runtimeExePath: resolveSdkRuntimeExePath(pathsEnvFor()),
        copilotHomeDir: tokenHome,
        baseEnv: isolatedEnv,
        githubToken: process.env['GH_TOKEN'] ?? '',
      });
      try {
        await tokenClient.start();
        const auth = await getAuthStatus(tokenClient);
        console.log('explicit-token auth status:', JSON.stringify(auth));
        expect(auth.isAuthenticated).toBe(true);
      } finally {
        await tokenClient.stop();
        rmSync(tokenHome, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

describe.skipIf(process.env['DAISY_LIVE_NOSUB'] !== '1' || !APPROVED)(
  realLoginSuite('missing Copilot subscription (human-driven)'),
  () => {
    const scratchHome = mkdtempSync(
      (() => {
        const base = path.join(process.cwd(), 'test-results', 'agent-live-nosub');
        mkdirSync(base, { recursive: true });
        return path.join(base, 'copilot-home-');
      })(),
    );

    let client: CopilotClient | undefined;

    afterAll(async () => {
      if (client) {
        await client.stop();
      }
      rmSync(scratchHome, { recursive: true, force: true });
    });

    it('fails a real request with an actionable error instead of hanging or crashing', async () => {
      console.log(
        '\n>>> ACTION REQUIRED: sign in as the account WITHOUT a Copilot subscription. <<<\n',
      );

      const login = await startWebFlowLogin(resolveCliExePath(pathsEnvFor()), {
        copilotHomeDir: scratchHome,
        timeoutMs: 180_000,
      }).outcome;
      expect(login.status).toBe('success');

      const isolatedEnv = { ...process.env };
      delete isolatedEnv['COPILOT_GITHUB_TOKEN'];
      delete isolatedEnv['GH_TOKEN'];
      delete isolatedEnv['GITHUB_TOKEN'];

      client = createHardenedCopilotClient({
        runtimeExePath: resolveSdkRuntimeExePath(pathsEnvFor()),
        copilotHomeDir: scratchHome,
        baseEnv: isolatedEnv,
      });
      await client.start();

      const auth = await getAuthStatus(client);
      console.log('auth status for no-subscription account:', JSON.stringify(auth));

      // Signing in succeeds (the identity is valid); the entitlement failure
      // must appear when a real model request is attempted, and it must be a
      // surfaced error rather than a hang or an unhandled crash.
      const session = await createHardenedSession(client, { availableTools: [] });
      const errors: string[] = [];
      session.on((event: unknown) => {
        const e = event as { type?: string; data?: { message?: string } };
        if (e.type === 'session.error') {
          errors.push(e.data?.message ?? '');
        }
      });

      let thrown: string | undefined;
      try {
        await session.sendAndWait({ prompt: 'Say hello.' }, 120_000);
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
      }

      console.log('thrown:', thrown);
      console.log('session.error events:', JSON.stringify(errors));

      // Either path is acceptable; silence is not.
      expect(Boolean(thrown) || errors.length > 0).toBe(true);
    }, 420_000);
  },
);

/**
 * The three real-GitHub suites ported from `proxy-runtime.test.ts` and
 * `proxy-login.test.ts` (each of which otherwise only exercises a local MITM
 * proxy with canned responses and never touches real GitHub - see those
 * files' header comments). This harness is deliberately a self-contained
 * duplicate of the small helpers in those files (`isolatedBaseEnv`,
 * `scratchDir`, `startClient`, `trackProxy`, `RUNTIME_EXE`, `CLI_EXE`,
 * `FAKE_GITHUB_TOKEN`) rather than a shared import: a quarantined file must
 * not depend on mutable module state owned by an enabled file.
 */

const PATHS_ENV: RuntimePathsEnv = {
  isPackaged: false,
  resourcesPath: 'unused-in-dev',
  devRootDir: process.cwd(),
};
const RUNTIME_EXE = resolveSdkRuntimeExePath(PATHS_ENV);
/** The CLI (`copilot.exe`), used only for `login` - distinct from `RUNTIME_EXE`. */
const CLI_EXE = resolveCliExePath(PATHS_ENV);

const SCRATCH_ROOT = path.join(process.cwd(), 'test-results', 'live-github-auth');
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

const LIVE_PROXY = process.env['DAISY_LIVE_PROXY'] === '1';

describe.skipIf(!LIVE_PROXY || !APPROVED)(
  realLoginSuite('case 1: direct (no proxy, requires real internet)'),
  () => {
    it('reaches the real api.github.com directly and resolves without hanging or throwing', async () => {
      const client = await startClient({});
      const auth = await getAuthStatus(client);
      // No proxy is configured, so this exercises real internet egress. The
      // synthetic token is invalid against the real server, so this only
      // proves baseline direct connectivity works (a control for the rest
      // of the matrix in proxy-runtime.test.ts, cases 2-7), not that
      // authentication succeeds.
      expect(typeof auth.isAuthenticated).toBe('boolean');
    }, 20_000);
  },
);

describe.skipIf(!LIVE_PROXY || !APPROVED)(
  realLoginSuite('case 1: direct (no proxy, requires real internet + a human)'),
  () => {
    it('prints a real authorize URL and reaches the real github.com when the synthetic code is rejected', async () => {
      const result = await runSyntheticWebFlowLogin(
        CLI_EXE,
        { copilotHomeDir: scratchDir('home'), timeoutMs: 20_000 },
        'daisy-synthetic-code-direct',
      );
      // A synthetic code is invalid against the real GitHub, so this only
      // proves baseline direct connectivity (a control), not that login
      // succeeds: the real server must reject it, but must do so promptly
      // and cleanly (never hang, never crash).
      expect(result.outcome.status).toBe('failed');
    }, 30_000);
  },
);

/**
 * Decisive "no hidden direct fallback" proof.
 *
 * The matrix in proxy-runtime.test.ts (cases 2-7) uses a deliberately-invalid
 * token, which makes the *blocked* outcome (`isAuthenticated: false`)
 * indistinguishable from a *bypassed-then-rejected* outcome: if the runtime
 * silently fell back to a direct connection when the proxy was unusable, the
 * fake token would still be refused by the real api.github.com and those
 * assertions would pass anyway. Those cases therefore prove "the proxy
 * blocked it" only via the proxy's own log, and case 5 (unreachable proxy)
 * has no log at all.
 *
 * This suite removes the ambiguity by using a token that *would* succeed.
 * A control run with no proxy must report `isAuthenticated: true`; the same
 * token behind an unusable proxy (unreachable, and 407) must then report
 * `false`. Any hidden direct fallback would flip those to `true`, which is
 * an outcome no amount of proxy-log reasoning could explain away.
 *
 * Gated because it needs real internet egress and a real credential.
 */
describe.skipIf(!(process.env['DAISY_LIVE_PROXY'] === '1' && process.env['GH_TOKEN'] && APPROVED))(
  realLoginSuite('runtime proxy: no hidden direct fallback (real token, real internet)'),
  () => {
    const REAL_TOKEN = process.env['GH_TOKEN'] ?? '';

    async function startClientWithRealToken(proxy: ProxyEnvOverrides): Promise<CopilotClient> {
      const client = createHardenedCopilotClient({
        runtimeExePath: RUNTIME_EXE,
        copilotHomeDir: scratchDir('home'),
        proxy,
        baseEnv: isolatedBaseEnv(),
        githubToken: REAL_TOKEN,
      });
      activeClients.push(client);
      await client.start();
      return client;
    }

    it('control: the real token authenticates when no proxy is configured', async () => {
      const auth = await getAuthStatus(await startClientWithRealToken({}));
      expect(auth.isAuthenticated).toBe(true);
    }, 30_000);

    it('unreachable proxy blocks a credential that would otherwise succeed', async () => {
      const deadPort = await reserveClosedPort();
      const deadUrl = `http://127.0.0.1:${String(deadPort)}`;
      const auth = await getAuthStatus(
        await startClientWithRealToken({ httpsProxy: deadUrl, httpProxy: deadUrl }),
      );
      expect(auth.isAuthenticated).toBe(false);
    }, 40_000);

    it('407 from the proxy blocks a credential that would otherwise succeed', async () => {
      const proxy = trackProxy(
        await startTestProxy({ auth: { username: 'daisy', password: 'correct-password' } }),
      );
      const wrongUrl = withEmbeddedCredentials(proxy.url, {
        username: 'daisy',
        password: 'wrong-password',
      });
      const auth = await getAuthStatus(
        await startClientWithRealToken({ httpsProxy: wrongUrl, httpProxy: wrongUrl }),
      );

      expect(auth.isAuthenticated).toBe(false);
      expect(proxy.log.some((e) => e.kind === 'connect-rejected-407')).toBe(true);
    }, 40_000);
  },
);
