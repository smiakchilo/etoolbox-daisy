import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import type { UpdateRuntimePart } from '../../shared';

/**
 * The runtime layer an archive runs on: the parts of an install an `app.asar`
 * swap cannot replace. It is **derived, never declared** - there is no manual
 * generation counter to forget.
 *
 * An update installs one file, `resources/app.asar`. Everything else in the
 * install - the Electron binary, `resources/app.asar.unpacked` (the Copilot
 * runtime's executables and native modules) - stays exactly as the full
 * installation left it. So the question "may this archive be swapped in?" is
 * "was this install built with the same runtime layer as that archive?", and
 * both sides can answer it from what they physically have:
 *
 * - the **published manifest** (`scripts/runtime-descriptor.mjs`, which walks
 *   the packaged output) says which runtime its archive needs;
 * - the **installed app** ({@link describeInstalledRuntime}) describes the
 *   runtime it is actually running on.
 *
 * The comparison is equality of {@link RuntimeDescriptor}s, so moving Electron,
 * changing the packaging layout or shipping a new Copilot runtime needs no
 * bookkeeping at all - the descriptor changes because the files changed. Bundled
 * application data (skills, rules, icons) deliberately does **not** appear here:
 * it lives inside `app.asar` and therefore travels with the swap.
 */
export const RUNTIME_DESCRIPTOR_FORMAT = 1;

/**
 * Longest description of the unpacked payload this will index. The Copilot
 * runtime is ~67 files; a bound far above that refuses an unexpected tree
 * rather than walking it forever.
 */
const MAX_PAYLOAD_FILES = 5000;

/** 16 bytes of sha256 - enough to tell two builds apart, short in a manifest. */
const PAYLOAD_HASH_LENGTH = 32;

/**
 * `runtime` in an `update.json` file entry. `strict` because it is read by the
 * application that must trust it: an unknown key means this build cannot be
 * sure what that archive needs, and the manifest is then rejected.
 */
export const runtimeDescriptorSchema = z
  .object({
    format: z.literal(RUNTIME_DESCRIPTOR_FORMAT),
    /** The Electron version the archive was packaged against (`process.versions.electron`). */
    electron: z.string().regex(/^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/),
    /** {@link runtimePayloadHash} of `resources/app.asar.unpacked`. */
    payload: z.string().regex(new RegExp(`^[0-9a-f]{${PAYLOAD_HASH_LENGTH}}$`)),
  })
  .strict();

export type RuntimeDescriptor = Readonly<z.infer<typeof runtimeDescriptorSchema>>;

/** One file of the unpacked payload, as the descriptor sees it. */
export interface RuntimeFileEntry {
  /** `/`-separated path relative to the payload directory. */
  readonly path: string;
  readonly size: number;
}

/**
 * The payload's identity: every path with its size, sorted by code unit and
 * hashed.
 *
 * Deliberately **not** a content hash - the payload is ~110 MB and this runs on
 * every update check - and deliberately not `localeCompare`, whose order depends
 * on the machine's locale: the producer and the consumer must agree byte for
 * byte. Names and sizes are enough to tell one packaged runtime from another
 * (an executable rebuild changes its size) without reading a megabyte of it.
 */
export function runtimePayloadHash(entries: readonly RuntimeFileEntry[]): string {
  const canonical = entries
    .map((entry) => `${entry.path}:${entry.size}`)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, PAYLOAD_HASH_LENGTH);
}

/**
 * Lists the payload's files. A missing directory is an empty payload rather
 * than an error (a build with nothing unpacked, or a tree that has not been
 * packaged); anything unreadable is skipped for the same reason - the caller
 * only ever compares the result, and a payload it cannot read is reported as
 * a difference, never as a match.
 */
export async function describeRuntimePayloadFiles(
  root: string,
): Promise<readonly RuntimeFileEntry[]> {
  const files: RuntimeFileEntry[] = [];

  async function walk(directory: string, relative: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
      // Links are never followed: they are not part of what was packaged.
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), entryRelative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= MAX_PAYLOAD_FILES) {
        throw new Error(`The runtime payload has more than ${MAX_PAYLOAD_FILES} files.`);
      }
      const { size } = await lstat(path.join(directory, entry.name));
      files.push({ path: entryRelative, size });
    }
  }

  await walk(root, '');
  return files;
}

/**
 * Where electron-builder puts the files an asar cannot serve from inside the
 * archive: `resources/app.asar.unpacked`, a sibling of the archive itself.
 */
export function resolveRuntimePayloadDirectory(appPath: string): string {
  return `${appPath}.unpacked`;
}

export interface InstalledRuntimeOptions {
  /** `app.getAppPath()` - the running `app.asar`, or the repository root unpackaged. */
  readonly appPath: string;
  /** `process.versions.electron` - read from the binary that is actually running. */
  readonly electronVersion: string;
}

/** Describes the runtime layer this process is running on. */
export async function describeInstalledRuntime(
  options: InstalledRuntimeOptions,
): Promise<RuntimeDescriptor> {
  const files = await describeRuntimePayloadFiles(resolveRuntimePayloadDirectory(options.appPath));
  return {
    format: RUNTIME_DESCRIPTOR_FORMAT,
    electron: options.electronVersion,
    payload: runtimePayloadHash(files),
  };
}

/**
 * Which parts of the runtime layer differ between an install and an archive, in
 * a stable order; empty means the swap is safe. A `format` difference makes the
 * rest incomparable, so it is reported alone.
 */
export function describeRuntimeDifferences(
  installed: RuntimeDescriptor,
  required: RuntimeDescriptor,
): readonly UpdateRuntimePart[] {
  if (installed.format !== required.format) return ['format'];
  const changed: UpdateRuntimePart[] = [];
  if (installed.electron !== required.electron) changed.push('electron');
  if (installed.payload !== required.payload) changed.push('payload');
  return changed;
}
