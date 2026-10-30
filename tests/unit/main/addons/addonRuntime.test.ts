import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AddonHiddenWindowOptions,
  type AddonHost,
  type ContributedTool,
  type ToolHost,
  ADDON_API_VERSION,
  newChatId,
  newServerId,
  newToolCallId,
  newTurnId,
  ok,
} from '../../../../src/shared';
import {
  type AddonHostHandle,
  type ScannedAddon,
  addonPartitionName,
  createAddonHost,
  createAddonLoader,
} from '../../../../src/main/addons';
import { createContributedToolModules } from '../../../../src/main/tools/addonProxy';
import { createCountingIdGenerator } from '../../../support/testIds';

/**
 * The generic add-on machinery: the loader, the host an add-on receives and the
 * proxy that advertises its tools. None of it knows any add-on, so the fixtures
 * here are neutral.
 */

const { createdWindows, fromPartition } = vi.hoisted(() => ({
  createdWindows: [] as { options: Record<string, unknown>; destroyed: boolean }[],
  fromPartition: vi.fn((name: string) => ({ partition: name })),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {
    private readonly record: { options: Record<string, unknown>; destroyed: boolean };
    readonly webContents = { id: 1 };

    constructor(options: Record<string, unknown>) {
      this.record = { options, destroyed: false };
      createdWindows.push(this.record);
    }

    // The host listens for `closed`; the fake never fires it.
    once(): void {}

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

const ADDON_ID = 'example-addon';
const DIR = path.join('C:', 'addons', ADDON_ID);

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

const SCANNED: ScannedAddon = {
  id: ADDON_ID,
  directory: DIR,
  descriptor: { id: ADDON_ID, apiVersion: ADDON_API_VERSION, entry: 'index.js' },
  contributions: { tools: [TOOL], skills: [] },
};

const NO_HOST: AddonHostHandle = {
  host: {} as AddonHost<never, never>,
  destroyWindows: () => undefined,
};

function activationWith(tools: Record<string, unknown>) {
  return { apiVersion: ADDON_API_VERSION, activate: () => ({ tools }) };
}

function loader(
  options: {
    entries?: readonly ScannedAddon[];
    importModule?: (specifier: string) => Promise<unknown>;
    createHost?: (id: string) => AddonHostHandle;
  } = {},
) {
  return createAddonLoader({
    entries: options.entries ?? [SCANNED],
    createHost: options.createHost ?? (() => NO_HOST),
    ...(options.importModule === undefined ? {} : { importModule: options.importModule }),
  });
}

const exampleModule = () => ({
  addon: activationWith({ example_tool: () => () => Promise.resolve(ok({})) }),
});

describe('createAddonLoader', () => {
  it('imports the entry from the add-on folder and exposes its directory and host', async () => {
    const importModule = vi.fn(() => Promise.resolve(exampleModule()));
    const instance = loader({ importModule });

    expect(instance.directoryOf(ADDON_ID)).toBeUndefined();
    expect(instance.hostOf(ADDON_ID)).toBeUndefined();

    const loaded = await instance.load(ADDON_ID);

    expect(loaded.ok).toBe(true);
    expect(importModule).toHaveBeenCalledWith(pathToFileURL(path.join(DIR, 'index.js')).href);
    expect(instance.directoryOf(ADDON_ID)).toBe(DIR);
    expect(instance.hostOf(ADDON_ID)).toBe(NO_HOST);
  });

  it('shares one load between concurrent callers and caches a success', async () => {
    const importModule = vi.fn(() => Promise.resolve(exampleModule()));
    const instance = loader({ importModule });

    await Promise.all([instance.load(ADDON_ID), instance.load(ADDON_ID)]);
    await instance.load(ADDON_ID);

    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure', async () => {
    const importModule = vi
      .fn<(specifier: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('disk hiccup'))
      .mockResolvedValue(exampleModule());
    const instance = loader({ importModule });

    expect((await instance.load(ADDON_ID)).ok).toBe(false);
    expect((await instance.load(ADDON_ID)).ok).toBe(true);
  });

  it('reports an add-on that is not part of this build as unavailable', async () => {
    const importModule = vi.fn(() => Promise.resolve(exampleModule()));
    const loaded = await loader({ importModule }).load('missing-addon');

    expect(loaded).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect(importModule).not.toHaveBeenCalled();
  });

  it('refuses a descriptor written for another api version before importing it', async () => {
    const importModule = vi.fn(() => Promise.resolve(exampleModule()));
    const entry: ScannedAddon = {
      ...SCANNED,
      descriptor: { ...SCANNED.descriptor, apiVersion: 99 },
    };
    const loaded = await loader({ entries: [entry], importModule }).load(ADDON_ID);

    expect(loaded).toMatchObject({ ok: false, error: { kind: 'apiVersion' } });
    expect(importModule).not.toHaveBeenCalled();
  });

  it('refuses a module built for another api version', async () => {
    const importModule = () =>
      Promise.resolve({
        addon: { apiVersion: ADDON_API_VERSION + 1, activate: () => ({ tools: {} }) },
      });

    expect(await loader({ importModule }).load(ADDON_ID)).toMatchObject({
      ok: false,
      error: { kind: 'apiVersion' },
    });
  });

  it.each([
    ['a module without an add-on', () => Promise.resolve({})],
    ['an import that rejects', () => Promise.reject(new Error('syntax error'))],
    [
      'an activation without tools',
      () => Promise.resolve({ addon: { apiVersion: ADDON_API_VERSION, activate: () => ({}) } }),
    ],
    [
      'an activation that throws',
      () =>
        Promise.resolve({
          addon: {
            apiVersion: ADDON_API_VERSION,
            activate: () => {
              throw new Error('no window available');
            },
          },
        }),
    ],
  ])('reports %s as unavailable and never throws', async (_name, importModule) => {
    expect(await loader({ importModule }).load(ADDON_ID)).toMatchObject({
      ok: false,
      error: { kind: 'unavailable' },
    });
  });

  it('reports a declared tool the activation does not provide, naming it', async () => {
    const importModule = () => Promise.resolve({ addon: activationWith({}) });
    const loaded = await loader({ importModule }).load(ADDON_ID);

    expect(loaded).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect(!loaded.ok && loaded.error.message).toContain(TOOL.name);
  });
});

describe('createAddonHost', () => {
  function makeHost() {
    const handle = createAddonHost(ADDON_ID, {
      paneSession: { partition: 'persist:webview' } as never,
      currentUrl: () => 'https://a.example/',
      isConfiguredOrigin: (origin) => origin === 'https://a.example',
      logger: { warn: vi.fn() },
    });
    return { builder: handle, pane: handle.host.sessions.pane() };
  }

  it('forces the safety-critical window options whatever the add-on asks for', () => {
    const { builder, pane } = makeHost();

    // The cast is the only way an add-on could try this.
    builder.host.browser.createHiddenWindow({
      session: pane,
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
        session: pane,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        offscreen: true,
        backgroundThrottling: false,
      },
    });
  });

  it('names an isolated session after the add-on', () => {
    const { builder } = makeHost();

    builder.host.sessions.isolated('anonymous');

    expect(fromPartition).toHaveBeenCalledWith(addonPartitionName(ADDON_ID, 'anonymous'));
    expect(addonPartitionName(ADDON_ID, 'anonymous')).toBe('addon-example-addon-anonymous');
  });

  it('refuses a session it did not hand out', () => {
    const { builder } = makeHost();

    expect(() =>
      builder.host.browser.createHiddenWindow({
        session: {} as never,
      }),
    ).toThrow(/did not hand out/);
  });

  it('destroys the windows it created', () => {
    const { builder, pane } = makeHost();

    builder.host.browser.createHiddenWindow({ session: pane });
    builder.destroyWindows();

    expect(createdWindows[0]?.destroyed).toBe(true);
  });

  it('exposes the address policy and the pane URL', async () => {
    const { builder } = makeHost();

    expect(builder.host.hosts.isConfiguredOrigin('https://a.example')).toBe(true);
    expect(builder.host.hosts.isConfiguredOrigin('https://b.example')).toBe(false);
    expect(builder.host.pane.currentUrl()).toBe('https://a.example/');
    await expect(builder.host.network.inspectTarget('not a url')).resolves.toMatchObject({
      allowed: false,
    });
    await expect(builder.host.network.inspectTarget('http://127.0.0.1/x')).resolves.toMatchObject({
      allowed: false,
    });
  });

  it('logs a failure under the add-on id', () => {
    const warn = vi.fn();
    const { host } = createAddonHost(ADDON_ID, {
      paneSession: {} as never,
      currentUrl: () => undefined,
      isConfiguredOrigin: () => false,
      logger: { warn },
    });

    host.log({ code: 'runtime-failed' });

    expect(warn).toHaveBeenCalledWith('ADDON_RUNTIME_FAILED', {
      outcome: 'failure',
      addonId: ADDON_ID,
    });
  });
});

describe('createContributedToolModules', () => {
  const ids = createCountingIdGenerator('proxy');

  function toolHost(report?: (id: unknown, text: string) => void): ToolHost {
    return {
      bridge: { request: vi.fn() },
      currentContext: () => ({
        origin: 'https://a.example',
        serverId: newServerId(ids),
        serverRevision: 1,
        navigationEpoch: 0,
        chatId: newChatId(ids),
        turnId: newTurnId(ids),
      }),
      environmentFacts: vi.fn(),
      configuredHosts: vi.fn(() => []),
      skills: { list: vi.fn(() => []) },
      openPage: vi.fn(),
      requestUserInput: vi.fn(),
      invokeTool: vi.fn(),
      clock: { now: () => 0 },
      idGenerator: ids,
      ...(report === undefined ? {} : { reportToolProgress: report }),
    } as unknown as ToolHost;
  }

  const CONTEXT = { toolCallId: newToolCallId(ids), signal: undefined };

  function modules(importModule: (specifier: string) => Promise<unknown>) {
    return createContributedToolModules({
      tools: [{ addonId: ADDON_ID, tool: TOOL }],
      loader: loader({ importModule }),
    });
  }

  it('advertises the tool without loading the add-on', () => {
    const importModule = vi.fn(() => Promise.resolve(exampleModule()));
    const [module] = modules(importModule);

    expect(module).toMatchObject({
      name: TOOL.name,
      descriptor: TOOL.descriptor,
      allowlistEntry: TOOL.allowlistEntry,
      instructions: TOOL.instructions,
    });
    expect(importModule).not.toHaveBeenCalled();
  });

  it('reports only that the tools are loading', async () => {
    const reported: string[] = [];
    const [module] = modules(() => Promise.resolve(exampleModule()));

    await module?.createExecutor(toolHost((_id, text) => reported.push(text)))({}, CONTEXT);

    expect(reported).toEqual(['Loading tools']);
  });

  it('forwards the arguments unchanged and builds the executor once', async () => {
    const run = vi.fn(() => Promise.resolve(ok({ done: true })));
    const factory = vi.fn(() => run);
    const [module] = modules(() =>
      Promise.resolve({ addon: activationWith({ example_tool: factory }) }),
    );
    const execute = module?.createExecutor(toolHost());

    await execute?.({ target: 'x' }, CONTEXT);
    await execute?.({ target: 'y' }, CONTEXT);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(expect.anything(), TOOL.descriptor);
    expect(run).toHaveBeenNthCalledWith(1, { target: 'x' }, CONTEXT);
    expect(run).toHaveBeenNthCalledWith(2, { target: 'y' }, CONTEXT);
  });

  it('turns a failed load into a retryable error naming the add-on', async () => {
    const [module] = modules(() => Promise.reject(new Error('missing file')));

    const outcome = await module?.createExecutor(toolHost())({}, CONTEXT);

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_ERROR', retryable: true },
    });
    expect(JSON.stringify(outcome)).toContain(ADDON_ID);
  });

  it('loads again on the next call after a failure', async () => {
    const importModule = vi
      .fn<(specifier: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('missing file'))
      .mockResolvedValue(exampleModule());
    const [module] = modules(importModule);
    const execute = module?.createExecutor(toolHost());

    expect(await execute?.({}, CONTEXT)).toMatchObject({ ok: false });
    expect(await execute?.({}, CONTEXT)).toMatchObject({ ok: true });
  });

  it('reports a tool factory that throws as unavailable', async () => {
    const [module] = modules(() =>
      Promise.resolve({
        addon: activationWith({
          example_tool: () => {
            throw new Error('cannot start');
          },
        }),
      }),
    );

    expect(await module?.createExecutor(toolHost())({}, CONTEXT)).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_ERROR', retryable: true },
    });
  });
});
