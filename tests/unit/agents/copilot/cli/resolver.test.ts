import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentFetch } from '../../../../../src/shared';
import { COPILOT_CLI_RELEASE_URL, assetName } from '../../../../../src/agents/copilot/cli/release';
import { createCopilotCliResolver } from '../../../../../src/agents/copilot/cli/resolver';
import { createScratchDirs } from '../../../../support/scratchDirs';
import { tarGz } from '../../../../support/tarGz';

/**
 * The ladder: use what is on the machine, then our own verified cache, then the
 * latest release - never an old CLI, never an unverified download, and never a
 * second download once one candidate worked.
 */

const scratch = createScratchDirs('main-copilot-cli', 'resolver-');

afterEach(() => scratch.cleanup());

const PLATFORM = 'win32';
const PLATFORM_KEY = 'win32-x64';
const MINIMUM = '1.0.83';

const TARBALL = tarGz({ 'package/copilot.exe': 'the binary' });
const SHA256 = createHash('sha256').update(TARBALL).digest('hex');
const ASSET_URL = 'https://github.com/github/copilot-cli/releases/download/v1.0.103/x.tgz';

function response(body: string | Uint8Array, url: string): Response {
  const result =
    typeof body === 'string' ? new Response(body) : new Response(new Blob([body as BlobPart]));
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

/** Serves the release API and its single asset; `undefined` means no network. */
function releaseFetch(
  version = '1.0.103',
  options: { readonly withAsset?: boolean } = {},
): AgentFetch {
  const json = JSON.stringify({
    tag_name: `v${version}`,
    assets:
      options.withAsset === false
        ? []
        : [
            {
              name: assetName(version, PLATFORM_KEY),
              browser_download_url: ASSET_URL,
              size: TARBALL.byteLength,
              digest: `sha256:${SHA256}`,
            },
          ],
  });
  return (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(
      url === COPILOT_CLI_RELEASE_URL ? response(json, url) : response(TARBALL, url),
    );
  };
}

interface HarnessOptions {
  readonly discovered?: readonly string[];
  readonly versions?: Readonly<Record<string, string | undefined>>;
  /** Versions seeded into the application's own cache. */
  readonly cached?: readonly string[];
  readonly fetch?: AgentFetch | undefined;
  readonly minimumVersion?: string;
}

function harness(options: HarnessOptions = {}) {
  const cacheRoot = path.join(scratch.create(), 'copilot-cli');
  mkdirSync(cacheRoot, { recursive: true });
  for (const version of options.cached ?? []) {
    mkdirSync(path.join(cacheRoot, version), { recursive: true });
    writeFileSync(path.join(cacheRoot, version, 'copilot.exe'), 'cached binary');
  }

  const probe = vi.fn((candidate: string) =>
    Promise.resolve(options.versions?.[candidate] ?? undefined),
  );
  let fetchFn = options.fetch;
  const resolver = createCopilotCliResolver({
    cacheRoot,
    platform: PLATFORM,
    platformKey: PLATFORM_KEY,
    minimumVersion: options.minimumVersion ?? MINIMUM,
    discover: () => (options.discovered ?? []).map((p) => ({ path: p, origin: 'path' as const })),
    probe,
    fetch: () => Promise.resolve(fetchFn),
  });
  return {
    resolver,
    probe,
    cacheRoot,
    setFetch: (next: AgentFetch | undefined): void => {
      fetchFn = next;
    },
  };
}

describe('CopilotCliResolver', () => {
  it('uses the newest CLI already installed, not the first one found', async () => {
    const { resolver, probe } = harness({
      discovered: ['C:\\old\\copilot.exe', 'C:\\new\\copilot.exe'],
      versions: { 'C:\\old\\copilot.exe': '1.0.83', 'C:\\new\\copilot.exe': '1.0.103' },
    });

    await expect(resolver.resolve()).resolves.toEqual({
      ok: true,
      value: { path: 'C:\\new\\copilot.exe', version: '1.0.103', source: 'local' },
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('prefers its own verified download over a local copy of the same version', async () => {
    const { resolver, cacheRoot } = harness({
      discovered: ['C:\\local\\copilot.exe'],
      versions: { 'C:\\local\\copilot.exe': '1.0.83' },
      cached: ['1.0.83'],
    });

    await expect(resolver.resolve()).resolves.toEqual({
      ok: true,
      value: {
        path: path.join(cacheRoot, '1.0.83', 'copilot.exe'),
        version: '1.0.83',
        source: 'cache',
      },
    });
  });

  it('skips a CLI below the supported floor and downloads the latest instead', async () => {
    const { resolver, cacheRoot } = harness({
      discovered: ['C:\\ancient\\copilot.exe'],
      versions: { 'C:\\ancient\\copilot.exe': '1.0.20' },
      fetch: releaseFetch(),
    });

    const resolved = await resolver.resolve();

    expect(resolved).toEqual({
      ok: true,
      value: {
        path: path.join(cacheRoot, '1.0.103', 'copilot.exe'),
        version: '1.0.103',
        source: 'download',
      },
    });
    expect(existsSync(path.join(cacheRoot, '1.0.103', 'copilot.exe'))).toBe(true);
  });

  it('keeps only the version it just installed', async () => {
    const { resolver, cacheRoot } = harness({ cached: ['1.0.20'], fetch: releaseFetch() });

    await resolver.resolve();

    expect(existsSync(path.join(cacheRoot, '1.0.20'))).toBe(false);
    expect(existsSync(path.join(cacheRoot, '1.0.103'))).toBe(true);
  });

  it('reports download progress', async () => {
    const { resolver } = harness({ fetch: releaseFetch() });
    const fractions: number[] = [];

    await resolver.resolve({ onProgress: (fraction) => fractions.push(fraction) });

    expect(fractions.at(-1)).toBe(1);
  });

  it('does not probe or download again once it has resolved', async () => {
    const { resolver, probe } = harness({
      discovered: ['C:\\local\\copilot.exe'],
      versions: { 'C:\\local\\copilot.exe': '1.0.103' },
    });

    await resolver.resolve();
    await resolver.resolve();

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('retries a failed resolution on the next attempt', async () => {
    const { resolver, setFetch } = harness({});
    await expect(resolver.resolve()).resolves.toMatchObject({ ok: false });

    setFetch(releaseFetch());

    await expect(resolver.resolve()).resolves.toMatchObject({
      ok: true,
      value: { version: '1.0.103', source: 'download' },
    });
  });

  it('answers a typed failure, with a way out, when there is nothing and no network', async () => {
    const { resolver } = harness({});

    const resolved = await resolver.resolve();

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.message).toContain('token');
  });

  it('refuses a release that has no asset for this platform', async () => {
    const { resolver } = harness({ fetch: releaseFetch('1.0.103', { withAsset: false }) });

    await expect(resolver.resolve()).resolves.toMatchObject({ ok: false });
  });

  it('stops when the caller cancels', async () => {
    const { resolver, probe } = harness({
      discovered: ['C:\\local\\copilot.exe'],
      versions: { 'C:\\local\\copilot.exe': '1.0.103' },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(resolver.resolve({ signal: controller.signal })).resolves.toMatchObject({
      ok: false,
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it('ignores a candidate that cannot name its version', async () => {
    const { resolver } = harness({
      discovered: ['C:\\broken\\copilot.exe'],
      versions: { 'C:\\broken\\copilot.exe': undefined },
      cached: ['1.0.90'],
    });
    await expect(resolver.resolve()).resolves.toMatchObject({
      ok: true,
      value: { source: 'cache', version: '1.0.90' },
    });
  });
});
