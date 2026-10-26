import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cliExecutableName } from './discovery';
import { compareCliVersions } from './version';

/**
 * The CLIs this agent downloaded itself, one folder per version.
 *
 * Deliberately **not** the add-on store: nothing here is pinned, published or
 * checksummed by us. It is a cache of a third-party binary, keyed by the
 * version we observed, kept so a second sign-in is instant and works offline,
 * and pruned to the one version in use.
 */

export interface CachedCli {
  readonly version: string;
  readonly path: string;
}

/**
 * The cache folder's name inside the agent's state directory. Exported because
 * `auth.ts` must skip it when it scans `COPILOT_HOME` for plaintext credentials:
 * these are digest-verified binaries we downloaded, not text the CLI wrote.
 */
export const CLI_CACHE_DIRECTORY = 'cli';

const VERSION_DIRECTORY = /^\d+\.\d+\.\d+$/;

export function cachedCliPath(root: string, version: string, platform: NodeJS.Platform): string {
  return path.join(root, version, cliExecutableName(platform));
}

/** Downloaded CLIs, newest first. A folder without its binary is not usable. */
export function readCachedClis(root: string, platform: NodeJS.Platform): readonly CachedCli[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => VERSION_DIRECTORY.test(entry))
    .map((version) => ({ version, path: cachedCliPath(root, version, platform) }))
    .filter((cached) => existsSync(cached.path))
    .sort((left, right) => compareCliVersions(right.version, left.version));
}

/**
 * Writes the binary for `version` and returns its path. Written beside the
 * final name and renamed, so a crash mid-write can never leave a truncated
 * executable that looks installed.
 */
export function writeCachedCli(
  root: string,
  version: string,
  bytes: Uint8Array,
  platform: NodeJS.Platform,
): string {
  const target = cachedCliPath(root, version, platform);
  mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  writeFileSync(partial, bytes, { mode: 0o755 });
  rmSync(target, { force: true });
  renameSync(partial, target);
  return target;
}

/** Keeps `keepVersion` and removes every other downloaded version. */
export function pruneCachedClis(root: string, keepVersion: string): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === keepVersion) continue;
    rmSync(path.join(root, entry), { recursive: true, force: true });
  }
}
