import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import {
  ADDON_DESCRIPTOR_FILE,
  addonDescriptorSchema,
  isSafeRelativePath,
  type AddonDescriptor,
} from './manifest';
import type { AddonPin } from './pins';

/**
 * Where add-ons live and how one is installed.
 *
 * Layout: `<dataRoot>/addons/<id>/<identity>/`, holding the archive's contents
 * plus the `addon.json` it shipped. The identity is a digest of the add-on's
 * own sources, computed at build time, so a changed add-on lands in a new
 * folder and an unchanged one is reused.
 *
 * The install is atomic: the archive is extracted into `<identity>.partial`,
 * its descriptor is checked against the pin, and only then is it renamed into
 * place. Other identities of the same id are removed after a successful
 * install, so the folder never keeps an add-on this build will never use.
 */

export type AddonInstallFailure = 'archive' | 'extract' | 'id' | 'identity' | 'apiVersion';

/** A typed install fault; the manager maps it to a user-facing reason. */
export class AddonInstallError extends Error {
  constructor(readonly reason: AddonInstallFailure) {
    super(reason);
    this.name = 'AddonInstallError';
  }
}

export interface InstalledAddon {
  /** The folder the application loads the add-on from. */
  readonly dir: string;
  readonly descriptor: AddonDescriptor;
}

export interface AddonStoreOptions {
  /** `<dataRoot>/addons`. */
  readonly root: string;
}

export interface AddonStore {
  directoryFor(id: string, identity: string): string;
  /** The installed pinned identity, when the folder is present and valid. */
  readInstalled(id: string, pin: AddonPin): InstalledAddon | undefined;
  /**
   * Extracts `archive` into the pinned identity's folder and returns it. Throws
   * {@link AddonInstallError} when the archive is unusable or is not the pinned
   * add-on; a thrown install leaves no trace at the final path.
   */
  installArchive(id: string, pin: AddonPin, archive: Uint8Array): InstalledAddon;
  /** Deletes every identity of `id` except `keep`, and any leftover partial folder. */
  removeOtherVersions(id: string, keep: string): void;
}

const PARTIAL_SUFFIX = '.partial';

/**
 * Reads and validates one add-on folder's `addon.json`. A missing or malformed
 * descriptor means "not an add-on folder", never a throw.
 */
export function readAddonDescriptor(dir: string): AddonDescriptor | undefined {
  try {
    const parsed = addonDescriptorSchema.safeParse(
      JSON.parse(readFileSync(path.join(dir, ADDON_DESCRIPTOR_FILE), 'utf8')),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function createAddonStore(options: AddonStoreOptions): AddonStore {
  function directoryFor(id: string, identity: string): string {
    return path.join(options.root, id, identity);
  }

  function readDescriptor(dir: string): AddonDescriptor | undefined {
    return readAddonDescriptor(dir);
  }

  function readInstalled(id: string, pin: AddonPin): InstalledAddon | undefined {
    const dir = directoryFor(id, pin.identity);
    const descriptor = readDescriptor(dir);
    if (descriptor === undefined) return undefined;
    if (
      descriptor.id !== id ||
      descriptor.identity !== pin.identity ||
      descriptor.apiVersion !== pin.apiVersion
    ) {
      return undefined;
    }
    return { dir, descriptor };
  }

  /**
   * Extracts the archive into `partialDir` and validates the descriptor it
   * carries. A fault is returned instead of thrown so the caller cleans the
   * partial folder up in one place.
   */
  function extractVerifiedDescriptor(
    entries: Record<string, Uint8Array>,
    partialDir: string,
    id: string,
    pin: AddonPin,
  ): AddonDescriptor | AddonInstallError {
    let descriptor: AddonDescriptor | undefined;
    try {
      for (const [name, bytes] of Object.entries(entries)) {
        const relative = name.replace(/\\/g, '/');
        if (relative.endsWith('/')) continue;
        if (!isSafeRelativePath(relative)) return new AddonInstallError('extract');
        const target = path.join(partialDir, ...relative.split('/'));
        if (!target.startsWith(partialDir + path.sep)) {
          return new AddonInstallError('extract');
        }
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      }
      descriptor = readDescriptor(partialDir);
    } catch {
      return new AddonInstallError('extract');
    }
    if (descriptor === undefined) return new AddonInstallError('extract');
    if (descriptor.id !== id) return new AddonInstallError('id');
    if (descriptor.identity !== pin.identity) return new AddonInstallError('identity');
    if (descriptor.apiVersion !== pin.apiVersion) return new AddonInstallError('apiVersion');
    return descriptor;
  }

  function installArchive(id: string, pin: AddonPin, archive: Uint8Array): InstalledAddon {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(archive);
    } catch {
      throw new AddonInstallError('archive');
    }

    const finalDir = directoryFor(id, pin.identity);
    const partialDir = `${finalDir}${PARTIAL_SUFFIX}`;
    rmSync(partialDir, { recursive: true, force: true });
    mkdirSync(partialDir, { recursive: true });
    const descriptor = extractVerifiedDescriptor(entries, partialDir, id, pin);
    if (descriptor instanceof AddonInstallError) {
      rmSync(partialDir, { recursive: true, force: true });
      throw descriptor;
    }
    try {
      rmSync(finalDir, { recursive: true, force: true });
      renameSync(partialDir, finalDir);
      removeOtherVersions(id, pin.identity);
      return { dir: finalDir, descriptor };
    } catch {
      rmSync(partialDir, { recursive: true, force: true });
      throw new AddonInstallError('extract');
    }
  }

  function removeOtherVersions(id: string, keep: string): void {
    const idDir = path.join(options.root, id);
    let entries: string[];
    try {
      entries = readdirSync(idDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === keep) continue;
      rmSync(path.join(idDir, entry), { recursive: true, force: true });
    }
  }

  return { directoryFor, readInstalled, installArchive, removeOtherVersions };
}
