import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type Result } from '../../shared';
import type { Logger } from '../logger';
import { compareVersions } from '../updates/version';
import { ADDON_DESCRIPTOR_FILE } from './manifest';
import type { ScannedAddon } from './scan';

/** The oldest Node.js that may run an add-on's npm install. */
export const ADDON_BUILD_MINIMUM_NODE = '22.12.0';

export const ADDON_BUILD_TIMEOUT_MS = 10 * 60_000;

const READY_MARKER = '.ready';
const LOCK_FILE = 'package-lock.json';
const PACKAGE_FILE = 'package.json';

export interface NodeRuntime {
  readonly node: string;
  readonly npmCli: string;
}

export type AddonBuildFailureReason =
  'http-status' | 'insecure' | 'network' | 'no-node' | 'timeout' | 'too-large' | 'unexpected';

export interface AddonBuildFailure {
  /** User-facing, names the add-on and never contains a path. */
  readonly message: string;
  readonly reason: AddonBuildFailureReason;
}

export interface AddonBuilder {
  /**
   * Returns the folder an add-on's entry point may be imported from, installing
   * its dependencies first if this build has not done so yet. `onInstall` fires
   * once, only when an install actually starts.
   */
  ensureBuilt(
    id: string,
    scanned: ScannedAddon,
    onInstall?: () => void,
  ): Promise<Result<string, AddonBuildFailure>>;
}

export type NpmOutcome = 'ok' | 'failed' | 'timeout';

export interface AddonBuilderOptions {
  /** Where an add-on built on its first call lives: `<builtRoot>/<id>/<key>`. */
  readonly builtRoot: string;
  /** The Node.js the installer had to download, if it did. */
  readonly keptNodeDirectory: string;
  readonly logger: Pick<Logger, 'warn'>;
  readonly proxyEnv?: () => Promise<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly findNode?: () => Promise<NodeRuntime | undefined>;
  /** Puts the pinned portable Node.js into `keptNodeDirectory` when none was found. */
  readonly downloadNode?: () => Promise<Result<void, { readonly reason: AddonBuildFailureReason }>>;
  readonly runNpm?: (
    runtime: NodeRuntime,
    directory: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
  ) => Promise<NpmOutcome>;
}

export interface NodeSearchOptions {
  readonly pathEnv: string;
  readonly platform: NodeJS.Platform;
  readonly keptNodeDirectory: string;
  readonly readVersion: (node: string) => Promise<string | undefined>;
}

function realDirectory(file: string): string {
  try {
    return path.dirname(realpathSync(file));
  } catch {
    return path.dirname(file);
  }
}

/** The npm CLI that belongs to a Node.js executable, for both archive layouts. */
export function npmCliFor(node: string): string | undefined {
  for (const directory of new Set([path.dirname(node), realDirectory(node)])) {
    const candidates = [
      path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The Node.js to build with: one already on the machine (PATH, plus the
 * Homebrew prefixes a macOS GUI app's PATH omits), else the copy the installer
 * kept because it had to download one. Undefined when neither is usable.
 */
export async function findNodeRuntime(
  options: NodeSearchOptions,
): Promise<NodeRuntime | undefined> {
  const windows = options.platform === 'win32';
  const executable = windows ? 'node.exe' : 'node';
  const directories = options.pathEnv.split(path.delimiter).filter((entry) => entry !== '');
  if (options.platform === 'darwin') directories.push('/usr/local/bin', '/opt/homebrew/bin');
  const candidates = [
    ...directories.map((directory) => path.join(directory, executable)),
    windows
      ? path.join(options.keptNodeDirectory, executable)
      : path.join(options.keptNodeDirectory, 'bin', executable),
  ];
  for (const node of candidates) {
    if (!existsSync(node)) continue;
    const npmCli = npmCliFor(node);
    if (npmCli === undefined) continue;
    const version = (await options.readVersion(node))?.replace(/^v/, '');
    if (version === undefined || compareVersions(version, ADDON_BUILD_MINIMUM_NODE) < 0) continue;
    return { node, npmCli };
  }
  return undefined;
}

function readNodeVersion(node: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(node, ['--version'], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      resolve(error === null ? stdout.trim() : undefined);
    });
  });
}

function runNpmInstall(
  runtime: NodeRuntime,
  directory: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<NpmOutcome> {
  const command = existsSync(path.join(directory, LOCK_FILE)) ? 'ci' : 'install';
  return new Promise((resolve) => {
    const child = spawn(
      runtime.node,
      [
        runtime.npmCli,
        command,
        '--prefix',
        directory,
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
      ],
      { cwd: directory, env, stdio: 'ignore', windowsHide: true },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      resolve('failed');
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(timedOut ? 'timeout' : code === 0 ? 'ok' : 'failed');
    });
  });
}

/** What the add-on's built folder is keyed by: change any of it and it is rebuilt. */
async function cacheKey(directory: string, files: readonly string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file).update('\0');
    hash.update(await readFile(path.join(directory, ...file.split('/'))));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

export function createAddonBuilder(options: AddonBuilderOptions): AddonBuilder {
  const timeoutMs = options.timeoutMs ?? ADDON_BUILD_TIMEOUT_MS;
  const findNode =
    options.findNode ??
    (() =>
      findNodeRuntime({
        pathEnv: process.env['PATH'] ?? process.env['Path'] ?? '',
        platform: process.platform,
        keptNodeDirectory: options.keptNodeDirectory,
        readVersion: readNodeVersion,
      }));
  const runNpm = options.runNpm ?? runNpmInstall;
  const inFlight = new Map<string, Promise<Result<string, AddonBuildFailure>>>();

  function fail(
    id: string,
    reason: AddonBuildFailureReason,
    message: string,
  ): Result<string, AddonBuildFailure> {
    options.logger.warn('ADDON_BUILD_FAILED', { outcome: 'failure', addonId: id, reason });
    return err({ message, reason });
  }

  async function build(
    id: string,
    scanned: ScannedAddon,
    onInstall: (() => void) | undefined,
  ): Promise<Result<string, AddonBuildFailure>> {
    const source = scanned.directory;
    // No dependencies to install, or already installed (a development build).
    if (
      !existsSync(path.join(source, PACKAGE_FILE)) ||
      existsSync(path.join(source, 'node_modules'))
    ) {
      return ok(source);
    }
    try {
      const files = [
        scanned.descriptor.entry,
        ADDON_DESCRIPTOR_FILE,
        PACKAGE_FILE,
        ...(existsSync(path.join(source, LOCK_FILE)) ? [LOCK_FILE] : []),
      ];
      const addonRoot = path.join(options.builtRoot, id);
      const key = await cacheKey(source, files);
      const target = path.join(addonRoot, key);
      if (existsSync(path.join(target, READY_MARKER))) return ok(target);

      onInstall?.();
      let runtime = await findNode();
      if (runtime === undefined && options.downloadNode !== undefined) {
        const downloaded = await options.downloadNode();
        if (!downloaded.ok) {
          return fail(
            id,
            downloaded.error.reason,
            `The "${id}" add-on needs Node.js to prepare its tools, and downloading it failed. Check the network connection and try again`,
          );
        }
        runtime = await findNode();
      }
      if (runtime === undefined) {
        return fail(
          id,
          'no-node',
          `The "${id}" add-on needs Node.js ${ADDON_BUILD_MINIMUM_NODE} or newer with npm to prepare its tools, and none could be found or installed. Install Node.js and try again`,
        );
      }
      await rm(target, { recursive: true, force: true });
      for (const file of files) {
        const destination = path.join(target, ...file.split('/'));
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(path.join(source, ...file.split('/')), destination);
      }
      const env: NodeJS.ProcessEnv = { ...process.env, ...(await options.proxyEnv?.()) };
      delete env['ELECTRON_RUN_AS_NODE'];
      const outcome = await runNpm(runtime, target, env, timeoutMs);
      if (outcome !== 'ok') {
        await rm(target, { recursive: true, force: true });
        return outcome === 'timeout'
          ? fail(id, 'timeout', `Preparing the "${id}" add-on's tools took too long. Try again`)
          : fail(id, 'unexpected', `The "${id}" add-on's tools could not be installed. Try again`);
      }
      await writeFile(path.join(target, READY_MARKER), '');
      await removeStaleBuilds(addonRoot, key);
      return ok(target);
    } catch {
      return fail(id, 'unexpected', `The "${id}" add-on's tools could not be prepared. Try again`);
    }
  }

  return {
    ensureBuilt(id, scanned, onInstall) {
      const running = inFlight.get(id);
      if (running !== undefined) return running;
      const started = build(id, scanned, onInstall).finally(() => inFlight.delete(id));
      inFlight.set(id, started);
      return started;
    },
  };
}

/** Older builds of one add-on are not needed once the current one is ready. */
async function removeStaleBuilds(addonRoot: string, keep: string): Promise<void> {
  try {
    for (const name of await readdir(addonRoot)) {
      if (name !== keep) await rm(path.join(addonRoot, name), { recursive: true, force: true });
    }
  } catch {
    // A stale build that cannot be removed is only wasted space.
  }
}
