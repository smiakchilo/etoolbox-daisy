import path from 'node:path';
import type { AgentFetch } from '../../shared';
import { type Result, err, ok } from '../../shared';
import type { Logger } from '../logger';
import { ArchiveDownloadError } from '../updates/download';
import { type AddonSource, archiveFor, downloadAddonArchive, readAddonCatalog } from './downloader';
import { type AddonPin, type AddonPins } from './pins';
import {
  AddonInstallError,
  readAddonDescriptor,
  type AddonStore,
  type InstalledAddon,
} from './store';

/**
 * The one entry point a feature uses to reach its add-on.
 *
 * `ensure(id)` answers the installed folder for the version this build pins -
 * from the repository's own build output in a development build, from the
 * installed folder when the pinned version is already there, and only otherwise
 * by downloading it. It is single-flight per id: two turns that need the same
 * add-on at the same moment share one install.
 *
 * Every failure is typed, never thrown: the feature reports it (a tool billet, a
 * sign-in status) instead of crashing the application.
 */

export type AddonFailureReason =
  'cancelled' | 'extract' | 'hash' | 'apiVersion' | 'kind' | 'version' | 'offline';

export interface AddonFailure {
  readonly reason: AddonFailureReason;
  readonly message: string;
}

export interface EnsureAddonOptions {
  /** 0..1 while the archive arrives; the caller renders it on a progress line. */
  readonly onProgress?: (fraction: number) => void;
  readonly signal?: AbortSignal | undefined;
}

export interface AddonManager {
  /** The folder and descriptor of the pinned version, installed if needed. */
  ensure(id: string, options?: EnsureAddonOptions): Promise<Result<InstalledAddon, AddonFailure>>;
  /** Reads a named file a binary add-on provides, installing it if needed. */
  resolveFile(
    id: string,
    file: string,
    options?: EnsureAddonOptions,
  ): Promise<Result<string, AddonFailure>>;
}

export interface AddonManagerOptions {
  readonly store: AddonStore;
  readonly pins: AddonPins;
  /** `<platform>-<arch>`, the key into a catalogue's `platforms`. */
  readonly platformKey: string;
  /** The repository's own built add-on, when this is a development build. */
  readonly devDirectory: (id: string) => string | undefined;
  /** Where to read the catalogue from right now; no sources means offline. */
  readonly readSources: () => Promise<{
    readonly sources: readonly AddonSource[];
    readonly fetch?: AgentFetch | undefined;
  }>;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
}

const FAILURE_MESSAGES: Readonly<Record<AddonFailureReason, string>> = {
  cancelled: 'The download was cancelled',
  extract: 'The downloaded add-on could not be installed',
  hash: 'The downloaded add-on did not match its published checksum',
  apiVersion: 'The downloaded add-on is not compatible with this version of the application',
  kind: 'The downloaded add-on is not the kind this feature needs',
  version: 'The downloaded add-on is not the version this application needs',
  offline: 'The add-on is not installed and could not be downloaded',
};

function failure(reason: AddonFailureReason): AddonFailure {
  return { reason, message: FAILURE_MESSAGES[reason] };
}

/** A call so TypeScript cannot narrow the signal across the install's await points. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function createAddonManager(options: AddonManagerOptions): AddonManager {
  const inFlight = new Map<string, Promise<Result<InstalledAddon, AddonFailure>>>();

  function pinFor(id: string): AddonPin | undefined {
    return options.pins[id];
  }

  function loadDev(id: string, pin: AddonPin, dir: string): Result<InstalledAddon, AddonFailure> {
    const descriptor = readAddonDescriptor(dir);
    if (descriptor === undefined) return err(failure('extract'));
    if (descriptor.id !== id) return err(failure('version'));
    if (descriptor.version !== pin.version) return err(failure('version'));
    if (descriptor.apiVersion !== pin.apiVersion) return err(failure('apiVersion'));
    return ok({ dir, descriptor });
  }

  async function install(
    id: string,
    pin: AddonPin,
    settings: EnsureAddonOptions,
  ): Promise<Result<InstalledAddon, AddonFailure>> {
    const dev = options.devDirectory(id);
    if (dev !== undefined) {
      // A development build carries its own add-ons and never downloads one.
      const loaded = loadDev(id, pin, dev);
      if (loaded.ok) settings.onProgress?.(1);
      else options.logger.warn('ADDON_FAILED', { outcome: 'failure' });
      return loaded;
    }

    const installed = options.store.readInstalled(id, pin);
    if (installed !== undefined) {
      settings.onProgress?.(1);
      return ok(installed);
    }

    let reason: AddonFailureReason = 'offline';
    try {
      const { sources, fetch } = await options.readSources();
      for (const source of sources) {
        if (isAborted(settings.signal)) return err(failure('cancelled'));
        const catalog = await readAddonCatalog(source, { fetch });
        if (catalog === undefined) continue;
        const archive = archiveFor(catalog, id, pin.version, options.platformKey);
        if (archive === undefined) continue;
        try {
          const bytes = await downloadAddonArchive(source, archive, {
            fetch,
            ...(settings.onProgress === undefined ? {} : { onProgress: settings.onProgress }),
            ...(settings.signal === undefined ? {} : { signal: settings.signal }),
          });
          const installedNow = options.store.installArchive(id, pin, bytes);
          options.logger.info('ADDON_INSTALLED', { outcome: 'success' });
          return ok(installedNow);
        } catch (error) {
          if (isAborted(settings.signal)) return err(failure('cancelled'));
          reason =
            error instanceof AddonInstallError
              ? error.reason === 'apiVersion'
                ? 'apiVersion'
                : error.reason === 'version'
                  ? 'version'
                  : error.reason === 'id'
                    ? 'version'
                    : 'extract'
              : error instanceof ArchiveDownloadError
                ? error.reason === 'hash' || error.reason === 'size'
                  ? 'hash'
                  : 'offline'
                : 'offline';
        }
      }
    } catch {
      reason = 'offline';
    }
    options.logger.warn('ADDON_FAILED', { outcome: 'failure' });
    return err(failure(reason));
  }

  function ensure(
    id: string,
    settings: EnsureAddonOptions = {},
  ): Promise<Result<InstalledAddon, AddonFailure>> {
    const pin = pinFor(id);
    if (pin === undefined) return Promise.resolve(err(failure('offline')));
    const existing = inFlight.get(id);
    if (existing !== undefined) return existing;
    const run = install(id, pin, settings);
    inFlight.set(id, run);
    return run.finally(() => {
      inFlight.delete(id);
    });
  }

  async function resolveFile(
    id: string,
    file: string,
    settings: EnsureAddonOptions = {},
  ): Promise<Result<string, AddonFailure>> {
    const ensured = await ensure(id, settings);
    if (!ensured.ok) return ensured;
    const relative = ensured.value.descriptor.files?.[file];
    if (ensured.value.descriptor.kind !== 'binary' || relative === undefined) {
      return err(failure('kind'));
    }
    return ok(path.join(ensured.value.dir, ...relative.split('/')));
  }

  return { ensure, resolveFile };
}
