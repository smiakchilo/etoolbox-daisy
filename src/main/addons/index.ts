import type { Logger } from '../logger';
import { createAddonHost, type AddonHostDeps } from './addonHost';
import type { AddonBuilder } from './builder';
import { createAddonLoader, type AddonLoader } from './loader';
import type { ScannedAddon } from './scan';

export { createAddonHost, addonPartitionName, type AddonHostHandle } from './addonHost';
export {
  createAddonBuilder,
  type AddonBuilder,
  type AddonBuilderOptions,
  type AddonBuildFailure,
} from './builder';
export {
  createAddonLoader,
  type AddonLoadFailure,
  type AddonLoadFailureKind,
  type AddonLoader,
} from './loader';
export {
  createNodeDownloader,
  type NodeDownloader,
  type NodeDownloaderOptions,
  type NodeDownloadFailure,
} from './nodeDownload';
export { addonsDirectory, scanAddons, type ScannedAddon } from './scan';

export interface AppAddonLoaderOptions extends AddonHostDeps {
  readonly entries: readonly ScannedAddon[];
  readonly logger: Pick<Logger, 'warn'>;
  /** Installs an add-on's dependencies on its first call. */
  readonly builder?: AddonBuilder;
}

/**
 * The loader this build uses: one generic host per add-on id, created on first
 * use, and one load per add-on shared by every tool and skill it contributes.
 */
export function createAppAddonLoader(options: AppAddonLoaderOptions): AddonLoader {
  return createAddonLoader({
    entries: options.entries,
    ...(options.builder === undefined ? {} : { builder: options.builder }),
    createHost: (id) =>
      createAddonHost(id, {
        paneSession: options.paneSession,
        currentUrl: options.currentUrl,
        isConfiguredOrigin: options.isConfiguredOrigin,
        logger: options.logger,
      }),
  });
}
