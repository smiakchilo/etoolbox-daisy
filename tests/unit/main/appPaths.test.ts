import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureAppDirectories,
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

describe('resolveAppPaths', () => {
  it('derives the root and all six subdirectories under the home directory', () => {
    const home = createScratchRoot();
    const paths = resolveAppPaths(home);

    expect(paths.root).toBe(path.join(home, 'etoolbox-daisy'));
    expect(paths.settings).toBe(path.join(paths.root, 'settings'));
    expect(paths.windowState).toBe(path.join(paths.root, 'window-state.json'));
    expect(paths.browser).toBe(path.join(paths.root, 'browser'));
    expect(paths.copilot).toBe(path.join(paths.root, 'copilot'));
    expect(paths.chats).toBe(path.join(paths.root, 'chats'));
    expect(paths.tmp).toBe(path.join(paths.root, 'tmp'));
    expect(paths.logs).toBe(path.join(paths.root, 'logs'));
  });

  it('is pure: does not create any directory on disk', () => {
    const home = createScratchRoot();
    const paths = resolveAppPaths(home);

    expect(existsSync(paths.root)).toBe(false);
    expect(existsSync(paths.settings)).toBe(false);
    expect(existsSync(paths.windowState)).toBe(false);
    expect(existsSync(paths.browser)).toBe(false);
    expect(existsSync(paths.copilot)).toBe(false);
    expect(existsSync(paths.chats)).toBe(false);
    expect(existsSync(paths.tmp)).toBe(false);
    expect(existsSync(paths.logs)).toBe(false);
  });

  it('throws instead of falling back when the home directory is empty', () => {
    expect(() => resolveAppPaths('')).toThrow(/home directory/i);
  });

  it('throws instead of falling back when the home directory is blank', () => {
    expect(() => resolveAppPaths('   ')).toThrow(/home directory/i);
  });

  it('throws instead of falling back when the home directory is relative', () => {
    expect(() => resolveAppPaths('relative\\path')).toThrow(/absolute/i);
  });

  it('never silently resolves to process.cwd() or a temp directory for bad input', () => {
    for (const badHome of ['', '   ', 'relative', '.']) {
      expect(() => resolveAppPaths(badHome)).toThrow();
    }
  });
});

describe('ensureAppDirectories', () => {
  it('creates the root and all six subdirectories', () => {
    const home = createScratchRoot();
    const paths = resolveAppPaths(home);

    ensureAppDirectories(paths);

    for (const dir of [
      paths.root,
      paths.settings,
      paths.browser,
      paths.copilot,
      paths.chats,
      paths.tmp,
      paths.logs,
    ]) {
      expect(existsSync(dir)).toBe(true);
    }
  });

  it('is idempotent: a second call does not throw and directories remain present', () => {
    const home = createScratchRoot();
    const paths = resolveAppPaths(home);

    ensureAppDirectories(paths);
    expect(() => ensureAppDirectories(paths)).not.toThrow();

    for (const dir of [
      paths.root,
      paths.settings,
      paths.browser,
      paths.copilot,
      paths.chats,
      paths.tmp,
      paths.logs,
    ]) {
      expect(existsSync(dir)).toBe(true);
    }
  });
});
