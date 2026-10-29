import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AddonHost,
  type AddonHiddenWindowOptions,
  type ContributedTool,
  type ToolHost,
  ADDON_API_VERSION,
  newChatId,
  newServerId,
  newToolCallId,
  newTurnId,
  ok,
} from '../../../../src/shared';
import type { AddonPins } from '../../../../src/shared/addons/pins';
import { createAddonLoader, type AddonHostHandle } from '../../../../src/main/addons';
import type { AddonManager } from '../../../../src/main/addons';
import { addonPartitionName, createAddonHost } from '../../../../src/main/addons';
import type { InstalledAddon } from '../../../../src/main/addons/store';
import { createContributedToolModules } from '../../../../src/main/tools/addonProxy';
import { createCountingIdGenerator } from '../../../support/testIds';

/**
 * The generic add-on machinery: the loader (ensure → import → apiVersion →
 * activate, once per add-on, success-only caching), the host (the safety-critical
 * window options it forces, the sessions it hands out, its cleanup) and the tool
 * proxy (progress, error mapping, raw argument forwarding, one executor per
 * add-on tool). None of these knows any add-on: the fixtures are neutral.
 */

const { createdWindows, fromPartition } = vi.hoisted(() => ({
  createdWindows: [] as {
    options: Record<string, unknown>;
    destroyed: boolean;
  }[],
  fromPartition: vi.fn((name: string) => ({ partition: name })),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {
    readonly record: { options: Record<string, unknown>; destroyed: boolean };
    readonly webContents = { id: 1 };
    constructor(options: Record<string, unknown>) {
      this.record = { options, destroyed: false };
      createdWindows.push(this.record);
    }
    once(): void {
      // The host listens for `closed`; the fake never fires it.
    }
    isDestroyed(): boolean {
      return this.record.destroyed;
    }
    destroy(): void {
      this.record.destroyed = true;
    }
  },
  session: { fromPartition },
}));

beforeEach(() => {
  createdWindows.length = 0;
  fromPartition.mockClear();
});

const ADDON_DIR = path.join('C:', 'addons', 'example-addon', '0123456789abcdef');
const ADDON_ID = 'example-addon';

function installed(entry = 'index.js', apiVersion = ADDON_API_VERSION): InstalledAddon {
  return {
    dir: ADDON_DIR,
    descriptor: { id: ADDON_ID, identity: '0123456789abcdef', apiVersion, entry },
  };
}

const TOOL: ContributedTool = {
  name: 'example_tool',
  descriptor: {
    name: 'example_tool',
    description: 'Does one example thing.',
    parameters: { type: 'object', properties: { target: { type: 'string' } } },
  },
  allowlistEntry: 'custom:example_tool',
  instructions: 'Use example_tool for the example.',
  billet: { rows: [{ label: 'Target', value: { path: 'target' } }] },
};

function pins(): AddonPins {
  return {
    [ADDON_ID]: {
      identity: '0123456789abcdef',
      apiVersion: ADDON_API_VERSION,
      contributions: { tools: [TOOL], skills: [] },
    },
  };
}

function manager(ensure: AddonManager['ensure']): AddonManager {
  return { ensure };
}

const NO_HOST: AddonHostHandle = {
  host: {} as AddonHost<never, never>,
  destroyWindows: () => undefined,
};

function loader(options: {
  readonly ensure?: AddonManager['ensure'];
  readonly importModule?: (specifier: string) => Promise<unknown>;
  readonly createHost?: () => AddonHostHandle;
}) {
  return createAddonLoader({
    manager: manager(options.ensure ?? (() => Promise.resolve({ ok: true, value: installed() }))),
    pins: pins(),
    createHost: options.createHost ?? (() => NO_HOST),
    ...(options.importModule === undefined ? {} : { importModule: options.importModule }),
  });
}

function activationWith(tools: Record<string, unknown>) {
  return { apiVersion: ADDON_API_VERSION, activate: () => ({ tools }) };
}

describe('createAddonLoader', () => {
  it('ensures, imports the entry, checks the apiVersion and activates once', async () => {
    const ensure = vi.fn<AddonManager['ensure']>((_id, options) => {
      options?.onProgress?.(0.34);
      options?.onProgress?.(1);
      return Promise.resolve({ ok: true, value: installed() });
    });
    const factory = vi.fn(() => () => Promise.resolve(ok({})));
    const activate = vi.fn(() => ({ tools: { example_tool: factory } }));
    const importModule = vi.fn(() =>
      Promise.resolve({ addon: { apiVersion: ADDON_API_VERSION, activate } }),
    );
    const load = loader({ ensure, importModule });
    const progress: number[] = [];

    const loaded = await load.load(ADDON_ID, { onProgress: (fraction) => progress.push(fraction) });

    expect(loaded.ok).toBe(true);
    expect(progress).toEqual([0.34, 1]);
    expect(importModule).toHaveBeenCalledWith(pathToFileURL(path.join(ADDON_DIR, 'index.js')).href);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(load.directoryOf(ADDON_ID)).toBe(ADDON_DIR);
  });

  it('is single-flight per add-on and caches only a success', async () => {
    const ensure = vi
      .fn<AddonManager['ensure']>()
      .mockImplementation(() => Promise.resolve({ ok: true, value: installed() }));
    const importModule = vi.fn(() =>
      Promise.resolve({
        addon: activationWith({ example_tool: () => () => Promise.resolve(ok({})) }),
      }),
    );
    const load = loader({ ensure, importModule });

    const both = await Promise.all([load.load(ADDON_ID), load.load(ADDON_ID)]);
    expect(both.every((result) => result.ok)).toBe(true);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(importModule).toHaveBeenCalledTimes(1);

    await load.load(ADDON_ID);
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure: the next call tries again', async () => {
    const ensure = vi
      .fn<AddonManager['ensure']>()
      .mockResolvedValueOnce({ ok: false, error: { reason: 'hash', message: 'bad checksum' } })
      .mockResolvedValueOnce({ ok: true, value: installed() });
    const load = loader({
      ensure,
      importModule: () =>
        Promise.resolve({
          addon: activationWith({ example_tool: () => () => Promise.resolve(ok({})) }),
        }),
    });

    const first = await load.load(ADDON_ID);
    expect(first).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect((first as { error: { message: string } }).error.message).toContain(ADDON_ID);

    expect(await load.load(ADDON_ID)).toMatchObject({ ok: true });
  });

  it('maps a cancelled download to `cancelled`', async () => {
    const load = loader({
      ensure: () =>
        Promise.resolve({ ok: false, error: { reason: 'cancelled', message: 'cancelled' } }),
      importModule: vi.fn(),
    });

    expect(await load.load(ADDON_ID)).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
  });

  it('refuses an add-on whose apiVersion is not this build’s', async () => {
    const load = loader({
      ensure: () => Promise.resolve({ ok: true, value: installed('index.js', 99) }),
      importModule: vi.fn(),
    });

    expect(await load.load(ADDON_ID)).toMatchObject({ ok: false, error: { kind: 'apiVersion' } });
  });

  it('refuses a module whose own apiVersion differs from the pins', async () => {
    const load = loader({
      importModule: () =>
        Promise.resolve({ addon: { apiVersion: 2, activate: () => ({ tools: {} }) } }),
    });

    expect(await load.load(ADDON_ID)).toMatchObject({ ok: false, error: { kind: 'apiVersion' } });
  });

  it('reports an unusable module as unavailable, never throwing', async () => {
    const missing = loader({ importModule: () => Promise.resolve({}) });
    expect(await missing.load(ADDON_ID)).toMatchObject({
      ok: false,
      error: { kind: 'unavailable' },
    });

    const failing = loader({ importModule: () => Promise.reject(new Error('cannot load')) });
    expect(await failing.load(ADDON_ID)).toMatchObject({
      ok: false,
      error: { kind: 'unavailable' },
    });
  });

  it('fails as unavailable when a pinned tool is missing from the activation', async () => {
    const load = loader({ importModule: () => Promise.resolve({ addon: activationWith({}) }) });

    const loaded = await load.load(ADDON_ID);

    expect(loaded).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect((loaded as { error: { message: string } }).error.message).toContain('example_tool');
  });

  it('fails as unavailable when the activation offers no tools at all', async () => {
    const load = loader({
      importModule: () =>
        Promise.resolve({
          addon: { apiVersion: ADDON_API_VERSION, activate: () => ({}) },
        }),
    });

    expect(await load.load(ADDON_ID)).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
  });

  it('fails as unavailable when activate throws', async () => {
    const load = loader({
      importModule: () =>
        Promise.resolve({
          addon: {
            apiVersion: ADDON_API_VERSION,
            activate: () => {
              throw new Error('nope');
            },
          },
        }),
    });

    expect(await load.load(ADDON_ID)).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
  });
});

describe('createAddonHost', () => {
  function makeHost() {
    const pane = { partition: 'persist:webview' } as never;
    const builder = createAddonHost(ADDON_ID, {
      paneSession: pane,
      currentUrl: () => 'https://a.example/',
      isConfiguredOrigin: (origin) => origin === 'https://a.example',
      logger: { warn: vi.fn() },
    });
    return { builder, pane };
  }

  it('forces the safety-critical window options, whatever the add-on asks for', () => {
    const { builder } = makeHost();
    const session = builder.host.sessions.pane();

    // The host option type carries none of these; a cast is the only way an
    // add-on could try, and the host still decides.
    builder.host.browser.createHiddenWindow({
      session,
      offscreen: true,
      backgroundThrottling: false,
      width: 640,
      height: 480,
      show: true,
      webPreferences: { sandbox: false },
    } as unknown as AddonHiddenWindowOptions<never>);

    expect(createdWindows[0]?.options).toMatchObject({
      show: false,
      width: 640,
      height: 480,
      webPreferences: {
        session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        offscreen: true,
        backgroundThrottling: false,
      },
    });
  });

  it('names an isolated session after its add-on', () => {
    const { builder } = makeHost();

    const isolated = builder.host.sessions.isolated('anonymous');

    expect(fromPartition).toHaveBeenCalledWith(`addon-${ADDON_ID}-anonymous`);
    expect(isolated).toMatchObject({ partition: `addon-${ADDON_ID}-anonymous` });
    expect(addonPartitionName(ADDON_ID, 'anonymous')).toBe(`addon-${ADDON_ID}-anonymous`);
  });

  it('refuses a session it did not hand out', () => {
    const { builder } = makeHost();

    expect(() => builder.host.browser.createHiddenWindow({ session: {} as never })).toThrow(
      /did not hand out/,
    );
  });

  it('destroys the windows it created that are still open', () => {
    const { builder } = makeHost();
    builder.host.browser.createHiddenWindow({ session: builder.host.sessions.pane() });

    builder.destroyWindows();

    expect(createdWindows[0]?.destroyed).toBe(true);
  });

  it('answers the address policy and the configured hosts', async () => {
    const { builder } = makeHost();

    expect(builder.host.hosts.isConfiguredOrigin('https://a.example')).toBe(true);
    expect(builder.host.hosts.isConfiguredOrigin('https://b.example')).toBe(false);
    expect(builder.host.pane.currentUrl()).toBe('https://a.example/');
    expect(await builder.host.network.inspectTarget('not a url')).toEqual({ allowed: false });
    expect(await builder.host.network.inspectTarget('http://127.0.0.1/x')).toEqual({
      allowed: false,
    });
  });

  it('logs a generic runtime failure carrying its own id', () => {
    const warn = vi.fn();
    const builder = createAddonHost(ADDON_ID, {
      paneSession: {} as never,
      currentUrl: () => undefined,
      isConfiguredOrigin: () => false,
      logger: { warn },
    });

    builder.host.log({ code: 'runtime-failed' });

    expect(warn).toHaveBeenCalledWith('ADDON_RUNTIME_FAILED', {
      outcome: 'failure',
      addonId: ADDON_ID,
    });
  });
});

describe('createContributedToolModules', () => {
  const ids = createCountingIdGenerator('proxy');

  function toolHost(report?: (toolCallId: unknown, text: string) => void): ToolHost {
    const host = {
      bridge: { request: () => Promise.resolve({ kind: 'cancelled' }) },
      currentContext: () => ({
        origin: 'https://a.example',
        serverId: newServerId(ids),
        serverRevision: 1,
        navigationEpoch: 0,
        chatId: newChatId(ids),
        turnId: newTurnId(ids),
      }),
      environmentFacts: () => undefined,
      configuredHosts: () => [],
      skills: { list: () => [] },
      openPage: () => Promise.resolve({ kind: 'no_view' }),
      requestUserInput: () => Promise.resolve({ selections: [], freeform: null }),
      invokeTool: () => Promise.resolve(ok({})),
      clock: () => 1,
      idGenerator: ids,
      ...(report === undefined ? {} : { reportToolProgress: report }),
    };
    return host as unknown as ToolHost;
  }

  const CONTEXT = { toolCallId: newToolCallId(ids), signal: undefined };

  it('advertises the tool before the add-on is downloaded', () => {
    const ensure = vi.fn<AddonManager['ensure']>(() => new Promise(() => undefined));
    const load = loader({ ensure });
    const [module] = createContributedToolModules({
      tools: [{ addonId: ADDON_ID, tool: TOOL }],
      loader: load,
    });

    expect(module?.name).toBe(TOOL.name);
    expect(module?.descriptor).toEqual(TOOL.descriptor);
    expect(module?.allowlistEntry).toBe(TOOL.allowlistEntry);
    expect(module?.instructions).toBe(TOOL.instructions);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('writes the download’s progress and the loading stage onto the call', async () => {
    const ensure = vi.fn<AddonManager['ensure']>((_id, options) => {
      options?.onProgress?.(0.5);
      return Promise.resolve({ ok: true, value: installed() });
    });
    const load = loader({
      ensure,
      importModule: () =>
        Promise.resolve({
          addon: activationWith({ example_tool: () => () => Promise.resolve(ok({ done: true })) }),
        }),
    });
    const reported: string[] = [];
    const [module] = createContributedToolModules({
      tools: [{ addonId: ADDON_ID, tool: TOOL }],
      loader: load,
    });
    const execute = module?.createExecutor(toolHost((_id, text) => reported.push(text)));

    await execute?.({}, CONTEXT);

    expect(reported[0]).toContain('Downloading add-on');
    expect(reported[0]).toContain('50%');
    expect(reported).toContain('Loading tools');
  });

  it('forwards the model’s arguments unchanged and builds the executor once', async () => {
    const received: unknown[] = [];
    const factory = vi.fn(() => (args: unknown) => {
      received.push(args);
      return Promise.resolve(ok({}));
    });
    const load = loader({
      importModule: () => Promise.resolve({ addon: activationWith({ example_tool: factory }) }),
    });
    const [module] = createContributedToolModules({
      tools: [{ addonId: ADDON_ID, tool: TOOL }],
      loader: load,
    });
    const execute = module?.createExecutor(toolHost());
    const args = { target: 'https://a.example/x', nested: { a: [1, 2] } };

    await execute?.(args, CONTEXT);
    await execute?.(args, CONTEXT);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(expect.anything(), TOOL.descriptor);
    expect(received).toEqual([args, args]);
  });

  it('maps a failed load to a retryable STORAGE_ERROR naming the add-on', async () => {
    const load = loader({
      ensure: () =>
        Promise.resolve({ ok: false, error: { reason: 'offline', message: 'offline' } }),
    });
    const [module] = createContributedToolModules({
      tools: [{ addonId: ADDON_ID, tool: TOOL }],
      loader: load,
    });

    const outcome = await module?.createExecutor(toolHost())({}, CONTEXT);

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_ERROR', retryable: true },
    });
    expect((outcome as { error: { message: string } }).error.message).toContain(ADDON_ID);
  });

  it('maps a cancelled download to CANCELLED', async () => {
    const load = loader({
      ensure: () =>
        Promise.resolve({ ok: false, error: { reason: 'cancelled', message: 'cancelled' } }),
    });
    const [module] = createContributedToolModules({
      tools: [{ addonId: ADDON_ID, tool: TOOL }],
      loader: load,
    });

    expect(await module?.createExecutor(toolHost())({}, CONTEXT)).toMatchObject({
      ok: false,
      error: { code: 'CANCELLED' },
    });
  });

  it('retries a failed load on the next call instead of remembering it', async () => {
    const ensure = vi
      .fn<AddonManager['ensure']>()
      .mockResolvedValueOnce({ ok: false, error: { reason: 'offline', message: 'offline' } })
      .mockResolvedValueOnce({ ok: true, value: installed() });
    const load = loader({
      ensure,
      importModule: () =>
        Promise.resolve({
          addon: activationWith({ example_tool: () => () => Promise.resolve(ok({ done: true })) }),
        }),
    });
    const [module] = createContributedToolModules({
      tools: [{ addonId: ADDON_ID, tool: TOOL }],
      loader: load,
    });
    const execute = module?.createExecutor(toolHost());

    expect(await execute?.({}, CONTEXT)).toMatchObject({ ok: false });
    expect(await execute?.({}, CONTEXT)).toMatchObject({ ok: true });
    expect(ensure).toHaveBeenCalledTimes(2);
  });
});
