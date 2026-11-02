import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as realDelay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type UpdaterDependencies, createUpdater } from '../../../../src/main/updates/updater';
import {
  DEFAULT_UPDATE_REF,
  UPDATE_REPOSITORIES,
  sourceArchiveUrl,
} from '../../../../src/main/updates/source';
import type { AgentFetch, UpdateStatus } from '../../../../src/shared';
import { createScratchDirs } from '../../../support/scratchDirs';

const scratch = createScratchDirs('updater', 'updater-');

const PRIMARY = UPDATE_REPOSITORIES[0];
const SECONDARY = UPDATE_REPOSITORIES[1];

function packageResponse(body: string, init: { status?: number; url?: string } = {}): Response {
  const response = new Response(body, { status: init.status ?? 200 });
  Object.defineProperty(response, 'url', {
    value: init.url ?? 'https://raw.githubusercontent.com/o/r/master/package.json',
  });
  return response;
}

/**
 * A string is that version, a number an HTTP status, an Error a transport
 * failure, and a function a raw response for an exotic body. A repository the
 * map does not name is unreachable - so a test states what each repository
 * answered instead of relying on call order.
 */
type Answer = string | number | Error | (() => Response | Error);

function repositoryOf(input: string | URL | Request): string {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const [, owner = '', name = ''] = new URL(href).pathname.split('/');
  return `${owner}/${name}`;
}

function fetchAnswers(answers: Record<string, Answer>): AgentFetch {
  return vi.fn((input: string | URL | Request): Promise<Response> => {
    const answer = answers[repositoryOf(input)];
    if (answer === undefined) return Promise.reject(new Error('unreachable'));
    if (answer instanceof Error) return Promise.reject(answer);
    if (typeof answer === 'string') {
      return Promise.resolve(packageResponse(JSON.stringify({ version: answer })));
    }
    if (typeof answer === 'number') {
      return Promise.resolve(packageResponse('', { status: answer }));
    }
    const produced = answer();
    return produced instanceof Error ? Promise.reject(produced) : Promise.resolve(produced);
  });
}

/** Both default repositories answer the same, which is the ordinary case. */
function fetchEverywhere(answer: Answer): AgentFetch {
  return fetchAnswers({ [PRIMARY]: answer, [SECONDARY]: answer });
}

interface Harness {
  readonly statusFile: string;
  readonly goFile: string;
  readonly statuses: UpdateStatus[];
  readonly launch: ReturnType<typeof vi.fn<(source: string) => Promise<void>>>;
  readonly quit: ReturnType<typeof vi.fn<() => void>>;
  readonly logger: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  readonly updater: ReturnType<typeof createUpdater>;
}

function build(overrides: Partial<UpdaterDependencies> = {}): Harness {
  const statusFile = path.join(scratch.create(), 'status.txt');
  const statuses: UpdateStatus[] = [];
  const launch = vi.fn<(source: string) => Promise<void>>(() => Promise.resolve());
  const quit = vi.fn<() => void>();
  const logger = { error: vi.fn(), warn: vi.fn() };
  const updater = createUpdater({
    installedVersion: '1.0.0',
    source: () => undefined,
    createFetch: () => Promise.resolve(fetchEverywhere('1.1.0')),
    usesProxy: () => false,
    statusFile,
    startedByUpdate: false,
    launch,
    quit,
    logger,
    onStatusChanged: (status) => statuses.push(status),
    ...overrides,
  });
  return { statusFile, goFile: `${statusFile}.go`, statuses, launch, quit, logger, updater };
}

/**
 * Real file reads do not follow fake timers, so each poll tick is followed by real
 * turns and a short real delay (the module's timers are not the faked globals).
 */
async function pollUntil(condition: () => boolean, ticks = 20, realMs = 5): Promise<void> {
  for (let tick = 0; tick < ticks && !condition(); tick += 1) {
    await vi.advanceTimersByTimeAsync(1000);
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (realMs > 0) await realDelay(realMs);
  }
  if (!condition()) throw new Error('pollUntil: the condition was never met');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  scratch.cleanup();
});

describe('check', () => {
  it('offers a newer version of the configured ref', async () => {
    const { updater } = build();
    expect(await updater.check()).toEqual({ kind: 'available', version: '1.1.0' });
  });

  it('offers the newest version of the two default repositories', async () => {
    const { updater } = build({
      createFetch: () =>
        Promise.resolve(fetchAnswers({ [PRIMARY]: '1.1.0', [SECONDARY]: '1.3.0' })),
    });
    expect(await updater.check()).toEqual({ kind: 'available', version: '1.3.0' });
  });

  it('keeps the other answer when one repository cannot be read', async () => {
    const { updater } = build({
      createFetch: () =>
        Promise.resolve(fetchAnswers({ [PRIMARY]: new Error('offline'), [SECONDARY]: '1.2.0' })),
    });
    expect(await updater.check()).toEqual({ kind: 'available', version: '1.2.0' });
  });

  it('fails only when neither repository answers, logging each failure', async () => {
    const { updater, logger } = build({
      createFetch: () =>
        Promise.resolve(fetchAnswers({ [PRIMARY]: new Error('offline'), [SECONDARY]: 404 })),
    });
    expect(await updater.check()).toEqual({ kind: 'failed', phase: 'check' });
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('checks exactly the repository the update source names', async () => {
    const fetcher = vi.fn<(input: string | URL | Request) => Promise<Response>>(() =>
      Promise.resolve(packageResponse('{"version":"2.0.0"}')),
    );
    const { updater } = build({
      source: () => `${SECONDARY}@release/2.0`,
      createFetch: () => Promise.resolve(fetcher),
    });
    expect(await updater.check()).toEqual({ kind: 'available', version: '2.0.0' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const called = fetcher.mock.calls[0]?.[0];
    if (!(called instanceof URL)) throw new Error('the check must read a URL');
    expect(called.pathname).toContain(`/${SECONDARY}/`);
  });

  it('reports up to date for the same version', async () => {
    const { updater } = build({ createFetch: () => Promise.resolve(fetchEverywhere('1.0.0')) });
    expect((await updater.check()).kind).toBe('upToDate');
  });

  it('offers the same version when the check is forced', async () => {
    const { updater } = build({ createFetch: () => Promise.resolve(fetchEverywhere('1.0.0')) });
    expect(await updater.check({ force: true })).toEqual({ kind: 'available', version: '1.0.0' });
  });

  it('offers an older version when the check is forced', async () => {
    const { updater } = build({ createFetch: () => Promise.resolve(fetchEverywhere('0.5.0')) });
    expect((await updater.check({ force: true })).kind).toBe('available');
  });

  it('still fails a forced check whose source cannot be read', async () => {
    const { updater } = build({
      createFetch: () => Promise.resolve(fetchEverywhere(new Error('offline'))),
    });
    expect(await updater.check({ force: true })).toEqual({ kind: 'failed', phase: 'check' });
  });

  it('applies an update that only a forced check offered', async () => {
    const { updater } = build({ createFetch: () => Promise.resolve(fetchEverywhere('1.0.0')) });
    await updater.check({ force: true });
    expect((await updater.apply()).kind).not.toBe('upToDate');
  });

  it('always offers an archive source without fetching anything', async () => {
    const createFetch = vi.fn(() => Promise.resolve(fetchAnswers({})));
    const { updater } = build({ source: () => 'https://example.com/a.zip', createFetch });
    expect((await updater.check()).kind).toBe('available');
    expect(createFetch).not.toHaveBeenCalled();
  });

  // noinspection HtmlRequiredLangAttribute
  it.each([
    ['an http error', () => packageResponse('', { status: 404 }), 'http-status'],
    [
      'an insecure final url',
      () => packageResponse('{"version":"2.0.0"}', { url: 'http://x.example/p.json' }),
      'insecure',
    ],
    ['an oversized body', () => packageResponse('x'.repeat(70 * 1024)), 'too-large'],
    ['a body that is not json', () => packageResponse('<html>'), 'invalid-manifest'],
    [
      'a version that is not semver',
      () => packageResponse('{"version":"latest"}'),
      'invalid-manifest',
    ],
    ['a transport failure', () => new Error('offline'), 'network'],
    ['a timeout', () => Object.assign(new Error('slow'), { name: 'TimeoutError' }), 'timeout'],
  ])('fails on %s and logs why', async (_label, make, reason) => {
    const { updater, logger } = build({
      createFetch: () =>
        Promise.resolve(
          fetchAnswers({ [PRIMARY]: make, [SECONDARY]: make } satisfies Record<string, Answer>),
        ),
      usesProxy: () => true,
    });
    expect(await updater.check()).toEqual({ kind: 'failed', phase: 'check' });
    expect(logger.warn).toHaveBeenCalledWith(
      'UPDATE_CHECK_FAILED',
      expect.objectContaining({ reason, proxied: true }),
    );
  });

  it('records the status code of an http failure', async () => {
    const { updater, logger } = build({ createFetch: () => Promise.resolve(fetchEverywhere(503)) });
    await updater.check();
    expect(logger.warn).toHaveBeenCalledWith(
      'UPDATE_CHECK_FAILED',
      expect.objectContaining({ statusCode: 503 }),
    );
  });

  it('shares one read between overlapping checks', async () => {
    const createFetch = vi.fn(() => Promise.resolve(fetchEverywhere('1.1.0')));
    const { updater } = build({ createFetch });
    await Promise.all([updater.check(), updater.check()]);
    expect(createFetch).toHaveBeenCalledTimes(1);
  });

  it('never throws when the fetch factory does', async () => {
    const { updater, logger } = build({
      createFetch: () => Promise.reject(new Error('secret store unreadable')),
    });
    expect(await updater.check()).toEqual({ kind: 'failed', phase: 'check' });
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('apply', () => {
  it('does nothing before an update was offered', async () => {
    const { updater, launch } = build();
    expect((await updater.apply()).kind).toBe('idle');
    expect(launch).not.toHaveBeenCalled();
  });

  it('launches the offered source and follows the script to its ready stage', async () => {
    const { updater, launch, quit, statusFile, goFile, statuses } = build({
      source: () => 'release/1.0',
    });
    await updater.check();
    await updater.apply();
    expect(launch).toHaveBeenCalledWith(sourceArchiveUrl(PRIMARY, 'release/1.0'));

    writeFileSync(statusFile, 'building|Building the app');
    await pollUntil(() => statuses.some((s) => s.kind === 'applying' && s.stage === 'building'));
    expect(statuses).toContainEqual({
      kind: 'applying',
      stage: 'building',
      text: 'Building the app',
    });
    expect(quit).not.toHaveBeenCalled();

    writeFileSync(statusFile, 'ready|Ready');
    await pollUntil(() => quit.mock.calls.length > 0);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(existsSync(goFile)).toBe(true);
  });

  it('builds the update from the repository that offered the newest version', async () => {
    const { updater, launch } = build({
      createFetch: () =>
        Promise.resolve(fetchAnswers({ [PRIMARY]: '1.1.0', [SECONDARY]: '2.0.0' })),
    });
    await updater.check();
    await updater.apply();
    expect(launch).toHaveBeenCalledWith(sourceArchiveUrl(SECONDARY, DEFAULT_UPDATE_REF));
  });

  it('builds from the first repository when both offer the same version', async () => {
    const { updater, launch } = build({
      createFetch: () => Promise.resolve(fetchEverywhere('2.0.0')),
    });
    await updater.check();
    await updater.apply();
    expect(launch).toHaveBeenCalledWith(sourceArchiveUrl(PRIMARY, DEFAULT_UPDATE_REF));
  });

  it('clears the previous run before launching', async () => {
    const { updater, statusFile, goFile, launch } = build();
    writeFileSync(statusFile, 'failed|old');
    writeFileSync(goFile, '');
    await updater.check();
    let leftovers = true;
    launch.mockImplementation(() => {
      leftovers = existsSync(statusFile) || existsSync(goFile);
      return Promise.resolve();
    });
    await updater.apply();
    expect(leftovers).toBe(false);
  });

  it('reports the reason when the script fails', async () => {
    const { updater, statusFile, statuses, quit } = build();
    await updater.check();
    await updater.apply();
    writeFileSync(statusFile, 'failed|build failed');
    await pollUntil(() => statuses.some((s) => s.kind === 'failed'));
    expect(statuses.at(-1)).toEqual({ kind: 'failed', phase: 'apply', reason: 'build failed' });
    expect(quit).not.toHaveBeenCalled();
  });

  it('fails when the script cannot be started', async () => {
    const { updater, launch, logger } = build();
    await updater.check();
    launch.mockRejectedValue(new Error('not an installed build'));
    expect(await updater.apply()).toEqual({
      kind: 'failed',
      phase: 'apply',
      reason: 'not an installed build',
    });
    expect(logger.error).toHaveBeenCalled();
  });

  it('gives up on a script that stops reporting', async () => {
    const { updater, statuses } = build();
    await updater.check();
    await updater.apply();
    await pollUntil(() => statuses.at(-1)?.kind === 'failed', 2000, 0);
    expect(statuses.at(-1)).toMatchObject({ kind: 'failed', phase: 'apply' });
  });

  it('needs a fresh check before another attempt after a failure', async () => {
    const { updater, launch } = build();
    await updater.check();
    launch.mockRejectedValueOnce(new Error('boom'));
    await updater.apply();
    expect((await updater.apply()).kind).toBe('failed');
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

describe('resumeAfterUpdate', () => {
  it('ignores a run that no update started', async () => {
    const { updater, statusFile, statuses } = build();
    writeFileSync(statusFile, 'swapped|Updated');
    await updater.resumeAfterUpdate();
    expect(statuses).toEqual([]);
  });

  it('answers a swap with the started line and reports the new version', async () => {
    const { updater, statusFile } = build({ startedByUpdate: true });
    writeFileSync(statusFile, 'swapped|Updated');
    await updater.resumeAfterUpdate();
    expect(updater.getStatus()).toEqual({ kind: 'updated', version: '1.0.0' });
    expect(readFileSync(statusFile, 'utf8')).toBe('started|1.0.0');
  });

  it.each(['reverted', 'failed'])(
    'reports a %s update as failed with its reason',
    async (stage) => {
      const { updater, statusFile } = build({ startedByUpdate: true });
      writeFileSync(statusFile, `${stage}|new version did not start`);
      await updater.resumeAfterUpdate();
      expect(updater.getStatus()).toEqual({
        kind: 'failed',
        phase: 'apply',
        reason: 'new version did not start',
      });
    },
  );

  it('stays quiet when the status file is missing', async () => {
    const { updater, statuses } = build({ startedByUpdate: true });
    await updater.resumeAfterUpdate();
    expect(statuses).toEqual([]);
  });
});
