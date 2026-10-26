import { z } from 'zod';
import type { AgentFetch } from '../../../shared';
import { CliDownloadError, downloadVerifiedCliFile, type CliArchiveDigest } from './download';

/**
 * GitHub's release channel for the Copilot CLI.
 *
 * The CLI is not redistributed - not by the application and not by this agent:
 * the resolver asks GitHub for
 * the latest release, picks this platform's asset and verifies it against the
 * digest the same API response published. That is the same shape as the app's
 * own update check (a manifest names an archive and its hash before it is
 * used), with GitHub as the manifest's publisher.
 *
 * Only an asset that ships a `sha256:` digest is eligible: an unverifiable
 * download is treated as missing, never as "trust it because it is HTTPS".
 */

export const COPILOT_CLI_RELEASE_URL =
  'https://api.github.com/repos/github/copilot-cli/releases/latest';

/** ~120 MB for a current release; generous, but a ceiling. */
export const MAX_CLI_ARCHIVE_BYTES = 400 * 1024 * 1024;

const MAX_RELEASE_JSON_BYTES = 512 * 1024;
const RELEASE_TIMEOUT_MS = 20_000;
const ARCHIVE_TIMEOUT_MS = 10 * 60_000;

const assetSchema = z.object({
  name: z.string().min(1).max(200),
  browser_download_url: z.string().url(),
  size: z.number().int().positive().max(MAX_CLI_ARCHIVE_BYTES),
  digest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/i)
    .optional(),
});

const releaseSchema = z.object({
  tag_name: z.string().regex(/^v?\d+\.\d+\.\d+$/),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  assets: z.array(assetSchema),
});

export interface CopilotCliAsset {
  readonly name: string;
  readonly url: URL;
  readonly size: number;
  /** Hex sha256, without the `sha256:` prefix. */
  readonly sha256: string;
}

export interface CopilotCliRelease {
  readonly version: string;
  readonly assets: readonly CopilotCliAsset[];
}

export type ReleaseFailure = 'refused' | 'network' | 'malformed';

export type ReleaseResult =
  | { readonly ok: true; readonly release: CopilotCliRelease }
  | { readonly ok: false; readonly reason: ReleaseFailure };

/** The release asset for one `<platform>-<arch>`, without a second API call. */
export function assetName(version: string, platformKey: string): string {
  return `github-copilot-${version}-${platformKey}.tgz`;
}

/**
 * Reads `releases/latest`. A prerelease or draft is accepted as-is: it is what
 * GitHub calls latest, and refusing it here would only make the resolver lie.
 */
export async function fetchLatestCliRelease(
  fetchFn: AgentFetch,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<ReleaseResult> {
  let response: Response;
  try {
    response = await fetchFn(COPILOT_CLI_RELEASE_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'etoolbox-daisy',
      },
      signal:
        options.signal === undefined
          ? AbortSignal.timeout(RELEASE_TIMEOUT_MS)
          : AbortSignal.any([options.signal, AbortSignal.timeout(RELEASE_TIMEOUT_MS)]),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (!response.ok || !response.url.startsWith('https:')) return { ok: false, reason: 'refused' };

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RELEASE_JSON_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'refused' };
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (text.length > MAX_RELEASE_JSON_BYTES) return { ok: false, reason: 'refused' };

  let parsed: z.infer<typeof releaseSchema>;
  try {
    const result = releaseSchema.safeParse(JSON.parse(text));
    if (!result.success) return { ok: false, reason: 'malformed' };
    parsed = result.data;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const assets: CopilotCliAsset[] = [];
  for (const asset of parsed.assets) {
    if (asset.digest === undefined) continue;
    let url: URL;
    try {
      url = new URL(asset.browser_download_url);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:') continue;
    assets.push({
      name: asset.name,
      url,
      size: asset.size,
      sha256: asset.digest.slice('sha256:'.length).toLowerCase(),
    });
  }
  return {
    ok: true,
    release: { version: parsed.tag_name.replace(/^v/, ''), assets },
  };
}

/** Downloads and verifies the asset; never returns unverified bytes. */
export async function downloadCliAsset(
  fetchFn: AgentFetch,
  asset: CopilotCliAsset,
  options: {
    readonly onProgress?: (fraction: number) => void;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<Uint8Array> {
  const expectation: CliArchiveDigest = { sha256: asset.sha256, size: asset.size };
  try {
    return await downloadVerifiedCliFile(fetchFn, asset.url, expectation, {
      timeoutMs: ARCHIVE_TIMEOUT_MS,
      maxBytes: MAX_CLI_ARCHIVE_BYTES,
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (error instanceof CliDownloadError) throw error;
    throw new CliDownloadError('network');
  }
}
