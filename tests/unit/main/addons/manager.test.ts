import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { defaultAppSettings } from '../../../../src/shared';
import { ADDON_CATALOG_FILE, type AddonDescriptor } from '../../../../src/main/addons/manifest';
import { createAddonManager, type AddonManagerOptions } from '../../../../src/main/addons/manager';
import { createAddonStore } from '../../../../src/main/addons/store';
import { createAppAddons } from '../../../../src/main/addons';
import { createScratchDirs } from '../../../support/scratchDirs';

/**
 * The manager is the only way a feature reaches its add-on. Its contract is
 * narrow and load-bearing: the pinned version or a typed failure, one install at
 * a time per id, and never a network step for a build that carries its own
 * add-ons.
 */

const scratch = createScratchDirs('main-addons', 'manager-');

afterEach(() => scratch.cleanup());

const PIN = { version: '1.0.0', apiVersion: 1 };

const JS_DESCRIPTOR: AddonDescriptor = {
  id: 'page-audit',
  version: '1.0.0',
  kind: 'js',
  apiVersion: 1,
  entry: 'index.js',
};

function addonZip(descriptor: AddonDescriptor = JS_DESCRIPTOR): Uint8Array {
  return zipSync({
    'addon.json': strToU8(JSON.stringify(descriptor)),
    'index.js': strToU8('export const createPageAuditRunner = () => undefined;'),
  });
}

/** Writes one published archive plus its catalogue into `directory`. */
function publish(
  directory: string,
  options: { readonly descriptor?: AddonDescriptor; readonly wrongHash?: boolean } = {},
): void {
  const bytes = addonZip(options.descriptor);
  const file = 'page-audit-1.0.0-any.zip';
  writeFileSync(path.join(directory, file), bytes);
  const sha512 = createHash('sha512').update(bytes).digest('hex');
  writeFileSync(
    path.join(directory, ADDON_CATALOG_FILE),
    JSON.stringify({
      addons: {
        'page-audit': {
          '1.0.0': {
            platforms: {
              any: {
                file,
                sha512: options.wrongHash === true ? '0'.repeat(128) : sha512,
                size: bytes.byteLength,
              },
            },
          },
        },
      },
    }),
  );
}

function harness(overrides: Partial<AddonManagerOptions> = {}) {
  const addonsRoot = path.join(scratch.create(), 'addons');
  const sourceDirectory = scratch.create();
  const logger = { info: vi.fn(), warn: vi.fn() };
  const readSources = vi.fn<AddonManagerOptions['readSources']>(() =>
    Promise.resolve({ sources: [{ kind: 'local', directory: sourceDirectory }] }),
  );
  const manager = createAddonManager({
    store: createAddonStore({ root: addonsRoot }),
    pins: { 'page-audit': PIN },
    platformKey: 'win32-x64',
    devDirectory: () => undefined,
    readSources,
    logger,
    ...overrides,
  });
  return { manager, addonsRoot, sourceDirectory, logger, readSources };
}

describe('ensure', () => {
  it('installs the pinned version from the catalogue and reports progress', async () => {
    const { manager, addonsRoot, sourceDirectory } = harness();
    publish(sourceDirectory);
    const progress: number[] = [];

    const ensured = await manager.ensure('page-audit', {
      onProgress: (fraction) => progress.push(fraction),
    });

    expect(ensured.ok).toBe(true);
    if (!ensured.ok) return;
    expect(ensured.value.dir).toBe(path.join(addonsRoot, 'page-audit', '1.0.0'));
    expect(progress.at(-1)).toBe(1);
  });

  it('answers the installed pinned version on the next call without a catalogue read', async () => {
    const { manager, sourceDirectory, readSources } = harness();
    publish(sourceDirectory);
    expect((await manager.ensure('page-audit')).ok).toBe(true);

    const again = await manager.ensure('page-audit');

    expect(again.ok).toBe(true);
    expect(readSources).toHaveBeenCalledTimes(1);
  });

  it('shares one install between two concurrent callers', async () => {
    const { manager, sourceDirectory, readSources } = harness();
    publish(sourceDirectory);

    const [first, second] = await Promise.all([
      manager.ensure('page-audit'),
      manager.ensure('page-audit'),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(readSources).toHaveBeenCalledTimes(1);
  });

  it('reports a checksum mismatch and installs nothing', async () => {
    const { manager, addonsRoot, sourceDirectory } = harness();
    publish(sourceDirectory, { wrongHash: true });

    expect(await manager.ensure('page-audit')).toMatchObject({
      ok: false,
      error: { reason: 'hash' },
    });
    // A hash failure is not remembered: a retry tries again (and fails again).
    expect(await manager.ensure('page-audit')).toMatchObject({
      ok: false,
      error: { reason: 'hash' },
    });
    expect(existsSync(path.join(addonsRoot, 'page-audit', '1.0.0'))).toBe(false);
  });

  it('refuses an add-on built against another API version', async () => {
    const { manager, sourceDirectory } = harness();
    publish(sourceDirectory, { descriptor: { ...JS_DESCRIPTOR, apiVersion: 2 } });

    expect(await manager.ensure('page-audit')).toMatchObject({
      ok: false,
      error: { reason: 'apiVersion' },
    });
  });

  it('refuses an add-on of another version', async () => {
    const { manager, sourceDirectory } = harness();
    publish(sourceDirectory, { descriptor: { ...JS_DESCRIPTOR, version: '2.0.0' } });

    expect(await manager.ensure('page-audit')).toMatchObject({
      ok: false,
      error: { reason: 'version' },
    });
  });

  it('reports offline when no catalogue can be read', async () => {
    const { manager } = harness();

    expect(await manager.ensure('page-audit')).toMatchObject({
      ok: false,
      error: { reason: 'offline' },
    });
  });

  it('reports offline for an add-on this build does not pin', async () => {
    const { manager } = harness();

    expect(await manager.ensure('unknown-addon')).toMatchObject({
      ok: false,
      error: { reason: 'offline' },
    });
  });

  it('uses the development copy and never reads a catalogue', async () => {
    const devDirectory = path.join(path.join(scratch.create(), 'dev'), 'page-audit');
    mkdirSync(devDirectory, { recursive: true });
    writeFileSync(path.join(devDirectory, 'addon.json'), JSON.stringify(JS_DESCRIPTOR));
    const { manager, readSources } = harness({ devDirectory: () => devDirectory });

    const ensured = await manager.ensure('page-audit');

    expect(ensured).toMatchObject({ ok: true, value: { dir: devDirectory } });
    expect(readSources).not.toHaveBeenCalled();
  });

  it('fails a stale development copy rather than downloading behind it', async () => {
    const devDirectory = path.join(path.join(scratch.create(), 'dev'), 'page-audit');
    mkdirSync(devDirectory, { recursive: true });
    writeFileSync(
      path.join(devDirectory, 'addon.json'),
      JSON.stringify({ ...JS_DESCRIPTOR, version: '0.9.0' }),
    );
    const { manager, readSources } = harness({ devDirectory: () => devDirectory });

    expect(await manager.ensure('page-audit')).toMatchObject({
      ok: false,
      error: { reason: 'version' },
    });
    expect(readSources).not.toHaveBeenCalled();
  });
});

describe('resolveFile', () => {
  it("answers a binary add-on's named file", async () => {
    const devDirectory = path.join(path.join(scratch.create(), 'dev'), 'copilot-cli');
    mkdirSync(devDirectory, { recursive: true });
    writeFileSync(
      path.join(devDirectory, 'addon.json'),
      JSON.stringify({
        id: 'copilot-cli',
        version: '1.0.83',
        kind: 'binary',
        apiVersion: 1,
        files: { cli: 'copilot.exe' },
      }),
    );
    const { manager } = harness({
      pins: { 'copilot-cli': { version: '1.0.83', apiVersion: 1 } },
      devDirectory: () => devDirectory,
    });

    expect(await manager.resolveFile('copilot-cli', 'cli')).toMatchObject({
      ok: true,
      value: path.join(devDirectory, 'copilot.exe'),
    });
  });

  it('refuses a file a js add-on does not provide', async () => {
    const devDirectory = path.join(path.join(scratch.create(), 'dev'), 'page-audit');
    mkdirSync(devDirectory, { recursive: true });
    writeFileSync(path.join(devDirectory, 'addon.json'), JSON.stringify(JS_DESCRIPTOR));
    const { manager } = harness({ devDirectory: () => devDirectory });

    expect(await manager.resolveFile('page-audit', 'cli')).toMatchObject({
      ok: false,
      error: { reason: 'kind' },
    });
  });
});

describe('createAppAddons', () => {
  it('reads the sandbox folder only in an unpackaged build', async () => {
    const scratchRoot = scratch.create();
    const addonsRoot = path.join(scratchRoot, 'addons');
    const resourcesPath = path.join(scratchRoot, 'resources');
    // A packaged build with no update sources and no run-from-source copies:
    // the sandbox folder is present but must be ignored.
    const packaged = createAppAddons({
      addonsRoot,
      mainDirectory: path.join(scratchRoot, 'out', 'main'),
      resourcesPath,
      appPath: scratchRoot,
      isPackaged: true,
      platformKey: 'win32-x64',
      readSettings: defaultAppSettings,
      secretStore: { get: () => Promise.resolve(undefined) },
      logger: { info: () => undefined, warn: () => undefined },
      env: { EDAISY_ADDON_SOURCE: scratch.create() },
    });

    await expect(packaged.ensure('page-audit')).resolves.toMatchObject({
      ok: false,
      error: { reason: 'offline' },
    });
    expect(existsSync(path.join(addonsRoot, 'page-audit'))).toBe(false);
  });
});
