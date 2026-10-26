import { type Result, err, ok } from '../../../shared';
import type { AgentFetch } from '../../../shared';
import { pruneCachedClis, readCachedClis, writeCachedCli } from './cache';
import { CliDownloadError } from './download';
import { cliExecutableName, type DiscoveredCli } from './discovery';
import type { CliProbe } from './probe';
import { assetName, downloadCliAsset, fetchLatestCliRelease } from './release';
import { readTarGzEntry } from './tar';
import { compareCliVersions, isSupportedCliVersion } from './version';

/**
 * How this agent obtains the Copilot CLI it signs in with.
 *
 * The CLI is not the application's to publish: GitHub ships it several times a
 * week and the binary updates itself once it runs. So the agent resolves one
 * per sign-in instead of pinning one:
 *
 * 1. a CLI already installed on this machine (known roots, then `PATH`),
 * 2. a CLI this agent downloaded earlier (its own cache, so the second sign-in
 *    is instant and works offline),
 * 3. the latest GitHub release for this platform, verified against the digest
 *    the release publishes,
 * 4. a typed failure, with the Settings token field as the way out.
 *
 * Within 1 and 2 the **newest** wins, so a fresh download is not defeated by a
 * stale npm install. None of them below {@link COPILOT_CLI_MINIMUM_VERSION} is
 * used: an old CLI can predate `login --web-flow` entirely.
 */

/**
 * The oldest CLI this build has been verified against - a supported minimum,
 * not a pin. Raise it only after a real sign-in succeeds with a newer one.
 */
export const COPILOT_CLI_MINIMUM_VERSION = '1.0.83';

export type CopilotCliSource = 'cache' | 'download' | 'local';

export interface ResolvedCopilotCli {
  readonly path: string;
  readonly version: string;
  readonly source: CopilotCliSource;
}

export interface CopilotCliFailure {
  readonly message: string;
}

export interface ResolveCopilotCliOptions {
  readonly onProgress?: (fraction: number) => void;
  readonly signal?: AbortSignal | undefined;
}

export interface CopilotCliResolver {
  /** The CLI to spawn, installing one only when nothing usable is present. */
  resolve(
    options?: ResolveCopilotCliOptions,
  ): Promise<Result<ResolvedCopilotCli, CopilotCliFailure>>;
}

export interface CopilotCliResolverOptions {
  /** This agent's own cache of downloaded builds (`<stateDirectory>/cli`). */
  readonly cacheRoot: string;
  readonly platform: NodeJS.Platform;
  /** `<platform>-<arch>`, the release asset suffix. */
  readonly platformKey: string;
  /** Injected so a test (and a future platform) can vary it. */
  readonly minimumVersion?: string;
  readonly discover: () => readonly DiscoveredCli[];
  readonly probe: CliProbe;
  /** The host's proxy-aware fetch; `undefined` means no transport is available. */
  readonly fetch: () => Promise<AgentFetch | undefined>;
}

const FAILURE_MESSAGES = {
  cancelled: 'The Copilot CLI download was cancelled',
  download: 'The Copilot CLI could not be downloaded',
  offline:
    'No Copilot CLI was found on this machine and none could be downloaded. ' +
    'You can paste a token instead, in Settings',
  unsupported: 'No usable Copilot CLI was found for this platform',
} as const;

type FailureReason = keyof typeof FAILURE_MESSAGES;

function failure(reason: FailureReason): CopilotCliFailure {
  return { message: FAILURE_MESSAGES[reason] };
}

interface Candidate {
  readonly path: string;
  readonly version: string;
  readonly source: CopilotCliSource;
}

/** Newest first; at the same version our own verified download wins. */
function byNewestThenOwn(left: Candidate, right: Candidate): number {
  const byVersion = compareCliVersions(right.version, left.version);
  if (byVersion !== 0) return byVersion;
  const rank = (source: CopilotCliSource): number => (source === 'cache' ? 0 : 1);
  return rank(left.source) - rank(right.source);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function createCopilotCliResolver(options: CopilotCliResolverOptions): CopilotCliResolver {
  const minimumVersion = options.minimumVersion ?? COPILOT_CLI_MINIMUM_VERSION;
  const executable = cliExecutableName(options.platform);
  let resolved: ResolvedCopilotCli | undefined;

  async function localCandidates(signal: AbortSignal | undefined): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    for (const discovered of options.discover()) {
      if (isAborted(signal)) break;
      const version = await options.probe(discovered.path, signal);
      if (version === undefined) continue;
      if (!isSupportedCliVersion(version, minimumVersion)) continue;
      candidates.push({ path: discovered.path, version, source: 'local' });
    }
    for (const cached of readCachedClis(options.cacheRoot, options.platform)) {
      if (!isSupportedCliVersion(cached.version, minimumVersion)) continue;
      candidates.push({ path: cached.path, version: cached.version, source: 'cache' });
    }
    return candidates.sort(byNewestThenOwn);
  }

  async function download(
    settings: ResolveCopilotCliOptions,
  ): Promise<Result<ResolvedCopilotCli, CopilotCliFailure>> {
    const fetchFn = await options.fetch();
    if (fetchFn === undefined) return err(failure('offline'));

    const latest = await fetchLatestCliRelease(fetchFn, { signal: settings.signal });
    if (!latest.ok) {
      // A rate limit, a 404 or an unreachable API is "nothing to download",
      // never "this platform is unsupported" - that answer must stay precise.
      return err(failure(latest.reason === 'malformed' ? 'download' : 'offline'));
    }
    const { version, assets } = latest.release;
    const wanted = assetName(version, options.platformKey);
    const asset = assets.find((candidate) => candidate.name === wanted);
    // A release without this platform's asset (or without its digest) is not
    // usable, and guessing a similarly named one would defeat verification.
    if (asset === undefined) return err(failure('unsupported'));

    let archive: Uint8Array;
    try {
      archive = await downloadCliAsset(fetchFn, asset, {
        ...(settings.onProgress === undefined ? {} : { onProgress: settings.onProgress }),
        ...(settings.signal === undefined ? {} : { signal: settings.signal }),
      });
    } catch (error) {
      if (
        isAborted(settings.signal) ||
        (error instanceof CliDownloadError && error.reason === 'cancelled')
      ) {
        return err(failure('cancelled'));
      }
      return err(failure('download'));
    }

    if (isAborted(settings.signal)) return err(failure('cancelled'));
    const binary = readTarGzEntry(archive, executable, asset.size);
    if (binary === undefined) return err(failure('download'));

    const path = writeCachedCli(options.cacheRoot, version, binary, options.platform);
    pruneCachedClis(options.cacheRoot, version);
    return ok({ path, version, source: 'download' });
  }

  async function resolve(
    settings: ResolveCopilotCliOptions = {},
  ): Promise<Result<ResolvedCopilotCli, CopilotCliFailure>> {
    if (resolved !== undefined) return ok(resolved);

    const candidates = await localCandidates(settings.signal);
    if (isAborted(settings.signal)) return err(failure('cancelled'));
    const best: Candidate | undefined = candidates[0];
    if (best !== undefined) {
      resolved = { path: best.path, version: best.version, source: best.source };
      return ok(resolved);
    }

    const downloaded = await download(settings);
    if (downloaded.ok) resolved = downloaded.value;
    return downloaded;
  }

  return { resolve };
}
