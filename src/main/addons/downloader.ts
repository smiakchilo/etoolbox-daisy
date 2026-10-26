import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentFetch } from '../../shared';
import {
  downloadVerifiedArchive,
  sha512Expectation,
  verifyArchive,
  ArchiveDownloadError,
} from '../updates/download';
import { fileUrlIn } from '../updates/manifest';
import {
  ADDON_CATALOG_FILE,
  ADDON_PLATFORM_ANY,
  MAX_ADDON_ARCHIVE_BYTES,
  MAX_ADDON_CATALOG_BYTES,
  addonCatalogSchema,
  type AddonArchive,
  type AddonCatalog,
} from './manifest';

/**
 * Reads an add-on catalogue and downloads one archive from it.
 *
 * A source is either an HTTPS folder (the same folders `update.json` lives in:
 * Settings' custom update URL, then the built-in `package.json` ones) or, for
 * tests and QA, a local folder behind `EDAISY_ADDON_SOURCE` - honoured only in
 * an unpackaged build. Both go through the same size/hash verification.
 */

export type AddonSource =
  | { readonly kind: 'https'; readonly url: URL }
  | { readonly kind: 'local'; readonly directory: string };

/** Generous: the Copilot CLI archive is around a hundred megabytes. */
export const ADDON_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export interface AddonDownloadOptions {
  readonly fetch?: AgentFetch | undefined;
  readonly onProgress?: ((fraction: number) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export async function readAddonCatalog(
  source: AddonSource,
  options: AddonDownloadOptions,
): Promise<AddonCatalog | undefined> {
  let text: string;
  try {
    if (source.kind === 'local') {
      text = await readFile(path.join(source.directory, ADDON_CATALOG_FILE), 'utf8');
    } else {
      if (options.fetch === undefined) return undefined;
      const response = await options.fetch(fileUrlIn(source.url, ADDON_CATALOG_FILE), {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok || !response.url.startsWith('https:')) return undefined;
      text = await response.text();
    }
  } catch {
    return undefined;
  }
  if (text.length > MAX_ADDON_CATALOG_BYTES) return undefined;
  try {
    const parsed = addonCatalogSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The archive this platform runs for one pinned identity, or `undefined`. */
export function archiveFor(
  catalog: AddonCatalog,
  id: string,
  identity: string,
  platformKey: string,
): AddonArchive | undefined {
  const platforms = catalog.addons[id]?.[identity]?.platforms;
  if (platforms === undefined) return undefined;
  return platforms[platformKey] ?? platforms[ADDON_PLATFORM_ANY];
}

/** Downloads the archive and verifies it against the catalogue's hash and size. */
export async function downloadAddonArchive(
  source: AddonSource,
  archive: AddonArchive,
  options: AddonDownloadOptions,
): Promise<Uint8Array> {
  if (source.kind === 'local') {
    const bytes = await readFile(path.join(source.directory, archive.file));
    options.onProgress?.(0);
    if (bytes.byteLength > MAX_ADDON_ARCHIVE_BYTES) {
      throw new ArchiveDownloadError('size', 'the add-on archive is too large');
    }
    const verdict = verifyArchive(bytes, sha512Expectation(archive));
    if (verdict !== 'ok') {
      throw new ArchiveDownloadError(verdict, `the add-on archive did not verify (${verdict})`);
    }
    options.onProgress?.(1);
    return bytes;
  }
  if (options.fetch === undefined) throw new Error('no fetch available');
  return await downloadVerifiedArchive(
    options.fetch,
    fileUrlIn(source.url, archive.file),
    sha512Expectation(archive),
    {
      timeoutMs: ADDON_DOWNLOAD_TIMEOUT_MS,
      maxBytes: MAX_ADDON_ARCHIVE_BYTES,
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
}
