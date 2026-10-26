import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AgentFetch } from '../../../../../src/shared';
import { CliDownloadError } from '../../../../../src/agents/copilot/cli/download';
import {
  COPILOT_CLI_RELEASE_URL,
  assetName,
  downloadCliAsset,
  fetchLatestCliRelease,
} from '../../../../../src/agents/copilot/cli/release';
import { tarGz } from '../../../../support/tarGz';

/**
 * The release rung of the resolver. What is proven here: the API answer is read
 * defensively, only an https asset carrying a digest is eligible, and the bytes
 * are checked before they are handed on.
 */

const TARBALL = tarGz({ 'package/copilot.exe': 'the binary' });
const SHA256 = createHash('sha256').update(TARBALL).digest('hex');
const ASSET_URL = 'https://github.com/github/copilot-cli/releases/download/v1.0.103/x.tgz';

function response(
  body: string | Uint8Array,
  options: { readonly url?: string; readonly status?: number } = {},
): Response {
  const result =
    typeof body === 'string'
      ? new Response(body, { status: options.status ?? 200 })
      : new Response(new Blob([body as BlobPart]), { status: options.status ?? 200 });
  Object.defineProperty(result, 'url', { value: options.url ?? 'https://api.github.com/x' });
  return result;
}

function releaseJson(
  overrides: { readonly digest?: string | undefined; readonly assets?: number } = {},
): string {
  const assets = Array.from({ length: overrides.assets ?? 1 }, (_unused, index) => ({
    name: index === 0 ? assetName('1.0.103', 'win32-x64') : `copilot-linux-x64.tar.gz`,
    browser_download_url: ASSET_URL,
    size: TARBALL.byteLength,
    ...(overrides.digest === undefined
      ? { digest: `sha256:${SHA256}` }
      : overrides.digest === ''
        ? {}
        : { digest: overrides.digest }),
  }));
  return JSON.stringify({ tag_name: 'v1.0.103', assets });
}

/** Routes the release API and the asset download to one fake `fetch`. */
function fakeFetch(
  json: string,
  asset: Uint8Array | Response = TARBALL,
  seen: string[] = [],
): AgentFetch {
  return (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    if (url === COPILOT_CLI_RELEASE_URL) return Promise.resolve(response(json));
    return Promise.resolve(asset instanceof Response ? asset : response(asset, { url: ASSET_URL }));
  };
}

describe('fetchLatestCliRelease', () => {
  it('reads the tag and the assets that can be verified', async () => {
    const result = await fetchLatestCliRelease(fakeFetch(releaseJson()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.release.version).toBe('1.0.103');
    expect(result.release.assets).toEqual([
      expect.objectContaining({ name: assetName('1.0.103', 'win32-x64'), sha256: SHA256 }),
    ]);
  });

  it('drops an asset that carries no digest', async () => {
    const result = await fetchLatestCliRelease(fakeFetch(releaseJson({ digest: '' })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.release.assets).toEqual([]);
  });

  it('reports a refused answer rather than a network error', async () => {
    const result = await fetchLatestCliRelease((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url === COPILOT_CLI_RELEASE_URL
        ? Promise.resolve(response('{}', { status: 404 }))
        : Promise.resolve(response('{}', { url }));
    });

    expect(result).toEqual({ ok: false, reason: 'refused' });
  });

  it('reports a malformed body', async () => {
    const result = await fetchLatestCliRelease(fakeFetch('not json'));

    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('downloadCliAsset', () => {
  const asset = {
    name: assetName('1.0.103', 'win32-x64'),
    url: new URL(ASSET_URL),
    size: TARBALL.byteLength,
    sha256: SHA256,
  };

  it('returns the bytes once the digest matches', async () => {
    const bytes = await downloadCliAsset(fakeFetch(releaseJson()), asset);

    expect(bytes.byteLength).toBe(TARBALL.byteLength);
  });

  it('refuses bytes that do not match the published digest', async () => {
    // Same length, different bytes: the size check cannot be what catches it.
    const tampered = Uint8Array.from(TARBALL);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;

    await expect(downloadCliAsset(fakeFetch(releaseJson(), tampered), asset)).rejects.toMatchObject(
      {
        reason: 'hash',
      },
    );
    await expect(
      downloadCliAsset(fakeFetch(releaseJson(), tampered), asset),
    ).rejects.toBeInstanceOf(CliDownloadError);
  });

  it('reports progress as the body arrives', async () => {
    const fractions: number[] = [];

    await downloadCliAsset(fakeFetch(releaseJson()), asset, {
      onProgress: (fraction) => fractions.push(fraction),
    });

    expect(fractions.at(-1)).toBe(1);
    expect(fractions.length).toBeGreaterThan(1);
  });
});
