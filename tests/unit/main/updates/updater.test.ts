import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentFetch, UpdateStatus } from '../../../../src/shared';
import type { Logger } from '../../../../src/main/logger';
import type { RuntimeDescriptor } from '../../../../src/main/updates/runtime';
import { RUNTIME_DESCRIPTOR_FORMAT } from '../../../../src/main/updates/runtime';
import { createUpdater, type UpdaterDependencies } from '../../../../src/main/updates/updater';
import { createScratchDirs } from '../../../support/scratchDirs';

const scratch = createScratchDirs('updater', 'upd-');
afterEach(() => scratch.cleanup());

const ARCHIVE = Buffer.from('new-app-archive');
const sha512 = (bytes: Buffer): string => createHash('sha512').update(bytes).digest('hex');

/** The runtime layer this install is on; a manifest names it to be swappable. */
const INSTALLED_RUNTIME: RuntimeDescriptor = {
  format: RUNTIME_DESCRIPTOR_FORMAT,
  electron: '44.9.3',
  payload: 'a'.repeat(32),
};

function runtime(overrides: Partial<RuntimeDescriptor> = {}): unknown {
  return { ...INSTALLED_RUNTIME, ...overrides };
}

function manifestFor(version: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version,
    notes: 'fixes',
    files: {
      'win32-x64': {
        name: 'app.asar',
        sha512: sha512(ARCHIVE),
        size: ARCHIVE.length,
        // The runtime this install is on, so the archive is swappable by
        // default; `{ runtime: undefined }` drops the key entirely.
        runtime: runtime(),
        ...overrides,
      },
    },
  });
}

function reply(payload: string | Buffer, init: { ok?: boolean; url?: string } = {}): Response {
  const body = typeof payload === 'string' ? payload : new Uint8Array(payload);
  const response = new Response(body, { status: init.ok === false ? 404 : 200 });
  Object.defineProperty(response, 'url', { value: init.url ?? 'https://example.com/x' });
  return response;
}

/** Serves `routes` by URL; any other URL is unreachable. */
function serve(routes: Record<string, () => Response>): AgentFetch & { calls: string[] } {
  const calls: string[] = [];
  const fetchFn = vi.fn((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const route = routes[url];
    return route === undefined
      ? Promise.reject(new Error('unreachable'))
      : Promise.resolve(route());
  });
  return Object.assign(fetchFn, { calls });
}

function harness(
  fetchFn: AgentFetch,
  overrides: Partial<UpdaterDependencies> = {},
): {
  updater: ReturnType<typeof createUpdater>;
  statuses: UpdateStatus[];
  deps: UpdaterDependencies;
} {
  const statuses: UpdateStatus[] = [];
  const deps: UpdaterDependencies = {
    installedVersion: '1.0.0',
    readInstalledRuntime: () => Promise.resolve(INSTALLED_RUNTIME),
    platformKey: 'win32-x64',
    builtinUrls: ['https://example.com/builtin'],
    customUrl: () => undefined,
    createFetch: () => Promise.resolve(fetchFn),
    usesProxy: () => false,
    targetAsar: undefined,
    install: () => ({ restart: true }),
    quit: vi.fn(),
    logger: { error: vi.fn(), warn: vi.fn() },
    onStatusChanged: (status) => statuses.push(status),
    ...overrides,
  };
  return { updater: createUpdater(deps), statuses, deps };
}

/** The `UPDATE_CHECK_FAILED` warnings a check logged, in order. */
function loggedWarnings(deps: UpdaterDependencies): Array<Parameters<Logger['warn']>> {
  return vi.mocked(deps.logger.warn).mock.calls.filter(([code]) => code === 'UPDATE_CHECK_FAILED');
}

describe('updater check', () => {
  it('reports a newer version with its notes', async () => {
    const fetchFn = serve({
      'https://example.com/builtin/update.json': () => reply(manifestFor('1.1.0')),
    });
    const { updater } = harness(fetchFn);
    expect(await updater.check()).toEqual({ kind: 'available', version: '1.1.0', notes: 'fixes' });
  });

  it('is up to date when the manifest is not newer', async () => {
    const fetchFn = serve({
      'https://example.com/builtin/update.json': () => reply(manifestFor('1.0.0')),
    });
    expect((await harness(fetchFn).updater.check()).kind).toBe('upToDate');
  });

  it('checks the custom folder before the built-in ones and stops at the first newer', async () => {
    const fetchFn = serve({
      'https://custom.example.com/dist/update.json': () => reply(manifestFor('2.0.0')),
      'https://example.com/builtin/update.json': () => reply(manifestFor('3.0.0')),
    });
    const { updater } = harness(fetchFn, { customUrl: () => 'https://custom.example.com/dist' });
    expect(await updater.check()).toMatchObject({ kind: 'available', version: '2.0.0' });
    expect(fetchFn.calls).toEqual(['https://custom.example.com/dist/update.json']);
  });

  it('skips an unreachable or malformed source and uses the next', async () => {
    const fetchFn = serve({
      'https://custom.example.com/update.json': () => reply('not json'),
      'https://example.com/builtin/update.json': () => reply(manifestFor('1.5.0')),
    });
    const { updater } = harness(fetchFn, { customUrl: () => 'https://custom.example.com/' });
    expect(await updater.check()).toMatchObject({ kind: 'available', version: '1.5.0' });
  });

  it('skips a source that has nothing for this platform', async () => {
    const fetchFn = serve({
      'https://custom.example.com/update.json': () =>
        reply(JSON.stringify({ version: '9.0.0', files: {} })),
      'https://example.com/builtin/update.json': () => reply(manifestFor('1.1.0')),
    });
    const { updater } = harness(fetchFn, { customUrl: () => 'https://custom.example.com/' });
    expect(await updater.check()).toMatchObject({ version: '1.1.0' });
  });

  it('fails the check, quietly logged, when no source is reachable', async () => {
    const { updater, deps } = harness(serve({}));
    expect(await updater.check()).toEqual({ kind: 'failed', phase: 'check' });
    expect(deps.logger.warn).toHaveBeenCalledWith('UPDATE_CHECK_FAILED', expect.anything());
  });

  it('refuses a response that was redirected off https', async () => {
    const fetchFn = serve({
      'https://example.com/builtin/update.json': () =>
        reply(manifestFor('2.0.0'), { url: 'http://example.com/update.json' }),
    });
    const { updater, deps } = harness(fetchFn);
    expect((await updater.check()).kind).toBe('failed');
    expect(loggedWarnings(deps)[0]?.[1]).toMatchObject({ reason: 'insecure' });
  });

  it('refuses an archive that does not say which runtime layer it needs', async () => {
    const fetchFn = serve({
      'https://example.com/builtin/update.json': () =>
        reply(manifestFor('2.0.0', { runtime: undefined })),
    });
    expect(await harness(fetchFn).updater.check()).toEqual({
      kind: 'installerRequired',
      version: '2.0.0',
    });
  });

  it('says which part of the runtime layer blocked the update', async () => {
    const cases: ReadonlyArray<[Partial<RuntimeDescriptor>, string]> = [
      [{ payload: 'b'.repeat(32) }, 'payload'],
      [{ electron: '45.0.0' }, 'electron'],
    ];
    for (const [moved, expected] of cases) {
      const fetchFn = serve({
        'https://example.com/builtin/update.json': () =>
          reply(manifestFor('2.0.0', { runtime: runtime(moved) })),
      });
      expect(await harness(fetchFn).updater.check()).toEqual({
        kind: 'installerRequired',
        version: '2.0.0',
        changed: [expected],
      });
    }
  });

  it('refuses an archive whose runtime cannot be compared with this install', async () => {
    const fetchFn = serve({
      'https://example.com/builtin/update.json': () =>
        reply(manifestFor('2.0.0', { runtime: runtime() })),
    });
    const unreadable = () => Promise.resolve(undefined);
    expect(await harness(fetchFn, { readInstalledRuntime: unreadable }).updater.check()).toEqual({
      kind: 'installerRequired',
      version: '2.0.0',
    });

    const throws = () => Promise.reject(new Error('permission denied'));
    expect((await harness(fetchFn, { readInstalledRuntime: throws }).updater.check()).kind).toBe(
      'installerRequired',
    );
  });

  it('reads the installed runtime at most once per check', async () => {
    const fetchFn = serve({
      'https://custom.example.com/update.json': () =>
        reply(JSON.stringify({ version: '9.0.0', files: {} })),
      'https://example.com/builtin/update.json': () =>
        reply(manifestFor('2.0.0', { runtime: runtime() })),
    });
    const readInstalledRuntime = vi.fn(() => Promise.resolve(INSTALLED_RUNTIME));
    await harness(fetchFn, {
      customUrl: () => 'https://custom.example.com/',
      readInstalledRuntime,
    }).updater.check();
    expect(readInstalledRuntime).toHaveBeenCalledTimes(1);
  });

  it('ignores non-https sources', async () => {
    const fetchFn = serve({});
    const { updater } = harness(fetchFn, { builtinUrls: ['http://example.com/x'] });
    await updater.check();
    expect(fetchFn.calls).toEqual([]);
  });

  it('runs one check at a time', async () => {
    const fetchFn = serve({
      'https://example.com/builtin/update.json': () => reply(manifestFor('1.1.0')),
    });
    const { updater } = harness(fetchFn);
    await Promise.all([updater.check(), updater.check()]);
    expect(fetchFn.calls).toHaveLength(1);
  });
});

describe('updater check diagnostics', () => {
  it('logs nothing for a source it read successfully', async () => {
    const fetchFn = serve({
      'https://example.com/builtin/update.json': () => reply(manifestFor('1.0.0')),
    });
    const { updater, deps } = harness(fetchFn);
    await updater.check();
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it('says which source failed, why, and over which route', async () => {
    const fetchFn = serve({
      'https://example.com/builtin/update.json': () => reply('missing', { ok: false }),
    });
    const { updater, deps } = harness(fetchFn, { usesProxy: () => true });
    await updater.check();
    const warnings = loggedWarnings(deps);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.[1]).toMatchObject({
      outcome: 'failure',
      reason: 'http-status',
      statusCode: 404,
      proxied: true,
      url: { origin: 'https://example.com', path: '/builtin/update.json' },
    });
    expect(warnings[0]?.[1]?.durationMs).toBeTypeOf('number');
  });

  it('records a transport failure, and whether a proxy carried it', async () => {
    const { updater, deps } = harness(serve({}), { usesProxy: () => true });
    await updater.check();
    expect(loggedWarnings(deps)[0]?.[1]).toMatchObject({
      outcome: 'failure',
      reason: 'network',
      proxied: true,
    });
  });

  it('records a request that ran out of time', async () => {
    const fetchFn = serve({
      'https://example.com/builtin/update.json': () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    });
    const { updater, deps } = harness(fetchFn);
    await updater.check();
    expect(loggedWarnings(deps)[0]?.[1]).toMatchObject({ reason: 'timeout' });
  });

  it.each([
    ['not JSON at all', 'not json'],
    ['a manifest this build cannot read', JSON.stringify({ version: 'newest', files: {} })],
  ])('treats %s as a malformed manifest, not an unreachable source', async (_label, body) => {
    const fetchFn = serve({ 'https://example.com/builtin/update.json': () => reply(body) });
    const { updater, deps } = harness(fetchFn);
    await updater.check();
    expect(loggedWarnings(deps)[0]?.[1]).toMatchObject({ reason: 'invalid-manifest' });
  });

  it('records a source whose body is above the cap', async () => {
    const oversized = JSON.stringify({ version: '1.1.0', files: {}, pad: 'x'.repeat(70_000) });
    const fetchFn = serve({ 'https://example.com/builtin/update.json': () => reply(oversized) });
    const { updater, deps } = harness(fetchFn);
    await updater.check();
    expect(loggedWarnings(deps)[0]?.[1]).toMatchObject({ reason: 'too-large' });
  });

  it('distinguishes "no source configured" from "every source failed"', async () => {
    const { updater, deps } = harness(serve({}), { builtinUrls: [], customUrl: () => undefined });
    await updater.check();
    const warnings = loggedWarnings(deps);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[1]).toMatchObject({ outcome: 'failure', count: 0 });
  });
});

describe('updater apply', () => {
  function available(targetAsar: string, archive: Buffer = ARCHIVE) {
    const fetchFn = serve({
      'https://example.com/builtin/update.json': () => reply(manifestFor('1.1.0')),
      'https://example.com/builtin/app.asar': () => reply(archive),
    });
    return { fetchFn, ...harness(fetchFn, { targetAsar }) };
  }

  it('does nothing unless an update is available', async () => {
    const { updater } = harness(serve({}));
    expect((await updater.apply()).kind).toBe('idle');
  });

  it('stages the verified archive, installs it and quits when asked to restart', async () => {
    const target = path.join(scratch.create(), 'app.asar');
    const staged: Buffer[] = [];
    const install = vi.fn((stagedAsar: string) => {
      staged.push(readFileSync(stagedAsar));
      return { restart: true };
    });
    const fetchFn = serve({
      'https://example.com/builtin/update.json': () => reply(manifestFor('1.1.0')),
      'https://example.com/builtin/app.asar': () => reply(ARCHIVE),
    });
    const quit = vi.fn();
    const { updater } = harness(fetchFn, { targetAsar: target, install, quit });
    await updater.check();
    await updater.apply();
    expect(install).toHaveBeenCalledWith(`${target}.new`);
    expect(staged).toEqual([ARCHIVE]);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('settles as up to date after an in-process install that does not restart', async () => {
    const target = path.join(scratch.create(), 'app.asar');
    const fetchFn = serve({
      'https://example.com/builtin/update.json': () => reply(manifestFor('1.1.0')),
      'https://example.com/builtin/app.asar': () => reply(ARCHIVE),
    });
    const quit = vi.fn();
    const { updater } = harness(fetchFn, {
      targetAsar: target,
      install: () => ({ restart: false }),
      quit,
    });
    await updater.check();
    expect((await updater.apply()).kind).toBe('upToDate');
    expect(quit).not.toHaveBeenCalled();
  });

  it('rejects an archive that fails the hash check and leaves nothing staged', async () => {
    const target = path.join(scratch.create(), 'app.asar');
    const tampered = Buffer.from('new-app-archivX');
    const { updater, deps } = available(target, tampered);
    await updater.check();
    expect(await updater.apply()).toEqual({ kind: 'failed', phase: 'apply' });
    expect(existsSync(`${target}.new`)).toBe(false);
    expect(deps.logger.error).toHaveBeenCalledWith('UPDATE_APPLY_FAILED', expect.anything());
  });

  it('removes the staged file when the install step throws', async () => {
    const target = path.join(scratch.create(), 'app.asar');
    const fetchFn = serve({
      'https://example.com/builtin/update.json': () => reply(manifestFor('1.1.0')),
      'https://example.com/builtin/app.asar': () => reply(ARCHIVE),
    });
    const quit = vi.fn();
    const { updater } = harness(fetchFn, {
      targetAsar: target,
      install: () => {
        throw new Error('boom');
      },
      quit,
    });
    await updater.check();
    expect((await updater.apply()).kind).toBe('failed');
    expect(existsSync(`${target}.new`)).toBe(false);
    expect(quit).not.toHaveBeenCalled();
  });

  it('fails when this process cannot be updated in place', async () => {
    const fetchFn = serve({
      'https://example.com/builtin/update.json': () => reply(manifestFor('1.1.0')),
    });
    const { updater } = harness(fetchFn);
    await updater.check();
    expect(await updater.apply()).toEqual({ kind: 'failed', phase: 'apply' });
  });
});
