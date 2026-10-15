import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AppPaths,
  ensureAppDirectories,
  getLocalDataDirectory,
  getOsHomeDirectory,
  resolveAppPaths,
} from '../../../src/main/appPaths';

/**
 * Scratch directories are created under the project's own `test-results/`
 * (already gitignored) rather than an OS temp directory, and removed after
 * every test - never `/tmp` or `os.tmpdir()`. Matches
 * tests/unit/agent/runtimePaths.test.ts.
 */
const scratchRoots: string[] = [];

function createScratchRoot(): string {
  const base = path.join(process.cwd(), 'test-results', 'main-unit-scratch');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'appPaths-'));
  scratchRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('getOsHomeDirectory', () => {
  it("returns the same value as node's os.homedir()", () => {
    expect(getOsHomeDirectory()).toBe(homedir());
  });
});

describe('getLocalDataDirectory', () => {
  const home = (): string => path.join(path.sep, 'users', 'someone');

  it('uses LOCALAPPDATA on Windows', () => {
    expect(getLocalDataDirectory('win32', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })).toBe(
      'C:\\Users\\x\\AppData\\Local',
    );
  });

  it('throws on Windows instead of falling back when LOCALAPPDATA is not set', () => {
    expect(() => getLocalDataDirectory('win32', {}, home)).toThrow(/LOCALAPPDATA/);
  });

  it('uses ~/Library/Application Support on macOS, ignoring LOCALAPPDATA', () => {
    expect(getLocalDataDirectory('darwin', { LOCALAPPDATA: 'C:\\ignored' }, home)).toBe(
      path.join(home(), 'Library', 'Application Support'),
    );
  });

  it('uses an absolute XDG_DATA_HOME on Linux', () => {
    const xdg = path.join(path.sep, 'data', 'xdg');
    expect(getLocalDataDirectory('linux', { XDG_DATA_HOME: xdg }, home)).toBe(xdg);
  });

  it('falls back to ~/.local/share on Linux when XDG_DATA_HOME is unset or relative', () => {
    const expected = path.join(home(), '.local', 'share');
    expect(getLocalDataDirectory('linux', {}, home)).toBe(expected);
    expect(getLocalDataDirectory('linux', { XDG_DATA_HOME: 'relative/dir' }, home)).toBe(expected);
  });
});

describe('resolveAppPaths', () => {
  it('keeps only settings, chats and logs in the visible home root', () => {
    const home = createScratchRoot();
    const local = createScratchRoot();
    const paths = resolveAppPaths(home, local);

    expect(paths.root).toBe(path.join(home, 'etoolbox-daisy'));
    expect(paths.settings).toBe(path.join(paths.root, 'settings'));
    expect(paths.chats).toBe(path.join(paths.root, 'chats'));
    expect(paths.logs).toBe(path.join(paths.root, 'logs'));
  });

  it('puts technical data under the local app-data root, never the visible one', () => {
    const home = createScratchRoot();
    const local = createScratchRoot();
    const paths = resolveAppPaths(home, local);

    expect(paths.dataRoot).toBe(path.join(local, 'etoolbox-daisy'));
    expect(paths.secrets).toBe(path.join(paths.dataRoot, 'secrets'));
    expect(paths.windowState).toBe(path.join(paths.dataRoot, 'window-state.json'));
    expect(paths.browser).toBe(path.join(paths.dataRoot, 'browser'));
    expect(paths.agents).toBe(path.join(paths.dataRoot, 'agents'));
    expect(paths.tmp).toBe(path.join(paths.dataRoot, 'tmp'));
    for (const technical of [
      paths.secrets,
      paths.windowState,
      paths.browser,
      paths.agents,
      paths.tmp,
    ]) {
      expect(technical.startsWith(paths.root + path.sep)).toBe(false);
    }
  });

  it('is pure: does not create any directory on disk', () => {
    const paths = resolveAppPaths(createScratchRoot(), createScratchRoot());

    for (const p of Object.values({ ...paths })) {
      expect(existsSync(p)).toBe(false);
    }
  });

  it('throws instead of falling back when the home directory is empty', () => {
    expect(() => resolveAppPaths('', createScratchRoot())).toThrow(/home directory/i);
  });

  it('throws instead of falling back when the home directory is blank', () => {
    expect(() => resolveAppPaths('   ', createScratchRoot())).toThrow(/home directory/i);
  });

  it('throws instead of falling back when the home directory is relative', () => {
    expect(() => resolveAppPaths('relative\\path', createScratchRoot())).toThrow(/absolute/i);
  });

  it('throws instead of falling back when the local app-data directory is bad', () => {
    for (const bad of ['', '   ', 'relative', '.']) {
      expect(() => resolveAppPaths(createScratchRoot(), bad)).toThrow(/local data directory/i);
    }
  });

  it('never silently resolves to process.cwd() or a temp directory for bad input', () => {
    for (const badHome of ['', '   ', 'relative', '.']) {
      expect(() => resolveAppPaths(badHome, createScratchRoot())).toThrow();
    }
  });
});

describe('ensureAppDirectories', () => {
  function expectedDirectories(paths: AppPaths): string[] {
    return [
      paths.root,
      paths.settings,
      paths.chats,
      paths.logs,
      paths.dataRoot,
      paths.secrets,
      paths.browser,
      paths.agents,
      paths.tmp,
    ];
  }

  it('creates both roots and every subdirectory', () => {
    const paths = resolveAppPaths(createScratchRoot(), createScratchRoot());

    ensureAppDirectories(paths);

    for (const dir of expectedDirectories(paths)) {
      expect(existsSync(dir)).toBe(true);
    }
  });

  it('is idempotent: a second call does not throw and directories remain present', () => {
    const paths = resolveAppPaths(createScratchRoot(), createScratchRoot());

    ensureAppDirectories(paths);
    expect(() => ensureAppDirectories(paths)).not.toThrow();

    for (const dir of expectedDirectories(paths)) {
      expect(existsSync(dir)).toBe(true);
    }
  });
});
