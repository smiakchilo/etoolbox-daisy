import { readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import type { AppSettings, UpdateStatus } from '../../shared';
import type { Logger } from '../logger';
import type { SecretStore } from '../secretStore';
import { macBundlePath, startApplyScript } from './applier';
import { platformKey } from './manifest';
import { createUpdateFetch } from './proxy';
import { describeInstalledRuntime } from './runtime';
import { createUpdater, type Updater } from './updater';

/** The `updates` object of `package.json`: the folders an install checks for updates. */
const updatesPackageSchema = z.object({
  updates: z.object({ urls: z.array(z.string()).default([]) }).default({ urls: [] }),
});

export interface UpdateBuildInfo {
  readonly urls: readonly string[];
}

/** Reads `<appPath>/package.json`; a missing or malformed file means "no built-in sources". */
export function readUpdateBuildInfo(appPath: string): UpdateBuildInfo {
  try {
    const raw: unknown = JSON.parse(readFileSync(path.join(appPath, 'package.json'), 'utf8'));
    return updatesPackageSchema.parse(raw).updates;
  } catch {
    return { urls: [] };
  }
}

/** Dev/QA switch: a scratch install the whole flow runs against, honoured only unpackaged. */
export const UPDATE_SANDBOX_ENV = 'EDAISY_UPDATE_SANDBOX';

/**
 * The archive an update replaces, or `undefined` when this process cannot be
 * updated in place (unpackaged, with no sandbox).
 */
export function resolveTargetAsar(options: {
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly sandbox: string | undefined;
}): string | undefined {
  if (!options.isPackaged) {
    return options.sandbox === undefined || options.sandbox === ''
      ? undefined
      : path.join(options.sandbox, 'resources', 'app.asar');
  }
  return options.appPath.endsWith('.asar') ? options.appPath : undefined;
}

export interface AppUpdaterOptions {
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly installedVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly pid: number;
  readonly executablePath: string;
  readonly scratchDirectory: string;
  readonly sandbox: string | undefined;
  readonly readSettings: () => AppSettings;
  readonly secretStore: Pick<SecretStore, 'get'>;
  readonly logger: Logger;
  readonly quit: () => void;
  readonly onStatusChanged: (status: UpdateStatus) => void;
}

/** Wires the updater to the app: its sources, proxy, platform and the swap-and-relaunch step. */
export function createAppUpdater(options: AppUpdaterOptions): Updater {
  const build = readUpdateBuildInfo(options.appPath);
  const targetAsar = resolveTargetAsar(options);
  const sandboxed = !options.isPackaged;
  return createUpdater({
    installedVersion: options.installedVersion,
    readInstalledRuntime: () =>
      describeInstalledRuntime({
        appPath: options.appPath,
        electronVersion: process.versions.electron,
      }),
    platformKey: platformKey(options.platform, options.arch),
    builtinUrls: build.urls,
    customUrl: () => options.readSettings().updates.url,
    createFetch: () => createUpdateFetch(options.readSettings(), options.secretStore),
    targetAsar,
    install: (stagedAsar) => {
      if (targetAsar === undefined) throw new Error('not updatable in place');
      if (sandboxed) {
        // A scratch install is not the running app: swap in-process, keep running.
        rmSync(`${targetAsar}.bak`, { force: true });
        renameSync(targetAsar, `${targetAsar}.bak`);
        renameSync(stagedAsar, targetAsar);
        return { restart: false };
      }
      startApplyScript(
        {
          targetAsar,
          stagedAsar,
          pid: options.pid,
          relaunchPath:
            options.platform === 'darwin' ? macBundlePath(targetAsar) : options.executablePath,
        },
        options.platform,
        options.scratchDirectory,
      );
      return { restart: true };
    },
    quit: options.quit,
    logger: options.logger,
    onStatusChanged: options.onStatusChanged,
  });
}
