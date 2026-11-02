import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createHardenedCopilotClient,
  getAuthStatus,
  getRuntimeStatus,
  type CopilotClient,
} from '../../src/agents/copilot/copilotClient';
import { resolveSdkRuntimeExePath } from '../../src/agents/copilot/runtimePaths';
import type { RuntimePathsEnv } from '../../src/agents/copilot/runtimePaths';

/**
 * Starts the *real* bundled runtime (`copilot-runtime.exe`) through
 * `createHardenedCopilotClient()` - the same adapter code the app itself
 * uses - from the explicit absolute path resolved by `runtimePaths.ts`,
 * proving fact 2 end to end (explicit path -> `client.start()` succeeds
 * without the SDK's `getBundledRuntimePath()`/`ensureRuntimeBundle()`
 * fallback ever running).
 *
 * Goes through `src/agent`'s exports rather than importing
 * `@github/copilot-sdk` directly, so this file stays compliant with the
 * "only src/agent imports the SDK" ESLint rule while still exercising the
 * real runtime process.
 *
 * A scratch `COPILOT_HOME` (under this project's own `test-results/`, never
 * an OS temp dir) is used so this test never touches - and can never corrupt
 * - the developer's real app-owned `COPILOT_HOME` or its login state.
 *
 * Nothing here may depend on *this machine's* sign-in state: the test sets a
 * sentinel value for the three ambient credential variables (so a regression in
 * the app-owned strip shows up as `authType: "env"`) and removes the `gh` CLI
 * from the runtime's `PATH` (so a developer's own `gh auth login` is not what
 * the assertions see). See `withoutGhCliOnPath` for why the second half is
 * needed. A brand-new scratch home with neither source is unauthenticated, and
 * that is what is asserted - on every machine, not just a clean one.
 */
/** The `gh` executable's name on this platform. */
const GH_EXECUTABLE = process.platform === 'win32' ? 'gh.exe' : 'gh';

/**
 * `PATH` with every directory that holds a `gh` executable removed.
 *
 * The Copilot runtime falls back to a `gh` CLI login the developer already has:
 * probed on 2026-11-02, a scratch `COPILOT_HOME` still reported
 * `authType: "gh-cli"`, `statusMessage: "‹user› (via gh)"` on a machine with
 * `gh` authenticated, and removing the CLI from `PATH` is what changes it (a
 * scratch `GH_CONFIG_DIR`/`APPDATA` does not). That fallback is the app's
 * inherited environment, not the app-owned session this test is about, and it
 * differs per machine - so the runtime is handed a `PATH` that cannot supply
 * one. On a machine without `gh` this returns the `PATH` unchanged.
 */
function withoutGhCliOnPath(current: string | undefined): string {
  return (current ?? '')
    .split(path.delimiter)
    .filter((entry) => entry !== '' && !existsSync(path.join(entry, GH_EXECUTABLE)))
    .join(path.delimiter);
}

describe('agent runtime integration', () => {
  const scratchHome = mkdtempSync(
    (() => {
      const base = path.join(process.cwd(), 'test-results', 'agent-integration-scratch');
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

  it('starts the real bundled runtime from an explicit path and reports status', async () => {
    const env: RuntimePathsEnv = {
      isPackaged: false,
      resourcesPath: 'unused-in-dev',
      devRootDir: process.cwd(),
    };
    const runtimeExePath = resolveSdkRuntimeExePath(env);

    // Sentinel values, not deletions: the point is to prove the app-owned
    // `buildRuntimeChildEnv` strips these before the runtime sees them. If that
    // strip ever regresses the runtime reports `authType: "env"` and is
    // authenticated as the sentinel - the defect observed for real in an
    // installed build (see `AMBIENT_CREDENTIAL_ENV_VARS` in `copilotClient.ts`).
    const ambientToken = 'ghs_sentinel_value_the_runtime_must_never_see';
    const isolatedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      COPILOT_GITHUB_TOKEN: ambientToken,
      GH_TOKEN: ambientToken,
      GITHUB_TOKEN: ambientToken,
      PATH: withoutGhCliOnPath(process.env['PATH']),
    };

    client = createHardenedCopilotClient({
      runtimeExePath,
      copilotHomeDir: scratchHome,
      baseEnv: isolatedEnv,
    });

    await client.start();

    const status = await getRuntimeStatus(client);
    expect(typeof status.version).toBe('string');
    expect(status.version.length).toBeGreaterThan(0);
    expect(typeof status.protocolVersion).toBe('number');

    const authStatus = await getAuthStatus(client);
    expect(typeof authStatus.isAuthenticated).toBe('boolean');
    // The ambient token did not authenticate: either it was stripped (this
    // holds) or it was inherited and reported as `env` (a regression).
    expect(authStatus.authType).not.toBe('env');
    // With no ambient token and no `gh` CLI reachable, a brand-new scratch
    // COPILOT_HOME has never logged in, so nothing may report a session. If
    // this ever comes back `true`, a credential source the app does not strip
    // leaked into the scratch home's lookup path - a real finding.
    expect(authStatus.isAuthenticated).toBe(false);
  }, 30_000);
});
