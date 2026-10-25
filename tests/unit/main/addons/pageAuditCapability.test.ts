import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PageAuditRequest, PageAuditRunner } from '../../../../src/shared';
import {
  createPageAuditCapability,
  type PageAuditAddonRuntimeDeps,
} from '../../../../src/main/addons';
import type { AddonManager } from '../../../../src/main/addons';
import type { InstalledAddon } from '../../../../src/main/addons/store';

/**
 * The lazy page-audit capability. It must not touch the add-on until an audit is
 * requested, must write the download's progress onto the calling tool's line,
 * and must turn every failure into an audit outcome rather than an exception
 * (the tool maps an outcome; an exception would fail the turn).
 */

const ADDON_DIR = path.join('C:', 'addons', 'page-audit', '1.0.0');

const REQUEST: PageAuditRequest = { url: undefined, categories: ['seo'], formFactor: 'mobile' };

function installed(): InstalledAddon {
  return {
    dir: ADDON_DIR,
    descriptor: {
      id: 'page-audit',
      version: '1.0.0',
      kind: 'js',
      apiVersion: 1,
      entry: 'index.js',
    },
  };
}

function deps(): PageAuditAddonRuntimeDeps {
  return {
    paneSession: {} as never,
    anonymousSession: () => ({}) as never,
    createWindow: () => ({}) as never,
    currentUrl: () => undefined,
    isConfiguredOrigin: () => false,
    inspectTarget: () => Promise.resolve({ allowed: true }),
    logger: { warn: vi.fn() },
  };
}

function manager(ensure: AddonManager['ensure']): AddonManager {
  return {
    ensure,
    resolveFile: () => Promise.resolve({ ok: false, error: { reason: 'kind', message: 'n/a' } }),
  };
}

describe('createPageAuditCapability', () => {
  it('loads the add-on on the first audit and writes its download progress', async () => {
    const ensure = vi.fn<AddonManager['ensure']>((_id, options) => {
      options?.onProgress?.(0.34);
      options?.onProgress?.(1);
      return Promise.resolve({ ok: true, value: installed() });
    });
    const audit = vi.fn<PageAuditRunner>(() => Promise.resolve({ kind: 'no_page' }));
    const createPageAuditRunner = vi.fn(() => audit);
    const importModule = vi.fn(() => Promise.resolve({ createPageAuditRunner }));
    const runtimeDeps = deps();
    const run = createPageAuditCapability({
      manager: manager(ensure),
      createDeps: () => runtimeDeps,
      importModule,
    });
    const stages: string[] = [];

    const outcome = await run(REQUEST, undefined, (stage) => stages.push(stage));

    expect(outcome).toEqual({ kind: 'no_page' });
    expect(stages).toEqual([
      'Downloading page audit add-on 34%',
      'Downloading page audit add-on 100%',
    ]);
    expect(importModule).toHaveBeenCalledWith(pathToFileURL(path.join(ADDON_DIR, 'index.js')).href);
    expect(createPageAuditRunner).toHaveBeenCalledWith(runtimeDeps);
    expect(audit).toHaveBeenCalledWith(REQUEST, undefined, expect.any(Function));
  });

  it('imports and installs once, reusing the runner afterwards', async () => {
    const ensure = vi.fn<AddonManager['ensure']>(() =>
      Promise.resolve({ ok: true, value: installed() }),
    );
    const audit = vi.fn<PageAuditRunner>(() => Promise.resolve({ kind: 'no_page' }));
    const importModule = vi.fn(() => Promise.resolve({ createPageAuditRunner: () => audit }));
    const run = createPageAuditCapability({
      manager: manager(ensure),
      createDeps: deps,
      importModule,
    });

    await run(REQUEST, undefined);
    await run(REQUEST, undefined);

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it('reports an unavailable add-on as an audit outcome and retries on the next call', async () => {
    const ensure = vi
      .fn<AddonManager['ensure']>()
      .mockResolvedValueOnce({
        ok: false,
        error: { reason: 'hash', message: 'The download did not match' },
      })
      .mockResolvedValueOnce({ ok: true, value: installed() });
    const audit = vi.fn<PageAuditRunner>(() => Promise.resolve({ kind: 'no_page' }));
    const run = createPageAuditCapability({
      manager: manager(ensure),
      createDeps: deps,
      importModule: () => Promise.resolve({ createPageAuditRunner: () => audit }),
    });

    expect(await run(REQUEST, undefined)).toEqual({
      kind: 'unavailable',
      message: 'The download did not match',
    });
    expect(await run(REQUEST, undefined)).toEqual({ kind: 'no_page' });
  });

  it('turns a cancelled download into a cancelled audit', async () => {
    const ensure = vi.fn<AddonManager['ensure']>().mockResolvedValue({
      ok: false,
      error: { reason: 'cancelled', message: 'The download was cancelled' },
    });
    const run = createPageAuditCapability({
      manager: manager(ensure),
      createDeps: deps,
      importModule: vi.fn(),
    });

    expect(await run(REQUEST, undefined)).toEqual({ kind: 'cancelled' });
  });

  it('reports a module without the factory as unavailable, never throwing', async () => {
    const run = createPageAuditCapability({
      manager: manager(() => Promise.resolve({ ok: true, value: installed() })),
      createDeps: deps,
      importModule: () => Promise.resolve({}),
    });

    const outcome = await run(REQUEST, undefined);

    expect(outcome).toMatchObject({ kind: 'unavailable' });
  });

  it('reports a failing import as unavailable, never throwing', async () => {
    const run = createPageAuditCapability({
      manager: manager(() => Promise.resolve({ ok: true, value: installed() })),
      createDeps: deps,
      importModule: () => Promise.reject(new Error('cannot load')),
    });

    expect(await run(REQUEST, undefined)).toEqual({ kind: 'unavailable', message: 'cannot load' });
  });
});
