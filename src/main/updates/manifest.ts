import { z } from 'zod';

import { runtimeDescriptorSchema } from './runtime';

/** The manifest file every update folder carries next to its per-platform archives. */
export const UPDATE_MANIFEST_FILE = 'update.json';

/** Upper bound for one archive; the app's own code is a few MB, so this is generous. */
export const MAX_UPDATE_ARCHIVE_BYTES = 150 * 1024 * 1024;

/** Upper bound for the manifest itself. */
export const MAX_MANIFEST_BYTES = 64 * 1024;

const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

const updateFileSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  sha512: z.string().regex(/^[0-9a-fA-F]{128}$/),
  size: z.number().int().positive().max(MAX_UPDATE_ARCHIVE_BYTES),
  /**
   * The runtime layer this archive needs; an install whose own layer differs
   * (Electron, the unpacked agent runtime) cannot swap it in and is told to
   * install a fresh copy instead. Derived by `scripts/runtime-descriptor.mjs`,
   * never written by hand - see `./runtime.ts`. An archive that carries none is
   * not offered at all: there is nothing else to vouch for it.
   */
  runtime: runtimeDescriptorSchema.optional(),
});

/**
 * `update.json`: the newest version and one archive per `<platform>-<arch>`.
 * Deliberately not strict - a manifest published by a newer toolchain may carry
 * fields this build does not know, and ignoring them is the forward-compatible
 * reading.
 */
export const updateManifestSchema = z.object({
  version: versionSchema,
  notes: z.string().max(2000).optional(),
  files: z.record(z.string(), updateFileSchema),
});

export type UpdateManifest = z.infer<typeof updateManifestSchema>;
export type UpdateFile = z.infer<typeof updateFileSchema>;

/** `<process.platform>-<process.arch>`, the key of {@link UpdateManifest.files}. */
export function platformKey(platform: string, arch: string): string {
  return `${platform}-${arch}`;
}

/** Compares dotted numeric versions; positive when `a` is newer. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Turns a configured update folder into the folder URL files are read from, or
 * `undefined` for anything that is not an `https` URL. A GitHub `tree` page
 * (`https://github.com/<owner>/<repo>/tree/<ref>/<path>`) is rewritten to the
 * raw-content host, since a folder page is HTML and a file there is not.
 */
export function resolveFolderUrl(folder: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(folder.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  url.search = '';
  url.hash = '';
  const tree = /^\/([^/]+)\/([^/]+)\/tree\/(.+)$/.exec(url.pathname);
  if (url.hostname === 'github.com' && tree !== null) {
    url = new URL(`https://raw.githubusercontent.com/${tree[1]}/${tree[2]}/${tree[3]}`);
  }
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url;
}

/** The URL of `fileName` inside `folder`. */
export function fileUrlIn(folder: URL, fileName: string): URL {
  return new URL(encodeURIComponent(fileName), folder);
}
