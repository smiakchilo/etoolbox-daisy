import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADDON_API_VERSION } from '../../../src/shared';
import { flushMicrotasks } from '../../support/asyncWaits';
import { createScratchDirs } from '../../support/scratchDirs';

const { appMock } = vi.hoisted(() => ({
  appMock: {
    setPath: vi.fn(),
    whenReady: (): Promise<void> => Promise.resolve(),
    exit: vi.fn<(code: number) => void>(),
  },
}));

vi.mock('electron', () => ({ app: appMock }));

const { isSmokeTestRun, runSmokeChecks, runSmokeTest, SMOKE_TEST_FLAG } =
  await import('../../../src/main/smokeTest');

const scratch = createScratchDirs('main-smoke-test', 'smoke-');

afterEach(() => scratch.cleanup());

beforeEach(() => {
  appMock.exit.mockClear();
  appMock.setPath.mockClear();
});

function writeAddon(root: string, id: string, descriptor: Record<string, unknown>): void {
  const directory = path.join(root, id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'addon.json'), JSON.stringify(descriptor));
}

const healthyModule = { addon: { apiVersion: ADDON_API_VERSION, activate: () => ({}) } };

describe('isSmokeTestRun', () => {
  it('recognises the flag anywhere in the arguments', () => {
    expect(isSmokeTestRun(['app.exe', SMOKE_TEST_FLAG])).toBe(true);
    expect(isSmokeTestRun(['app.exe'])).toBe(false);
  });
});

describe('runSmokeTest', () => {
  it('exits 0 for a healthy add-ons folder', async () => {
    const root = scratch.create();
    writeAddon(root, 'healthy', { apiVersion: ADDON_API_VERSION, entry: 'index.js' });

    runSmokeTest(root, () => Promise.resolve(healthyModule));
    await flushMicrotasks(6);

    expect(appMock.exit).toHaveBeenCalledWith(0);
  });

  it('exits 1 when an add-on will not load', async () => {
    const root = scratch.create();
    writeAddon(root, 'broken', { apiVersion: ADDON_API_VERSION, entry: 'absent.js' });

    runSmokeTest(root, () => Promise.reject(new Error('boom')));
    await flushMicrotasks(6);

    expect(appMock.exit).toHaveBeenCalledWith(1);
  });
});

describe('runSmokeChecks', () => {
  it('reports nothing when every add-on loads', async () => {
    const root = scratch.create();
    writeAddon(root, 'one', { apiVersion: ADDON_API_VERSION, entry: 'index.js' });
    const importModule = vi.fn(() => Promise.resolve(healthyModule));

    await expect(runSmokeChecks({ addonsDirectory: root, importModule })).resolves.toEqual([]);
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it('reports a missing add-ons folder', async () => {
    const root = path.join(scratch.create(), 'absent');

    const problems = await runSmokeChecks({ addonsDirectory: root });

    expect(problems).toHaveLength(1);
  });

  it('reports an add-on whose descriptor has no usable entry', async () => {
    const root = scratch.create();
    writeAddon(root, 'bad', { apiVersion: ADDON_API_VERSION, entry: '../escape.js' });
    const importModule = vi.fn(() => Promise.resolve(healthyModule));

    const problems = await runSmokeChecks({ addonsDirectory: root, importModule });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('bad');
    expect(importModule).not.toHaveBeenCalled();
  });

  it('reports an entry that does not export an add-on', async () => {
    const root = scratch.create();
    writeAddon(root, 'plain', { apiVersion: ADDON_API_VERSION, entry: 'index.js' });

    const problems = await runSmokeChecks({
      addonsDirectory: root,
      importModule: () => Promise.resolve({ other: 1 }),
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('plain');
  });

  it('reports an API version that differs from this build', async () => {
    const root = scratch.create();
    writeAddon(root, 'old', { apiVersion: ADDON_API_VERSION, entry: 'index.js' });

    const problems = await runSmokeChecks({
      addonsDirectory: root,
      importModule: () =>
        Promise.resolve({ addon: { apiVersion: ADDON_API_VERSION + 1, activate: () => ({}) } }),
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('old');
  });

  it('reports a module that throws while loading and keeps checking the others', async () => {
    const root = scratch.create();
    writeAddon(root, 'a-broken', { apiVersion: ADDON_API_VERSION, entry: 'index.js' });
    writeAddon(root, 'b-fine', { apiVersion: ADDON_API_VERSION, entry: 'index.js' });
    const importModule = vi
      .fn<(specifier: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(healthyModule);

    const problems = await runSmokeChecks({ addonsDirectory: root, importModule });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('boom');
    expect(importModule).toHaveBeenCalledTimes(2);
  });
});
