import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentFetch, UpdateStatus } from '../../../../src/shared';
import { createUpdater, type UpdaterDependencies } from '../../../../src/main/updates/updater';
import { createScratchDirs } from '../../../support/scratchDirs';

const scratch = createScratchDirs('updater', 'upd-');
afterEach(() => scratch.cleanup());

const ARCHIVE = Buffer.from('new-app-archive');
const sha512 = (bytes: Buffer): string => createHash('sha512').update(bytes).digest('hex');

function manifestFor(version: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version,
    notes: 'fixes',
    files: {
      'win32-x64': {
        name: 'app.asar',
        sha512: sha512(ARCHIVE),
        size: ARCHIVE.length,
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
    runtimeGeneration: 1,
    platformKey: 'win32-x64',
    builtinUrls: ['https://example.com/builtin'],
    customUrl: () => undefined,
    createFetch: () => Promise.resolve(fetchFn),
    targetAsar: undefined,
    install: () => ({ restart: true }),
    quit: vi.fn(),
    logger: { error: vi.fn(), warn: vi.fn() },
    onStatusChanged: (status) => statuses.push(status),
    ...overrides,
  };
  return { updater: createUpdater(deps), statuses, deps };
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
    expect((await harness(fetchFn).updater.check()).kind).toBe('failed');
  });

  it('asks for an installer when the archive needs a newer runtime', async () => {
    const fetchFn = serve({
      'https://example.com/builtin/update.json': () =>
        reply(manifestFor('2.0.0', { minInstalled: 2 })),
    });
    expect(await harness(fetchFn).updater.check()).toEqual({
      kind: 'installerRequired',
      version: '2.0.0',
    });
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
