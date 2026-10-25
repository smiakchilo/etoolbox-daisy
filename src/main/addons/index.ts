import { existsSync } from 'node:fs';
import type { AppSettings } from '../../shared';
import type { Logger } from '../logger';
import type { SecretStore } from '../secretStore';
import { readUpdateBuildInfo } from '../updates/composition';
import { resolveFolderUrl } from '../updates/manifest';
import { createUpdateFetch } from '../updates/proxy';
import { resolveDevAddonDirectory } from './devSource';
import type { AddonSource } from './downloader';
import { addonPins } from './pins';
import { createAddonManager, type AddonManager } from './manager';
import { createAddonStore } from './store';

export { createPageAuditCapability, type PageAuditAddonRuntimeDeps } from './pageAudit';
export type { AddonFailure, AddonManager } from './manager';
export { createAddonTestProbe, TEST_ADDONS_GLOBAL_KEY, type AddonTestProbe } from './testProbe';

/** Dev/QA switch: a local folder holding `addons.json` and the archives. */
export const ADDON_SOURCE_ENV = 'EDAISY_ADDON_SOURCE';

export interface AppAddonsOptions {
  /** `<dataRoot>/addons`. */
  readonly addonsRoot: string;
  /** The directory holding the built main bundle (`out/main`). */
  readonly mainDirectory: string;
  readonly resourcesPath: string;
  readonly appPath: string;
  readonly isPackaged: boolean;
  readonly platformKey: string;
  readonly readSettings: () => AppSettings;
  readonly secretStore: Pick<SecretStore, 'get'>;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  /** `process.env`; injected so a test can drive the sandbox switch. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Wires the add-on manager: where add-ons are installed, which versions this
 * build pins, where a development build keeps its own copies, and where a
 * catalogue is read from (the updater's own folders, through the updater's own
 * proxy).
 */
export function createAppAddons(options: AppAddonsOptions): AddonManager {
  const env = options.env ?? process.env;
  const sandbox = env[ADDON_SOURCE_ENV];
  const localSource: AddonSource | undefined =
    sandbox === undefined || sandbox === '' || options.isPackaged
      ? undefined
      : { kind: 'local', directory: sandbox };

  return createAddonManager({
    store: createAddonStore({ root: options.addonsRoot }),
    pins: addonPins,
    platformKey: options.platformKey,
    devDirectory: (id) =>
      // A QA sandbox forces the download path: that is what it is for.
      localSource !== undefined
        ? undefined
        : resolveDevAddonDirectory(id, {
            mainDirectory: options.mainDirectory,
            resourcesPath: options.resourcesPath,
            isPackaged: options.isPackaged,
            exists: existsSync,
          }),
    readSources: async () => {
      if (localSource !== undefined) return { sources: [localSource] };
      const settings = options.readSettings();
      const folders = [
        ...(settings.updates.url === undefined ? [] : [settings.updates.url]),
        ...readUpdateBuildInfo(options.appPath).urls,
      ];
      const sources: AddonSource[] = [];
      for (const folder of folders) {
        const url = resolveFolderUrl(folder);
        if (url !== undefined) sources.push({ kind: 'https', url });
      }
      if (sources.length === 0) return { sources };
      const fetch = await createUpdateFetch(settings, options.secretStore);
      return { sources, fetch };
    },
    logger: options.logger,
  });
}
