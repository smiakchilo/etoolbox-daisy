import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createHardenedCopilotClient,
  getAuthStatus,
  getRuntimeStatus,
  resolveSdkRuntimeExePath,
  type CopilotClient,
} from '../../src/agent';
import type { RuntimePathsEnv } from '../../src/agent/runtimePaths';

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
 * This test intentionally does NOT attempt an interactive login: it can only
 * assert what is true regardless of auth state (`getStatus()` succeeds,
 * `getAuthStatus()` succeeds and reports `isAuthenticated: false` for a
 * brand-new, never-logged-in scratch home). It does not skip vacuously - both
 * assertions must genuinely pass for the test to pass.
 */
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

    // Strip the same three env vars `auth.ts` strips for `login` - an
    // ambient `GITHUB_TOKEN`/`GH_TOKEN`/`COPILOT_GITHUB_TOKEN` on this
    // machine (common on CI runners and dev containers) would otherwise make
    // `isAuthenticated` true via `authType: "env"` regardless of
    // `COPILOT_HOME`, which would make this assertion flaky rather than a
    // genuine test of the scratch-home/vault behavior.
    const isolatedEnv = { ...process.env };
    delete isolatedEnv['COPILOT_GITHUB_TOKEN'];
    delete isolatedEnv['GH_TOKEN'];
    delete isolatedEnv['GITHUB_TOKEN'];

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
    // A brand-new scratch COPILOT_HOME has never logged in, so this must be
    // false. If this ever comes back `true`, either the scratch directory
    // leaked into a real credential lookup path or the SDK's auth resolution
    // changed - either way that is a real finding, not something to skip.
    expect(authStatus.isAuthenticated).toBe(false);
  }, 30_000);
});
