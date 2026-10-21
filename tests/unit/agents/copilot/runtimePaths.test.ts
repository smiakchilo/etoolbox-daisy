import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findProjectRoot,
  resolveCliExePath,
  resolvePlatformPackageDir,
  resolveSdkRuntimeExePath,
  type RuntimePathsEnv,
} from '../../../../src/agents/copilot/runtimePaths';
import { createScratchDirs } from '../../../support/scratchDirs';

/**
 * Scratch directories are created under the project's own `test-results/`
 * (already gitignored) rather than an OS temp directory, and removed after
 * every test - never `/tmp` or `os.tmpdir()`.
 */
const scratch = createScratchDirs('agent-unit-scratch', 'runtimePaths-');
const createScratchRoot = scratch.create;

afterEach(() => {
  scratch.cleanup();
});

const WIN = { platform: 'win32', arch: 'x64' } as const;

function writeFakeExe(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, 'not a real exe, just a marker file for tests');
}

describe('resolvePlatformPackageDir', () => {
  it('resolves under node_modules/<package> in dev', () => {
    const devRootDir = createScratchRoot();
    const env: RuntimePathsEnv = { isPackaged: false, resourcesPath: 'unused', devRootDir };
    expect(resolvePlatformPackageDir('@github/copilot-sdk-win32-x64', env)).toBe(
      path.join(devRootDir, 'node_modules', '@github', 'copilot-sdk-win32-x64'),
    );
  });

  it('resolves under resources/app.asar.unpacked/node_modules/<package> when packaged', () => {
    const resourcesPath = createScratchRoot();
    const env: RuntimePathsEnv = { isPackaged: true, resourcesPath, devRootDir: 'unused' };
    expect(resolvePlatformPackageDir('@github/copilot-win32-x64', env)).toBe(
      path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@github', 'copilot-win32-x64'),
    );
  });
});

describe('resolveSdkRuntimeExePath', () => {
  it('returns the absolute path when the runtime exe exists on disk', () => {
    const devRootDir = createScratchRoot();
    const exePath = path.join(
      devRootDir,
      'node_modules',
      '@github',
      'copilot-sdk-win32-x64',
      'prebuilds',
      'win32-x64',
      'copilot-runtime.exe',
    );
    writeFakeExe(exePath);
    const env: RuntimePathsEnv = { isPackaged: false, resourcesPath: 'unused', devRootDir, ...WIN };
    expect(resolveSdkRuntimeExePath(env)).toBe(exePath);
  });

  it('throws a descriptive error when the runtime exe is missing', () => {
    const devRootDir = createScratchRoot();
    const env: RuntimePathsEnv = { isPackaged: false, resourcesPath: 'unused', devRootDir, ...WIN };
    expect(() => resolveSdkRuntimeExePath(env)).toThrow(/copilot-runtime\.exe/);
  });
});

describe('resolveCliExePath', () => {
  it('returns the absolute path when the CLI exe exists on disk', () => {
    const devRootDir = createScratchRoot();
    const exePath = path.join(
      devRootDir,
      'node_modules',
      '@github',
      'copilot-win32-x64',
      'copilot.exe',
    );
    writeFakeExe(exePath);
    const env: RuntimePathsEnv = { isPackaged: false, resourcesPath: 'unused', devRootDir, ...WIN };
    expect(resolveCliExePath(env)).toBe(exePath);
  });

  it('throws a descriptive error when the CLI exe is missing', () => {
    const devRootDir = createScratchRoot();
    const env: RuntimePathsEnv = { isPackaged: false, resourcesPath: 'unused', devRootDir, ...WIN };
    expect(() => resolveCliExePath(env)).toThrow(/copilot\.exe/);
  });
});

describe('macOS layouts', () => {
  it.each(['arm64', 'x64'])('resolves the runtime and CLI without .exe on darwin-%s', (arch) => {
    const devRootDir = createScratchRoot();
    const modules = path.join(devRootDir, 'node_modules', '@github');
    const runtime = path.join(
      modules,
      `copilot-sdk-darwin-${arch}`,
      'prebuilds',
      `darwin-${arch}`,
      'copilot-runtime',
    );
    const cli = path.join(modules, `copilot-darwin-${arch}`, 'copilot');
    writeFakeExe(runtime);
    writeFakeExe(cli);
    const env: RuntimePathsEnv = {
      isPackaged: false,
      resourcesPath: 'unused',
      devRootDir,
      platform: 'darwin',
      arch,
    };
    expect(resolveSdkRuntimeExePath(env)).toBe(runtime);
    expect(resolveCliExePath(env)).toBe(cli);
  });

  it('refuses a platform the application does not bundle a runtime for', () => {
    const env: RuntimePathsEnv = {
      isPackaged: false,
      resourcesPath: 'unused',
      devRootDir: 'unused',
      platform: 'linux',
      arch: 'x64',
    };
    expect(() => resolveSdkRuntimeExePath(env)).toThrow(/linux-x64/);
  });
});

describe('findProjectRoot', () => {
  it('finds the nearest ancestor holding a package.json, at any bundle depth', () => {
    const root = createScratchRoot();
    const deep = path.join(root, 'out', 'main', 'chunks');
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{}');
    expect(findProjectRoot(deep)).toBe(root);
    expect(findProjectRoot(path.join(root, 'out', 'main'))).toBe(root);
  });
});
