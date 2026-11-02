import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADDON_API_VERSION, err, ok } from '../../../../src/shared';
import {
  ADDON_BUILD_MINIMUM_NODE,
  createAddonBuilder,
  findNodeRuntime,
  type AddonBuilderOptions,
  type NodeRuntime,
  type NpmOutcome,
} from '../../../../src/main/addons/builder';
import type { ScannedAddon } from '../../../../src/main/addons';
import { createScratchDirs } from '../../../support/scratchDirs';

const scratch = createScratchDirs('addon-builder', 'builder-');
afterEach(() => scratch.cleanup());

const ID = 'sample-addon';
const RUNTIME: NodeRuntime = { node: 'node', npmCli: 'npm-cli.js' };

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function shipped(options: { lock?: boolean; nodeModules?: boolean; packageJson?: boolean } = {}): {
  scanned: ScannedAddon;
  directory: string;
} {
  const directory = scratch.create();
  write(path.join(directory, 'index.js'), 'export const addon = {};');
  write(path.join(directory, 'addon.json'), '{}');
  if (options.packageJson !== false) write(path.join(directory, 'package.json'), '{}');
  if (options.lock === true) write(path.join(directory, 'package-lock.json'), '{}');
  if (options.nodeModules === true) mkdirSync(path.join(directory, 'node_modules'));
  const scanned: ScannedAddon = {
    id: ID,
    directory,
    descriptor: { id: ID, apiVersion: ADDON_API_VERSION, entry: 'index.js' },
    contributions: { tools: [], skills: [] },
  };
  return { scanned, directory };
}

function harness(overrides: Partial<AddonBuilderOptions> = {}) {
  const builtRoot = scratch.create();
  const warn = vi.fn();
  const runNpm = vi.fn<NonNullable<AddonBuilderOptions['runNpm']>>(() => Promise.resolve('ok'));
  const findNode = vi.fn(() => Promise.resolve<NodeRuntime | undefined>(RUNTIME));
  const builder = createAddonBuilder({
    builtRoot,
    keptNodeDirectory: path.join(builtRoot, 'kept'),
    logger: { warn },
    findNode,
    runNpm,
    ...overrides,
  });
  return { builder, builtRoot, warn, runNpm, findNode };
}

describe('createAddonBuilder', () => {
  it('installs on a cache miss and marks the build ready', async () => {
    const { scanned } = shipped({ lock: true });
    const { builder, builtRoot, runNpm } = harness();

    const result = await builder.ensureBuilt(ID, scanned);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(path.dirname(result.value)).toBe(path.join(builtRoot, ID));
    expect(existsSync(path.join(result.value, '.ready'))).toBe(true);
    expect(existsSync(path.join(result.value, 'index.js'))).toBe(true);
    expect(existsSync(path.join(result.value, 'package-lock.json'))).toBe(true);
    expect(runNpm).toHaveBeenCalledTimes(1);
    expect(runNpm.mock.calls[0]?.[1]).toBe(result.value);
  });

  it('reuses a ready build without looking for Node or running npm', async () => {
    const { scanned } = shipped();
    const first = harness();
    const built = await first.builder.ensureBuilt(ID, scanned);
    const onInstall = vi.fn();

    const second = createAddonBuilder({
      builtRoot: path.dirname(path.dirname(built.ok ? built.value : '')),
      keptNodeDirectory: 'unused',
      logger: { warn: vi.fn() },
      findNode: first.findNode,
      runNpm: first.runNpm,
    });
    first.findNode.mockClear();
    first.runNpm.mockClear();
    const again = await second.ensureBuilt(ID, scanned, onInstall);

    expect(again).toEqual(built);
    expect(first.findNode).not.toHaveBeenCalled();
    expect(first.runNpm).not.toHaveBeenCalled();
    expect(onInstall).not.toHaveBeenCalled();
  });

  it('reports the start of an install exactly once', async () => {
    const { scanned } = shipped();
    const { builder } = harness();
    const onInstall = vi.fn();

    await builder.ensureBuilt(ID, scanned, onInstall);

    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it('rebuilds under a new key when an input changes and drops the old build', async () => {
    const { scanned, directory } = shipped();
    const { builder, runNpm } = harness();
    const first = await builder.ensureBuilt(ID, scanned);

    write(path.join(directory, 'package.json'), '{"changed":true}');
    const second = await builder.ensureBuilt(ID, scanned);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value).not.toBe(first.value);
    expect(runNpm).toHaveBeenCalledTimes(2);
    expect(existsSync(first.value)).toBe(false);
    expect(existsSync(path.join(second.value, '.ready'))).toBe(true);
  });

  it('fails with no-node before creating anything', async () => {
    const { scanned } = shipped();
    const { builder, builtRoot, warn, runNpm } = harness({
      findNode: () => Promise.resolve(undefined),
    });

    const result = await builder.ensureBuilt(ID, scanned);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('no-node');
    expect(result.error.message).toContain(ID);
    expect(result.error.message).toContain(ADDON_BUILD_MINIMUM_NODE);
    expect(runNpm).not.toHaveBeenCalled();
    expect(existsSync(path.join(builtRoot, ID))).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'ADDON_BUILD_FAILED',
      expect.objectContaining({ addonId: ID, reason: 'no-node' }),
    );
  });

  it('downloads Node when none is found, then builds with it', async () => {
    const { scanned } = shipped();
    const findNode = vi
      .fn<() => Promise<NodeRuntime | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(RUNTIME);
    const downloadNode = vi.fn(() => Promise.resolve(ok<void>(undefined)));
    const { builder, runNpm } = harness({ findNode, downloadNode });

    const result = await builder.ensureBuilt(ID, scanned);

    expect(result.ok).toBe(true);
    expect(downloadNode).toHaveBeenCalledTimes(1);
    expect(runNpm).toHaveBeenCalledTimes(1);
  });

  it('reports the download failure reason and runs no npm', async () => {
    const { scanned } = shipped();
    const downloadNode = vi.fn(() => Promise.resolve(err({ reason: 'network' as const })));
    const { builder, runNpm } = harness({
      findNode: () => Promise.resolve(undefined),
      downloadNode,
    });

    const result = await builder.ensureBuilt(ID, scanned);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('network');
    expect(runNpm).not.toHaveBeenCalled();
  });

  it('fails with no-node when the download leaves no usable Node', async () => {
    const { scanned } = shipped();
    const downloadNode = vi.fn(() => Promise.resolve(ok<void>(undefined)));
    const { builder, runNpm } = harness({
      findNode: () => Promise.resolve(undefined),
      downloadNode,
    });

    const result = await builder.ensureBuilt(ID, scanned);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('no-node');
    expect(runNpm).not.toHaveBeenCalled();
  });

  it('does not download when Node is already found', async () => {
    const { scanned } = shipped();
    const downloadNode = vi.fn(() => Promise.resolve(ok<void>(undefined)));
    const { builder } = harness({ downloadNode });

    const result = await builder.ensureBuilt(ID, scanned);

    expect(result.ok).toBe(true);
    expect(downloadNode).not.toHaveBeenCalled();
  });

  it.each<[NpmOutcome, string]>([
    ['failed', 'unexpected'],
    ['timeout', 'timeout'],
  ])('maps an npm outcome of %s to %s and removes the partial build', async (outcome, reason) => {
    const { scanned } = shipped();
    const { builder, builtRoot, warn } = harness({ runNpm: () => Promise.resolve(outcome) });

    const result = await builder.ensureBuilt(ID, scanned);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe(reason);
    expect(result.error.message).not.toMatch(/[\\/]/);
    expect(existsSync(path.join(builtRoot, ID, 'anything'))).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'ADDON_BUILD_FAILED',
      expect.objectContaining({ addonId: ID, reason }),
    );
  });

  it('leaves no folder behind after a failed install and can retry', async () => {
    const { scanned } = shipped();
    const runNpm = vi
      .fn<NonNullable<AddonBuilderOptions['runNpm']>>()
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('ok');
    const { builder, builtRoot } = harness({ runNpm });

    const failed = await builder.ensureBuilt(ID, scanned);
    const addonRoot = path.join(builtRoot, ID);
    const leftover = existsSync(addonRoot) ? existsSync(path.join(addonRoot, 'x')) : false;
    const retried = await builder.ensureBuilt(ID, scanned);

    expect(failed.ok).toBe(false);
    expect(leftover).toBe(false);
    expect(retried.ok).toBe(true);
  });

  it('turns a throwing install into an unexpected failure', async () => {
    const { scanned } = shipped();
    const { builder } = harness({ runNpm: () => Promise.reject(new Error('boom')) });

    const result = await builder.ensureBuilt(ID, scanned);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('unexpected');
    expect(result.error.message).not.toContain('boom');
  });

  it('runs one install for concurrent calls', async () => {
    const { scanned } = shipped();
    let release: (outcome: NpmOutcome) => void = () => undefined;
    const runNpm = vi.fn<NonNullable<AddonBuilderOptions['runNpm']>>(
      () => new Promise<NpmOutcome>((resolve) => (release = resolve)),
    );
    const { builder } = harness({ runNpm });

    const first = builder.ensureBuilt(ID, scanned);
    const second = builder.ensureBuilt(ID, scanned);
    await vi.waitFor(() => expect(runNpm).toHaveBeenCalled());
    release('ok');
    const [a, b] = await Promise.all([first, second]);

    expect(runNpm).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
  });

  it('returns the shipped folder when its dependencies are already installed', async () => {
    const { scanned, directory } = shipped({ nodeModules: true });
    const { builder, findNode, runNpm } = harness();

    const result = await builder.ensureBuilt(ID, scanned);

    expect(result).toEqual({ ok: true, value: directory });
    expect(findNode).not.toHaveBeenCalled();
    expect(runNpm).not.toHaveBeenCalled();
  });

  it('returns the shipped folder when the add-on has no dependencies', async () => {
    const { scanned, directory } = shipped({ packageJson: false });
    const { builder, runNpm } = harness();

    const result = await builder.ensureBuilt(ID, scanned);

    expect(result).toEqual({ ok: true, value: directory });
    expect(runNpm).not.toHaveBeenCalled();
  });

  it('merges the proxy settings into the environment and never runs Electron as Node', async () => {
    const { scanned } = shipped();
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
    try {
      const { builder, runNpm } = harness({
        proxyEnv: () => Promise.resolve({ HTTPS_PROXY: 'http://proxy.example:3128' }),
      });

      await builder.ensureBuilt(ID, scanned);

      const env = runNpm.mock.calls[0]?.[2];
      expect(env?.['HTTPS_PROXY']).toBe('http://proxy.example:3128');
      expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('findNodeRuntime', () => {
  const windows = process.platform === 'win32';
  const platform = windows ? 'win32' : 'linux';
  const executable = windows ? 'node.exe' : 'node';

  /** A directory holding a node executable with its npm beside it. */
  function nodeDirectory(withNpm = true): string {
    const directory = scratch.create();
    write(path.join(directory, executable), '');
    if (withNpm) write(path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
    return directory;
  }

  function keptDirectory(): string {
    const directory = scratch.create();
    if (windows) {
      write(path.join(directory, executable), '');
      write(path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
    } else {
      write(path.join(directory, 'bin', executable), '');
      write(path.join(directory, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
    }
    return directory;
  }

  const modern = () => Promise.resolve<string | undefined>('v22.12.0');

  it('prefers a Node on PATH over the kept copy', async () => {
    const onPath = nodeDirectory();
    const runtime = await findNodeRuntime({
      pathEnv: onPath,
      platform,
      keptNodeDirectory: keptDirectory(),
      readVersion: modern,
    });

    expect(runtime?.node).toBe(path.join(onPath, executable));
    expect(runtime?.npmCli).toContain('npm-cli.js');
  });

  it('falls back to the kept copy when PATH has no usable Node', async () => {
    const kept = keptDirectory();
    const runtime = await findNodeRuntime({
      pathEnv: [scratch.create(), nodeDirectory(false)].join(path.delimiter),
      platform,
      keptNodeDirectory: kept,
      readVersion: modern,
    });

    expect(runtime?.node.startsWith(kept)).toBe(true);
  });

  it('skips a Node older than the minimum', async () => {
    const kept = keptDirectory();
    const readVersion = vi.fn((node: string) =>
      Promise.resolve<string | undefined>(node.startsWith(kept) ? '22.12.0' : '20.11.0'),
    );
    const onPath = nodeDirectory();

    const runtime = await findNodeRuntime({
      pathEnv: onPath,
      platform,
      keptNodeDirectory: kept,
      readVersion,
    });

    expect(readVersion).toHaveBeenCalledWith(path.join(onPath, executable));
    expect(runtime?.node.startsWith(kept)).toBe(true);
  });

  it('skips a Node whose version cannot be read', async () => {
    const runtime = await findNodeRuntime({
      pathEnv: nodeDirectory(),
      platform,
      keptNodeDirectory: scratch.create(),
      readVersion: () => Promise.resolve(undefined),
    });

    expect(runtime).toBeUndefined();
  });

  it('accepts a version with or without the leading v', async () => {
    const options = {
      pathEnv: nodeDirectory(),
      platform,
      keptNodeDirectory: scratch.create(),
    } as const;

    const withV = await findNodeRuntime({
      ...options,
      readVersion: () => Promise.resolve('v24.1.0'),
    });
    const without = await findNodeRuntime({
      ...options,
      readVersion: () => Promise.resolve('24.1.0'),
    });

    expect(withV).toBeDefined();
    expect(without).toEqual(withV);
  });

  it('returns undefined when no candidate exists', async () => {
    const readVersion = vi.fn(modern);

    const runtime = await findNodeRuntime({
      pathEnv: scratch.create(),
      platform,
      keptNodeDirectory: scratch.create(),
      readVersion,
    });

    expect(runtime).toBeUndefined();
    expect(readVersion).not.toHaveBeenCalled();
  });
});
