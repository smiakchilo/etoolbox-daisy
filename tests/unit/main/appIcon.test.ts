import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppIconPath } from '../../../src/main/appIcon';

/**
 * Scratch directories are created under the project's own `test-results/`
 * (already gitignored) rather than an OS temp directory, and removed after
 * every test - never `/tmp` or `os.tmpdir()`.
 */
const scratchRoots: string[] = [];

function createScratchRoot(): string {
  const base = path.join(process.cwd(), 'test-results', 'main-unit-scratch');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'appIcon-'));
  scratchRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const join = (...segments: readonly string[]): string => path.join(...segments);

function writeIcon(iconPath: string): void {
  mkdirSync(path.dirname(iconPath), { recursive: true });
  writeFileSync(iconPath, 'not a real ico, just a marker file for tests');
}

describe('resolveAppIconPath', () => {
  it('resolves resources/icon.ico next to the app when packaged', () => {
    const resourcesPath = createScratchRoot();
    const iconPath = path.join(resourcesPath, 'resources', 'icon.ico');
    writeIcon(iconPath);

    expect(
      resolveAppIconPath({
        platform: 'win32',
        isPackaged: true,
        resourcesPath,
        mainDir: 'unused',
        join,
        exists: existsSync,
      }),
    ).toBe(iconPath);
  });

  it('resolves resources/icon.ico from the project root in development', () => {
    const root = createScratchRoot();
    const iconPath = path.join(root, 'resources', 'icon.ico');
    writeIcon(iconPath);
    // Dev main runs from `<root>/out/main`, two levels below the project root.
    const mainDir = path.join(root, 'out', 'main');

    expect(
      resolveAppIconPath({
        platform: 'win32',
        isPackaged: false,
        resourcesPath: 'unused',
        mainDir,
        join,
        exists: existsSync,
      }),
    ).toBe(iconPath);
  });

  it('resolves resources/icon.png on macOS, where Electron cannot load .ico/.icns', () => {
    const root = createScratchRoot();
    writeIcon(path.join(root, 'resources', 'icon.ico'));
    const pngPath = path.join(root, 'resources', 'icon.png');
    writeIcon(pngPath);

    expect(
      resolveAppIconPath({
        platform: 'darwin',
        isPackaged: false,
        resourcesPath: 'unused',
        mainDir: path.join(root, 'out', 'main'),
        join,
        exists: existsSync,
      }),
    ).toBe(pngPath);
  });

  it('returns undefined when the icon is absent instead of a dead path', () => {
    expect(
      resolveAppIconPath({
        platform: 'win32',
        isPackaged: true,
        resourcesPath: createScratchRoot(),
        mainDir: 'unused',
        join,
        exists: existsSync,
      }),
    ).toBeUndefined();
  });
});
