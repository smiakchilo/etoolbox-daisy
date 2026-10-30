import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type AppUpdaterOptions, createAppUpdater } from '../../../../src/main/updates/composition';
import type { Logger } from '../../../../src/main/logger';
import { type AppSettings, type UpdateStatus, defaultAppSettings } from '../../../../src/shared';
import { createScratchDirs } from '../../../support/scratchDirs';

const scratch = createScratchDirs('update-composition', 'update-composition-');

function settingsWith(source?: string): AppSettings {
  return {
    ...defaultAppSettings(),
    updates: { checkOnStartup: false, ...(source === undefined ? {} : { source }) },
  };
}

function build(overrides: Partial<AppUpdaterOptions> = {}) {
  const root = scratch.create();
  const statuses: UpdateStatus[] = [];
  const quit = vi.fn();
  const logger = { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
  const updater = createAppUpdater({
    installedVersion: '1.0.0',
    platform: 'win32',
    pid: 1,
    executablePath: path.join(root, 'app', 'EToolbox Daisy.exe'),
    resourcesPath: path.join(root, 'resources'),
    scratchDirectory: path.join(root, 'scratch'),
    statusFileFromUpdate: undefined,
    readSettings: () => settingsWith('https://example.test/source.zip'),
    secretStore: { get: () => Promise.resolve(undefined) },
    logger,
    quit,
    onStatusChanged: (status) => statuses.push(status),
    ...overrides,
  });
  return { root, statuses, updater };
}

describe('createAppUpdater', () => {
  it('offers an archive source without reading anything', async () => {
    const { updater } = build();
    expect((await updater.check()).kind).toBe('available');
  });

  it('refuses to apply on a platform that cannot update itself', async () => {
    const { updater } = build({ platform: 'linux' });
    await updater.check();
    const status = await updater.apply();
    expect(status.kind).toBe('failed');
    expect(status).toMatchObject({ phase: 'apply' });
  });

  it('refuses to apply when the build carries no install script', async () => {
    const { updater } = build();
    await updater.check();
    expect(await updater.apply()).toMatchObject({ kind: 'failed', phase: 'apply' });
  });

  it('reports an update it did not start as nothing to resume', async () => {
    const { root, statuses, updater } = build();
    const statusFile = path.join(root, 'scratch', 'update-status.txt');
    await updater.resumeAfterUpdate();
    expect(statuses).toEqual([]);
    expect(() => readFileSync(statusFile)).toThrow();
  });

  it('confirms a start to the update script through the file the script named', async () => {
    const root = scratch.create();
    const statusFile = path.join(root, 'from-script.txt');
    writeFileSync(statusFile, 'swapped|Updated');
    const { statuses, updater } = build({ statusFileFromUpdate: statusFile });
    await updater.resumeAfterUpdate();
    expect(readFileSync(statusFile, 'utf8')).toContain('started|1.0.0');
    expect(statuses.at(-1)).toEqual({ kind: 'updated', version: '1.0.0' });
  });
});
