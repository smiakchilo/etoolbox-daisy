import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findProjectRoot,
  resolveBundledSkillsDir,
  resolveCliExePath,
  resolvePlatformPackageDir,
  resolveSdkRuntimeExePath,
  type RuntimePathsEnv,
} from '../../../../src/agents/copilot/runtimePaths';

/**
 * Scratch directories are created under the project's own `test-results/`
 * (already gitignored) rather than an OS temp directory, and removed after
 * every test - never `/tmp` or `os.tmpdir()`.
 */
const scratchRoots: string[] = [];

function createScratchRoot(): string {
  const base = path.join(process.cwd(), 'test-results', 'agent-unit-scratch');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'runtimePaths-'));
  scratchRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    const env: RuntimePathsEnv = { isPackaged: false, resourcesPath: 'unused', devRootDir };
    expect(resolveSdkRuntimeExePath(env)).toBe(exePath);
  });

  it('throws a descriptive error when the runtime exe is missing', () => {
    const devRootDir = createScratchRoot();
    const env: RuntimePathsEnv = { isPackaged: false, resourcesPath: 'unused', devRootDir };
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
    const env: RuntimePathsEnv = { isPackaged: false, resourcesPath: 'unused', devRootDir };
    expect(resolveCliExePath(env)).toBe(exePath);
  });

  it('throws a descriptive error when the CLI exe is missing', () => {
    const devRootDir = createScratchRoot();
    const env: RuntimePathsEnv = { isPackaged: false, resourcesPath: 'unused', devRootDir };
    expect(() => resolveCliExePath(env)).toThrow(/copilot\.exe/);
  });
});

describe('resolveBundledSkillsDir', () => {
  it('resolves the extraResources location in a packaged build', () => {
    const root = createScratchRoot();
    const packaged = path.join(root, 'resources', 'skills');
    mkdirSync(packaged, { recursive: true });

    expect(
      resolveBundledSkillsDir({ isPackaged: true, resourcesPath: root, devRootDir: 'unused' }),
    ).toBe(packaged);
  });

  it('resolves the project location in development', () => {
    const root = createScratchRoot();
    const dev = path.join(root, 'resources', 'skills');
    mkdirSync(dev, { recursive: true });

    expect(
      resolveBundledSkillsDir({ isPackaged: false, resourcesPath: 'unused', devRootDir: root }),
    ).toBe(dev);
  });

  it('fails loudly when the directory was not packaged', () => {
    const root = createScratchRoot();
    expect(() =>
      resolveBundledSkillsDir({ isPackaged: true, resourcesPath: root, devRootDir: 'unused' }),
    ).toThrow(/extraResources/);
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
