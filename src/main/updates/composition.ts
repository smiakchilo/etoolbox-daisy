import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AppSettings, UpdateStatus } from '../../shared';
import type { Logger } from '../logger';
import type { SecretStore } from '../secretStore';
import { createUpdateFetch, createUpdateProxyEnv, isUpdateProxyConfigured } from './proxy';
import {
  type UpdatePlatform,
  bundledInstallScript,
  installedAppFolder,
  startUpdateScript,
} from './scriptRunner';
import { type Updater, createUpdater } from './updater';

/** Set by the install script on the app it launches after a swap; its value is the status file. */
export const UPDATE_STATUS_FILE_ENV = 'EDAISY_UPDATE_STATUS_FILE';

const STATUS_FILE_NAME = 'update-status.txt';

export interface AppUpdaterOptions {
  installedVersion: string;
  platform: NodeJS.Platform;
  pid: number;
  executablePath: string;
  resourcesPath: string;
  /** Where the status file lives when this run was not started by an update. */
  scratchDirectory: string;
  /** The value of {@link UPDATE_STATUS_FILE_ENV}, when this run was started by an update. */
  statusFileFromUpdate: string | undefined;
  readSettings: () => AppSettings;
  secretStore: Pick<SecretStore, 'get'>;
  logger: Logger;
  quit: () => void;
  onStatusChanged: (status: UpdateStatus) => void;
}

function updatePlatform(platform: NodeJS.Platform): UpdatePlatform | undefined {
  return platform === 'win32' || platform === 'darwin' ? platform : undefined;
}

export function createAppUpdater(options: AppUpdaterOptions): Updater {
  const platform = updatePlatform(options.platform);
  const statusFile =
    options.statusFileFromUpdate ?? path.join(options.scratchDirectory, STATUS_FILE_NAME);

  return createUpdater({
    installedVersion: options.installedVersion,
    source: () => options.readSettings().updates.source,
    createFetch: () => createUpdateFetch(options.readSettings(), options.secretStore),
    usesProxy: () => isUpdateProxyConfigured(options.readSettings()),
    statusFile,
    startedByUpdate: options.statusFileFromUpdate !== undefined,
    launch: async (source) => {
      if (platform === undefined) {
        throw new Error('Updating is not supported on this platform');
      }
      const bundledScript = bundledInstallScript(options.resourcesPath, platform);
      if (!existsSync(bundledScript)) {
        throw new Error(
          'This build has no update script (resources/install), so it cannot update itself. Build it with the install script, or with "npm run package:dir".',
        );
      }
      const env = await createUpdateProxyEnv(options.readSettings(), options.secretStore);
      startUpdateScript({
        bundledScript,
        source,
        appFolder: installedAppFolder(options.executablePath, platform),
        pid: options.pid,
        statusFile,
        env,
        platform,
        scratchDirectory: options.scratchDirectory,
      });
    },
    quit: options.quit,
    logger: options.logger,
    onStatusChanged: options.onStatusChanged,
  });
}
