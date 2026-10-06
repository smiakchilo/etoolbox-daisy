import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveBundledSkillsDir,
  resolveCliExePath,
  resolveSdkRuntimeExePath,
} from '../../src/agents/copilot/runtimePaths';

/**
 * Confirms the bundled-skill directory really lands where
 * `resolveBundledSkillsDir()` looks for it in a packaged build.
 *
 * The packaged path (`resources/resources/skills`) comes from
 * electron-builder's `extraResources: [{ from: resources, to: resources }]`
 * mapping, which is easy to get subtly wrong and impossible to catch with a
 * unit test that fabricates its own directory layout. This test therefore
 * reads the **real** `release/win-unpacked` output.
 *
 * It self-skips when that directory does not exist, because `npm run verify`
 * deliberately does not run `npm run package:win`.
 */
const packagedResources = path.join(process.cwd(), 'release', 'win-unpacked', 'resources');

describe.skipIf(!existsSync(packagedResources))('packaged bundled skills', () => {
  it('resolves to the real packaged skill directory', () => {
    const dir = resolveBundledSkillsDir({
      isPackaged: true,
      resourcesPath: packagedResources,
      devRootDir: 'unused-when-packaged',
    });

    expect(dir).toBe(path.join(packagedResources, 'resources', 'skills'));
    expect(existsSync(path.join(dir, 'daisy-conventions', 'SKILL.md'))).toBe(true);
  });
});

/**
 * Guards the payload trim recorded as U6 in `docs/verification.md`.
 *
 * Both trims were justified empirically (auth still reads, login still
 * succeeds, and the credential is still vault-backed with no plaintext
 * fallback), but they are expressed as `!`-patterns in `electron-builder.yml`
 * that a dependency bump or a path rename would silently stop matching. That
 * failure mode is invisible: the app keeps working, it just quietly regains
 * ~97 MB and re-acquires the Microsoft-licensed payload. Assert both
 * directions — the excluded files stay gone, the required ones stay present.
 */
describe.skipIf(!existsSync(packagedResources))('packaged payload trim (U6)', () => {
  const githubModules = path.join(
    packagedResources,
    'app.asar.unpacked',
    'node_modules',
    '@github',
  );

  const mustBeAbsent = [
    'copilot-sdk-win32-x64/prebuilds/win32-x64/OneAuthInterop.dll',
    'copilot-sdk-win32-x64/prebuilds/win32-x64/msalruntime.dll',
    'copilot-sdk-win32-x64/prebuilds/win32-x64/msal-node-runtime.node',
    'copilot-win32-x64/prebuilds/win32-x64/OneAuthInterop.dll',
    'copilot-win32-x64/prebuilds/win32-x64/msalruntime.dll',
    'copilot-win32-x64/prebuilds/win32-x64/msal-node-runtime.node',
    'copilot-win32-x64/prebuilds/win32-x64/runtime.node',
  ];

  it.each(mustBeAbsent)('does not ship %s', (relative) => {
    expect(existsSync(path.join(githubModules, ...relative.split('/')))).toBe(false);
  });

  it('still ships the two executables the app actually spawns', () => {
    const env = {
      isPackaged: true,
      resourcesPath: packagedResources,
      devRootDir: 'unused-when-packaged',
    };
    expect(existsSync(resolveSdkRuntimeExePath(env))).toBe(true);
    expect(existsSync(resolveCliExePath(env))).toBe(true);
  });

  it('still ships the SDK runtime native module the runtime actually loads', () => {
    const runtimeNode = path.join(
      githubModules,
      'copilot-sdk-win32-x64',
      'prebuilds',
      'win32-x64',
      'runtime.node',
    );
    expect(existsSync(runtimeNode)).toBe(true);
  });
});
