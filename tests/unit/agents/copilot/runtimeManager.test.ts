import { describe, expect, it, vi, type Mock } from 'vitest';
import type {
  CopilotClient,
  ProxyEnvOverrides,
} from '../../../../src/agents/copilot/copilotClient';
import {
  createCopilotRuntimeManager,
  type CopilotRuntimeManagerDeps,
  type RuntimeClientOptions,
} from '../../../../src/agents/copilot/runtimeManager';
import { type AgentId, type AppSettings, type ProxyId } from '../../../../src/shared';
import { TEST_AGENT_ID } from '../../../support/agentDefinitions';

/**
 * The manager is what makes "one runtime for the whole app" true, and what
 * decides which settings changes are allowed to restart that runtime. Both are
 * pure wiring decisions; the live proof that a proxied runtime really starts
 * and really talks through the proxy is `tests/integration/proxy-runtime.test.ts`.
 *
 * The clients here are inert tags - the manager never touches a client's
 * methods, only its identity, so identity is what the assertions compare.
 */

const PROXY_ENV: ProxyEnvOverrides = {
  httpsProxy: 'http://proxy.example:8080',
  httpProxy: 'http://proxy.example:8080',
};

interface TaggedClient extends CopilotClient {
  readonly tag: string;
}

function settingsWith(overrides: { active?: AgentId; proxy?: ProxyId } = {}): AppSettings {
  const active = overrides.active ?? TEST_AGENT_ID;
  return {
    hosts: [],
    projects: [],
    proxies: [],
    agents: {
      [TEST_AGENT_ID]: { active: active === TEST_AGENT_ID },
      ['opencode' as AgentId]: { active: active === 'opencode' },
      ...(overrides.proxy === undefined
        ? {}
        : { [active]: { active: true, proxy: overrides.proxy } }),
    },
    browser: { disableNativeWebAuthn: true },
    memos: { enabled: true },
    updates: { checkOnStartup: false },
  };
}

function createHarness(overrides: Partial<CopilotRuntimeManagerDeps> = {}): {
  readonly deps: CopilotRuntimeManagerDeps;
  readonly createClient: Mock;
  readonly startRuntime: Mock;
  readonly stopClient: Mock;
  readonly resolveProxyOverrides: Mock;
  readonly resolveGithubToken: Mock;
  readonly tags: string[];
} {
  const tags: string[] = [];
  const createClient = vi.fn((options: RuntimeClientOptions) => {
    const tag =
      options.githubToken !== undefined
        ? `token-${tags.length}`
        : options.proxy === undefined
          ? `direct-${tags.length}`
          : `proxied-${tags.length}`;
    tags.push(tag);
    return { tag } as unknown as TaggedClient;
  });
  const startRuntime = vi.fn(() => Promise.resolve(undefined));
  const stopClient = vi.fn(() => Promise.resolve(undefined));
  const resolveProxyOverrides = vi.fn(() => Promise.resolve(undefined));
  const resolveGithubToken = vi.fn(() => Promise.resolve(undefined));

  const deps: CopilotRuntimeManagerDeps = {
    recycleOnSettingsChange: true,
    startRuntime,
    stopClient,
    createClient,
    resolveProxyOverrides,
    resolveGithubToken,
    ...overrides,
  };
  // The overrides are what the manager actually calls, so the assertions must
  // look at those - reading the local defaults would assert on a mock that is
  // never invoked.
  return {
    deps,
    createClient: deps.createClient as unknown as Mock,
    startRuntime: deps.startRuntime as unknown as Mock,
    stopClient: deps.stopClient as unknown as Mock,
    resolveProxyOverrides: deps.resolveProxyOverrides as unknown as Mock,
    resolveGithubToken: deps.resolveGithubToken as unknown as Mock,
    tags,
  };
}

describe('createCopilotRuntimeManager', () => {
  it('has a client immediately, before any startup, created without credentials', () => {
    const h = createHarness();
    const manager = createCopilotRuntimeManager(h.deps);

    // The auth handlers may run before the chat runtime's background startup.
    expect(manager.getClient()).toBeDefined();
    expect(h.createClient).toHaveBeenCalledWith({});
  });

  it('starts the runtime with the active provider proxy and stops the eager client', async () => {
    const h = createHarness({
      resolveProxyOverrides: vi.fn(() => Promise.resolve(PROXY_ENV)),
    });
    const manager = createCopilotRuntimeManager(h.deps);
    const eager = manager.getClient();

    await manager.start(settingsWith({ proxy: 'proxy-1' as ProxyId }));

    const started = h.startRuntime.mock.calls[0]?.[0] as TaggedClient;
    expect(started.tag).toBe('proxied-1');
    expect(manager.getClient()).toBe(started);
    expect(h.stopClient).toHaveBeenCalledWith(eager);
  });

  it('passes the resolved token to the client, alongside the proxy', async () => {
    const h = createHarness({
      resolveProxyOverrides: vi.fn(() => Promise.resolve(PROXY_ENV)),
      resolveGithubToken: vi.fn(() => Promise.resolve('ghp_stored_token')),
    });
    const manager = createCopilotRuntimeManager(h.deps);

    await manager.start(settingsWith({ proxy: 'proxy-1' as ProxyId }));

    expect(h.createClient).toHaveBeenLastCalledWith({
      proxy: PROXY_ENV,
      githubToken: 'ghp_stored_token',
    });
  });

  it('omits the token from the client when none is stored', async () => {
    const h = createHarness({
      resolveProxyOverrides: vi.fn(() => Promise.resolve(PROXY_ENV)),
    });
    const manager = createCopilotRuntimeManager(h.deps);

    await manager.start(settingsWith({ proxy: 'proxy-1' as ProxyId }));

    expect(h.createClient).toHaveBeenLastCalledWith({ proxy: PROXY_ENV });
  });

  it('refresh(settings) resolves both credentials from the supplied document', async () => {
    // A token set/clear passes a freshly-reloaded document: the first set
    // mints the secretRef into settings.json, so recycling from the captured
    // document would resolve no token at all.
    const h = createHarness({
      resolveProxyOverrides: vi.fn(() => Promise.resolve(PROXY_ENV)),
      resolveGithubToken: vi.fn(() => Promise.resolve('ghp_stored_token')),
    });
    const manager = createCopilotRuntimeManager(h.deps);
    await manager.start(settingsWith());
    const fresh = settingsWith({ proxy: 'proxy-1' as ProxyId });

    await manager.refresh(fresh);

    expect(h.resolveProxyOverrides).toHaveBeenLastCalledWith(fresh);
    expect(h.resolveGithubToken).toHaveBeenLastCalledWith(fresh);
    expect(h.createClient).toHaveBeenLastCalledWith({
      proxy: PROXY_ENV,
      githubToken: 'ghp_stored_token',
    });
  });

  it('leaves the working runtime untouched when the token cannot be resolved', async () => {
    const h = createHarness();
    const manager = createCopilotRuntimeManager(h.deps);
    await manager.start(settingsWith());
    const before = manager.getClient();
    const stopsBefore = h.stopClient.mock.calls.length;
    h.resolveGithubToken.mockRejectedValueOnce(new Error('secret store unavailable'));

    await expect(manager.refresh(settingsWith({ proxy: 'proxy-1' as ProxyId }))).rejects.toThrow(
      'secret store unavailable',
    );

    expect(manager.getClient()).toBe(before);
    expect(h.startRuntime).toHaveBeenCalledTimes(1);
    expect(h.stopClient).toHaveBeenCalledTimes(stopsBefore);
  });

  it('does not recycle when only the model or effort changed', async () => {
    const h = createHarness();
    const manager = createCopilotRuntimeManager(h.deps);

    await manager.start(settingsWith());
    const afterStart = h.createClient.mock.calls.length;
    await manager.reconcile(settingsWith());

    expect(h.createClient).toHaveBeenCalledTimes(afterStart);
    expect(h.startRuntime).toHaveBeenCalledTimes(1);
  });

  it('recycles when the active provider proxy changes', async () => {
    const h = createHarness({
      resolveProxyOverrides: vi.fn(() => Promise.resolve(PROXY_ENV)),
    });
    const manager = createCopilotRuntimeManager(h.deps);
    await manager.start(settingsWith());
    const before = manager.getClient();

    await manager.reconcile(settingsWith({ proxy: 'proxy-1' as ProxyId }));

    // The eager client, the one `start` installed, and this recycle's.
    expect(h.createClient).toHaveBeenCalledTimes(3);
    expect(h.startRuntime).toHaveBeenCalledTimes(2);
    expect(manager.getClient()).not.toBe(before);
    expect(h.stopClient).toHaveBeenCalledWith(before);
  });

  it('does not recycle when a different agent becomes active - the hub owns switching', async () => {
    const h = createHarness();
    const manager = createCopilotRuntimeManager(h.deps);
    await manager.start(settingsWith());
    const before = manager.getClient();

    await manager.reconcile(settingsWith({ active: 'opencode' as AgentId }));

    expect(manager.getClient()).toBe(before);
    expect(h.startRuntime).toHaveBeenCalledTimes(1);
  });

  it('steps aside entirely on the fake-agent path', async () => {
    // There is no child process to proxy, and recycling would throw away the
    // fake service's state - the E2E suite drives that state directly.
    const h = createHarness({ recycleOnSettingsChange: false });
    const manager = createCopilotRuntimeManager(h.deps);
    await manager.start(settingsWith());
    const before = manager.getClient();
    const createdBefore = h.createClient.mock.calls.length;

    await manager.reconcile(settingsWith({ proxy: 'proxy-1' as ProxyId }));

    expect(manager.getClient()).toBe(before);
    expect(h.createClient).toHaveBeenCalledTimes(createdBefore);
  });

  it('recycles unconditionally on refresh, even on the fake-agent path', async () => {
    // Sign-in is real even when chat is faked: the running process resolved
    // its credentials already and must not be reused.
    const h = createHarness({ recycleOnSettingsChange: false });
    const manager = createCopilotRuntimeManager(h.deps);
    await manager.start(settingsWith());
    const before = manager.getClient();

    await manager.refresh();

    expect(manager.getClient()).not.toBe(before);
    expect(h.stopClient).toHaveBeenCalledWith(before);
  });

  it('refreshes with the settings the running runtime was started from', async () => {
    const h = createHarness({
      resolveProxyOverrides: vi.fn(() => Promise.resolve(PROXY_ENV)),
    });
    const manager = createCopilotRuntimeManager(h.deps);
    const settings = settingsWith({ proxy: 'proxy-1' as ProxyId });
    await manager.start(settings);

    await manager.refresh();

    expect(h.resolveProxyOverrides).toHaveBeenLastCalledWith(settings);
  });

  it('stops the runtime and forgets its descriptor', async () => {
    const h = createHarness();
    const manager = createCopilotRuntimeManager(h.deps);
    await manager.start(settingsWith());
    const before = manager.getClient();

    await manager.stop();

    expect(h.stopClient).toHaveBeenCalledWith(before);
    // The same settings must now be a *change* again - a stopped manager
    // holds no runtime to keep.
    await manager.reconcile(settingsWith());
    expect(h.startRuntime).toHaveBeenCalledTimes(2);
  });

  it('leaves the working runtime untouched when the proxy cannot be resolved', async () => {
    const h = createHarness();
    const manager = createCopilotRuntimeManager(h.deps);
    await manager.start(settingsWith());
    const before = manager.getClient();
    const stopsBefore = h.stopClient.mock.calls.length;
    h.resolveProxyOverrides.mockRejectedValueOnce(new Error('secret store unavailable'));

    await expect(manager.reconcile(settingsWith({ proxy: 'proxy-1' as ProxyId }))).rejects.toThrow(
      'secret store unavailable',
    );

    expect(manager.getClient()).toBe(before);
    expect(h.startRuntime).toHaveBeenCalledTimes(1);
    expect(h.stopClient).toHaveBeenCalledTimes(stopsBefore);
  });

  it('stays usable after a failed recycle', async () => {
    const h = createHarness({ resolveProxyOverrides: vi.fn(() => Promise.resolve(PROXY_ENV)) });
    const manager = createCopilotRuntimeManager(h.deps);
    await manager.start(settingsWith());
    h.resolveProxyOverrides.mockRejectedValueOnce(new Error('secret store unavailable'));

    await expect(
      manager.reconcile(settingsWith({ proxy: 'proxy-1' as ProxyId })),
    ).rejects.toThrow();
    await manager.reconcile(settingsWith({ proxy: 'proxy-1' as ProxyId }));

    expect(h.startRuntime).toHaveBeenCalledTimes(2);
    expect(manager.getClient()).toMatchObject({ tag: 'proxied-2' });
  });

  it('whenReady resolves before any startup has been requested', async () => {
    const h = createHarness();
    const manager = createCopilotRuntimeManager(h.deps);

    await expect(manager.whenReady()).resolves.toBeUndefined();
  });

  it('whenReady does not settle until the in-flight install has settled', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = createHarness({
      resolveProxyOverrides: vi.fn(async () => {
        await gate;
        return undefined;
      }),
    });
    const manager = createCopilotRuntimeManager(h.deps);

    const started = manager.start(settingsWith());
    let ready = false;
    const readyPromise = manager.whenReady().then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);

    release?.();
    await started;
    await readyPromise;
    expect(ready).toBe(true);
  });

  it('a reader that awaits whenReady sees the recycled client, not the replaced one', async () => {
    // This is the model-catalogue read path: after a proxy change the runtime
    // recycles, and reading through `getClient()` before the new client has
    // started fails. Awaiting `whenReady()` must land on the new client.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolveProxyOverrides = vi
      .fn<(settings: AppSettings | undefined) => Promise<ProxyEnvOverrides | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        await gate;
        return PROXY_ENV;
      });
    const h = createHarness({ resolveProxyOverrides });
    const manager = createCopilotRuntimeManager(h.deps);
    await manager.start(settingsWith());
    const before = manager.getClient();

    const recycle = manager.reconcile(settingsWith({ proxy: 'proxy-1' as ProxyId }));
    const seen = manager.whenReady().then(() => manager.getClient());
    await Promise.resolve();
    release?.();
    await recycle;

    expect(await seen).toBe(manager.getClient());
    expect(await seen).not.toBe(before);
  });

  it('whenReady resolves rather than rejects after a failed install', async () => {
    const h = createHarness({
      resolveProxyOverrides: vi.fn(() => Promise.reject(new Error('secret store unavailable'))),
    });
    const manager = createCopilotRuntimeManager(h.deps);

    await expect(manager.start(settingsWith())).rejects.toThrow('secret store unavailable');
    await expect(manager.whenReady()).resolves.toBeUndefined();
  });

  it('serializes concurrent recycles instead of interleaving them', async () => {
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const resolveProxyOverrides = vi
      .fn<(settings: AppSettings | undefined) => Promise<ProxyEnvOverrides | undefined>>()
      .mockImplementationOnce(async () => {
        await gate;
        return undefined;
      })
      .mockResolvedValue(undefined);
    const h = createHarness({ resolveProxyOverrides });
    const manager = createCopilotRuntimeManager(h.deps);

    const first = manager.start(settingsWith());
    const second = manager.reconcile(settingsWith({ active: 'opencode' as AgentId }));

    // The second install must not begin until the first has fully settled.
    expect(h.startRuntime).not.toHaveBeenCalled();
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(h.startRuntime.mock.calls.length).toBe(2);
    expect(h.createClient.mock.calls.length).toBe(3);
  });
});
