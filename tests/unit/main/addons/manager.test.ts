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
 * narrow and load-bearing: the pinned identity or a typed failure, one install
 * at a time per id, and never a network step for a build that carries its own
 * add-ons.
 */

const scratch = createScratchDirs('main-addons', 'manager-');

afterEach(() => scratch.cleanup());

const IDENTITY = '0123456789abcdef';
const OTHER_IDENTITY = 'fedcba9876543210';
const PIN = { identity: IDENTITY, apiVersion: 1, contributions: { tools: [], skills: [] } };

const JS_DESCRIPTOR: AddonDescriptor = {
  id: 'example-addon',
  identity: IDENTITY,
  apiVersion: 1,
  entry: 'index.js',
};

function addonZip(descriptor: AddonDescriptor = JS_DESCRIPTOR): Uint8Array {
  return zipSync({
    'addon.json': strToU8(JSON.stringify(descriptor)),
    'index.js': strToU8('export const addon = { apiVersion: 1, activate: () => ({ tools: {} }) };'),
  });
}

/** Writes one published archive plus its catalogue into `directory`. */
function publish(
  directory: string,
  options: { readonly descriptor?: AddonDescriptor; readonly wrongHash?: boolean } = {},
): void {
  const bytes = addonZip(options.descriptor);
  const file = `example-addon-${IDENTITY}-any.zip`;
  writeFileSync(path.join(directory, file), bytes);
  const sha512 = createHash('sha512').update(bytes).digest('hex');
  writeFileSync(
    path.join(directory, ADDON_CATALOG_FILE),
    JSON.stringify({
      addons: {
        'example-addon': {
          [IDENTITY]: {
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
    pins: { 'example-addon': PIN },
    platformKey: 'win32-x64',
    devDirectory: () => undefined,
    readSources,
    logger,
    ...overrides,
  });
  return { manager, addonsRoot, sourceDirectory, logger, readSources };
}

describe('ensure', () => {
  it('installs the pinned identity from the catalogue and reports progress', async () => {
    const { manager, addonsRoot, sourceDirectory } = harness();
    publish(sourceDirectory);
    const progress: number[] = [];

    const ensured = await manager.ensure('example-addon', {
      onProgress: (fraction) => progress.push(fraction),
    });

    expect(ensured.ok).toBe(true);
    if (!ensured.ok) return;
    expect(ensured.value.dir).toBe(path.join(addonsRoot, 'example-addon', IDENTITY));
    expect(progress.at(-1)).toBe(1);
  });

  it('answers the installed pinned identity on the next call without a catalogue read', async () => {
    const { manager, sourceDirectory, readSources } = harness();
    publish(sourceDirectory);
    expect((await manager.ensure('example-addon')).ok).toBe(true);

    const again = await manager.ensure('example-addon');

    expect(again.ok).toBe(true);
    expect(readSources).toHaveBeenCalledTimes(1);
  });

  it('shares one install between two concurrent callers', async () => {
    const { manager, sourceDirectory, readSources } = harness();
    publish(sourceDirectory);

    const [first, second] = await Promise.all([
      manager.ensure('example-addon'),
      manager.ensure('example-addon'),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(readSources).toHaveBeenCalledTimes(1);
  });

  it('reports a checksum mismatch and installs nothing', async () => {
    const { manager, addonsRoot, sourceDirectory } = harness();
    publish(sourceDirectory, { wrongHash: true });

    expect(await manager.ensure('example-addon')).toMatchObject({
      ok: false,
      error: { reason: 'hash' },
    });
    // A hash failure is not remembered: a retry tries again (and fails again).
    expect(await manager.ensure('example-addon')).toMatchObject({
      ok: false,
      error: { reason: 'hash' },
    });
    expect(existsSync(path.join(addonsRoot, 'example-addon', IDENTITY))).toBe(false);
  });

  it('refuses an add-on built against another API version', async () => {
    const { manager, sourceDirectory } = harness();
    publish(sourceDirectory, { descriptor: { ...JS_DESCRIPTOR, apiVersion: 2 } });

    expect(await manager.ensure('example-addon')).toMatchObject({
      ok: false,
      error: { reason: 'apiVersion' },
    });
  });

  it('refuses an add-on of another identity', async () => {
    const { manager, sourceDirectory } = harness();
    publish(sourceDirectory, { descriptor: { ...JS_DESCRIPTOR, identity: OTHER_IDENTITY } });

    expect(await manager.ensure('example-addon')).toMatchObject({
      ok: false,
      error: { reason: 'identity' },
    });
  });

  it('reports offline when no catalogue can be read', async () => {
    const { manager } = harness();

    expect(await manager.ensure('example-addon')).toMatchObject({
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
    const devDirectory = path.join(path.join(scratch.create(), 'dev'), 'example-addon');
    mkdirSync(devDirectory, { recursive: true });
    writeFileSync(path.join(devDirectory, 'addon.json'), JSON.stringify(JS_DESCRIPTOR));
    const { manager, readSources } = harness({ devDirectory: () => devDirectory });

    const ensured = await manager.ensure('example-addon');

    expect(ensured).toMatchObject({ ok: true, value: { dir: devDirectory } });
    expect(readSources).not.toHaveBeenCalled();
  });

  it('fails a stale development copy rather than downloading behind it', async () => {
    const devDirectory = path.join(path.join(scratch.create(), 'dev'), 'example-addon');
    mkdirSync(devDirectory, { recursive: true });
    writeFileSync(
      path.join(devDirectory, 'addon.json'),
      JSON.stringify({ ...JS_DESCRIPTOR, identity: OTHER_IDENTITY }),
    );
    const { manager, readSources } = harness({ devDirectory: () => devDirectory });

    expect(await manager.ensure('example-addon')).toMatchObject({
      ok: false,
      error: { reason: 'identity' },
    });
    expect(readSources).not.toHaveBeenCalled();
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

    await expect(packaged.ensure('example-addon')).resolves.toMatchObject({
      ok: false,
      error: { reason: 'offline' },
    });
    expect(existsSync(path.join(addonsRoot, 'example-addon'))).toBe(false);
  });
});
