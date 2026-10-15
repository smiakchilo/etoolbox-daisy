import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppIconPath } from '../../../src/main/appIcon';
import { createScratchDirs } from '../../support/scratchDirs';

/**
 * Scratch directories are created under the project's own `test-results/`
 * (already gitignored) rather than an OS temp directory, and removed after
 * every test - never `/tmp` or `os.tmpdir()`.
 */
const scratch = createScratchDirs('main-unit-scratch', 'appIcon-');
const createScratchRoot = scratch.create;

afterEach(() => {
  scratch.cleanup();
});

const join = (...segments: readonly string[]): string => path.join(...segments);

function writeIcon(iconPath: string): void {
  mkdirSync(path.dirname(iconPath), { recursive: true });
  writeFileSync(iconPath, 'not a real ico, just a marker file for tests');
}

/** Seeds the icon files production might pick from, so a test discovers rather than names them. */
function seedIcons(resourcesDir: string): string[] {
  const files = ['icon.ico', 'icon.png'].map((name) => path.join(resourcesDir, name));
  for (const file of files) writeIcon(file);
  return files;
}

describe('resolveAppIconPath', () => {
  it('resolves an existing icon inside resources next to the app when packaged', () => {
    const resourcesPath = createScratchRoot();
    const seeded = seedIcons(path.join(resourcesPath, 'resources'));

    const resolved = resolveAppIconPath({
      platform: 'win32',
      isPackaged: true,
      resourcesPath,
      mainDir: 'unused',
      join,
      exists: existsSync,
    });

    expect(resolved).toBeDefined();
    expect(seeded).toContain(resolved);
  });

  it('resolves an existing icon from the project root in development', () => {
    const root = createScratchRoot();
    const seeded = seedIcons(path.join(root, 'resources'));
    // Dev main runs from `<root>/out/main`, two levels below the project root.
    const mainDir = path.join(root, 'out', 'main');

    const resolved = resolveAppIconPath({
      platform: 'win32',
      isPackaged: false,
      resourcesPath: 'unused',
      mainDir,
      join,
      exists: existsSync,
    });

    expect(resolved).toBeDefined();
    expect(seeded).toContain(resolved);
  });

  it('resolves a different icon format on macOS, where Electron cannot load .ico/.icns', () => {
    const root = createScratchRoot();
    seedIcons(path.join(root, 'resources'));
    const resolve = (platform: 'win32' | 'darwin'): string | undefined =>
      resolveAppIconPath({
        platform,
        isPackaged: false,
        resourcesPath: 'unused',
        mainDir: path.join(root, 'out', 'main'),
        join,
        exists: existsSync,
      });

    const mac = resolve('darwin');
    const win = resolve('win32');
    expect(mac).toBeDefined();
    expect(win).toBeDefined();
    expect(path.extname(mac ?? '')).not.toBe(path.extname(win ?? ''));
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
