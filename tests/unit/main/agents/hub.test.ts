import { describe, expect, it, vi, type Mock } from 'vitest';

import { createAgentHub, type AgentHubDeps } from '../../../../src/main/agents/hub';
import {
  agentIdSchema,
  type AgentDefinition,
  type AgentHost,
  type AgentId,
  type AgentModule,
  type AgentRuntime,
  type AppSettings,
  type AgentService,
  ok,
} from '../../../../src/shared';

const ALPHA = agentIdSchema.parse('alpha');
const BETA = agentIdSchema.parse('beta');

const DEFINITIONS: readonly AgentDefinition[] = [
  { id: ALPHA, label: 'Alpha', requiresAuth: true, supportsInteractiveLogin: true },
  { id: BETA, label: 'Beta', requiresAuth: false, supportsInteractiveLogin: false },
];

function settingsWithActive(id: AgentId | undefined): AppSettings {
  return {
    hosts: [],
    projects: [],
    proxies: [],
    agents: {
      [ALPHA]: { active: id === ALPHA },
      [BETA]: { active: id === BETA },
    },
    browser: { disableNativeWebAuthn: true },
  };
}

function runtimeDouble(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    start: vi.fn(() => Promise.resolve()),
    reconcile: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    whenReady: vi.fn(() => Promise.resolve()),
    getAuthStatus: vi.fn(() => Promise.resolve({ apiVersion: 1 as const, isAuthenticated: true })),
    login: vi.fn(() => Promise.resolve({ status: 'success' as const })),
    cancelLogin: vi.fn(),
    logout: vi.fn(() => Promise.resolve({ apiVersion: 1 as const, warning: '' })),
    loadModelCatalog: vi.fn(() => Promise.resolve(ok([]))),
    ...overrides,
  };
}

function spy(runtime: AgentRuntime | undefined, key: keyof AgentRuntime): Mock {
  return (runtime as unknown as Record<string, Mock>)[key] as Mock;
}

interface Built {
  readonly hub: ReturnType<typeof createAgentHub>;
  readonly runtimes: Map<string, AgentRuntime>;
  readonly hosts: Map<string, AgentHost>;
  readonly installService: ReturnType<typeof vi.fn>;
  readonly markUnavailable: ReturnType<typeof vi.fn>;
  readonly onRuntimeFailure: ReturnType<typeof vi.fn>;
}

function build(
  options: {
    readonly definitions?: readonly AgentDefinition[];
    readonly loaded?: readonly string[];
    readonly overrides?: Record<string, Partial<AgentRuntime>>;
    readonly throwOnCreate?: readonly string[];
    readonly withoutLogin?: readonly string[];
  } = {},
): Built {
  const runtimes = new Map<string, AgentRuntime>();
  const hosts = new Map<string, AgentHost>();
  const installService = vi.fn<(service: AgentService) => Promise<void>>(() => Promise.resolve());
  const markUnavailable = vi.fn(() => Promise.resolve());
  const onRuntimeFailure = vi.fn();
  const modules: AgentModule[] = (options.loaded ?? ['alpha', 'beta']).map((id) => ({
    id: agentIdSchema.parse(id),
    createRuntime: (host) => {
      if (options.throwOnCreate?.includes(id) === true) throw new Error('bad module');
      const runtime = runtimeDouble(options.overrides?.[id]);
      if (options.withoutLogin?.includes(id) === true) {
        (runtime as { login?: AgentRuntime['login'] }).login = undefined;
      }
      runtimes.set(id, runtime);
      hosts.set(id, host);
      return runtime;
    },
  }));
  const deps: AgentHubDeps = {
    definitions: options.definitions ?? DEFINITIONS,
    modules,
    useFake: false,
    host: {
      isPackaged: false,
      resolveConnection: () => Promise.resolve({}),
      createProxyFetch: () => {
        throw new Error('not used');
      },
      toolkit: () => {
        throw new Error('not used');
      },
      modelPreferences: () => ({ model: null, reasoningEffort: null }),
    },
    installService,
    markUnavailable,
    onRuntimeFailure,
  };
  return {
    hub: createAgentHub(deps),
    runtimes,
    hosts,
    installService,
    markUnavailable,
    onRuntimeFailure,
  };
}

const SERVICE = {} as AgentService;

describe('createAgentHub', () => {
  it('starts only the configured agent', async () => {
    const b = build();
    await b.hub.start(settingsWithActive(BETA));

    expect(spy(b.runtimes.get('beta'), 'start')).toHaveBeenCalledTimes(1);
    expect(spy(b.runtimes.get('alpha'), 'start')).not.toHaveBeenCalled();
    expect(b.markUnavailable).not.toHaveBeenCalled();
  });

  it('marks the chat surface unavailable when no agent is defined', async () => {
    const b = build({ definitions: [], loaded: [] });
    await b.hub.start(settingsWithActive(undefined));

    expect(b.markUnavailable).toHaveBeenCalledTimes(1);
  });

  it('marks the chat surface unavailable when the configured agent failed to load', async () => {
    const b = build({ loaded: ['beta'] });
    await b.hub.start(settingsWithActive(ALPHA));

    expect(b.markUnavailable).toHaveBeenCalledTimes(1);
    expect(spy(b.runtimes.get('beta'), 'start')).not.toHaveBeenCalled();
  });

  it('reports a module whose createRuntime throws and keeps the others usable', async () => {
    const b = build({ throwOnCreate: ['alpha'] });

    expect(b.onRuntimeFailure).toHaveBeenCalledWith(ALPHA, expect.any(Error));
    await b.hub.start(settingsWithActive(BETA));
    expect(spy(b.runtimes.get('beta'), 'start')).toHaveBeenCalledTimes(1);
  });

  it('degrades a throwing start to unavailable instead of rejecting', async () => {
    const b = build({ overrides: { alpha: { start: () => Promise.reject(new Error('boom')) } } });

    await expect(b.hub.start(settingsWithActive(ALPHA))).resolves.toBeUndefined();

    expect(b.onRuntimeFailure).toHaveBeenCalledWith(ALPHA, expect.any(Error));
    expect(b.markUnavailable).toHaveBeenCalledTimes(1);
  });

  it('only lets the active agent install a service', async () => {
    const b = build();
    await b.hub.start(settingsWithActive(ALPHA));

    await b.hosts.get('beta')?.installService(SERVICE);
    expect(b.installService).not.toHaveBeenCalled();

    await b.hosts.get('alpha')?.installService(SERVICE);
    expect(b.installService).toHaveBeenCalledWith(SERVICE);
  });

  it('lets the active agent decide whether to recycle when settings change but the agent does not', async () => {
    const b = build();
    await b.hub.start(settingsWithActive(ALPHA));
    const next = settingsWithActive(ALPHA);

    await b.hub.reconcile(next);

    expect(spy(b.runtimes.get('alpha'), 'reconcile')).toHaveBeenCalledWith(next);
    expect(spy(b.runtimes.get('alpha'), 'stop')).not.toHaveBeenCalled();
  });

  it('stops the previous agent and starts the new one when the configured agent changes', async () => {
    const b = build();
    await b.hub.start(settingsWithActive(ALPHA));
    const next = settingsWithActive(BETA);

    await b.hub.reconcile(next);

    expect(spy(b.runtimes.get('alpha'), 'stop')).toHaveBeenCalledTimes(1);
    expect(spy(b.runtimes.get('beta'), 'start')).toHaveBeenCalledWith(next);
  });

  it('routes auth calls to the named agent, not the configured one', async () => {
    const b = build();
    await b.hub.start(settingsWithActive(ALPHA));

    await b.hub.getAuthStatus(BETA);
    await b.hub.login(BETA, undefined);
    b.hub.cancelLogin(BETA);
    await b.hub.logout(BETA);

    const beta = b.runtimes.get('beta');
    expect(spy(beta, 'getAuthStatus')).toHaveBeenCalledTimes(1);
    expect(beta?.login).toHaveBeenCalledTimes(1);
    expect(beta?.cancelLogin).toHaveBeenCalledTimes(1);
    expect(beta?.logout).toHaveBeenCalledTimes(1);
    expect(spy(b.runtimes.get('alpha'), 'getAuthStatus')).not.toHaveBeenCalled();
  });

  it('answers a plain "no such agent" for an agent that did not load', async () => {
    const b = build({ loaded: ['beta'] });

    await expect(b.hub.getAuthStatus(ALPHA)).resolves.toMatchObject({ isAuthenticated: false });
    await expect(b.hub.login(ALPHA, undefined)).resolves.toMatchObject({ status: 'failed' });
    await expect(b.hub.logout(ALPHA)).resolves.toHaveProperty('warning');
    expect(() => {
      b.hub.cancelLogin(ALPHA);
    }).not.toThrow();
  });

  it('answers a failed login for an agent without sign-in support', async () => {
    const b = build({ withoutLogin: ['alpha'] });

    await expect(b.hub.login(ALPHA, undefined)).resolves.toMatchObject({ status: 'failed' });
  });

  it('turns a throwing auth call into a neutral answer', async () => {
    const b = build({
      overrides: {
        alpha: {
          getAuthStatus: () => Promise.reject(new Error('boom')),
          login: () => Promise.reject(new Error('boom')),
          logout: () => Promise.reject(new Error('boom')),
        },
      },
    });

    await expect(b.hub.getAuthStatus(ALPHA)).resolves.toMatchObject({ isAuthenticated: false });
    await expect(b.hub.login(ALPHA, undefined)).resolves.toMatchObject({ status: 'failed' });
    await expect(b.hub.logout(ALPHA)).resolves.toHaveProperty('warning');
    expect(b.onRuntimeFailure).toHaveBeenCalledTimes(3);
  });

  it('loads the model catalogue from the configured agent, and errors when none is available', async () => {
    const none = build({ definitions: [], loaded: [] });
    await none.hub.start(settingsWithActive(undefined));
    expect((await none.hub.loadModelCatalog()).ok).toBe(false);

    const b = build();
    await b.hub.start(settingsWithActive(BETA));
    expect((await b.hub.loadModelCatalog()).ok).toBe(true);
    expect(spy(b.runtimes.get('beta'), 'loadModelCatalog')).toHaveBeenCalledTimes(1);
  });

  it('refreshes the configured agent with the last known settings', async () => {
    const b = build();
    const settings = settingsWithActive(ALPHA);
    await b.hub.start(settings);

    await b.hub.refresh();

    expect(spy(b.runtimes.get('alpha'), 'refresh')).toHaveBeenCalledWith(settings);
  });

  it('stops every runtime, tolerating one that throws', async () => {
    const b = build({ overrides: { alpha: { stop: () => Promise.reject(new Error('boom')) } } });

    await expect(b.hub.stop()).resolves.toBeUndefined();

    expect(spy(b.runtimes.get('beta'), 'stop')).toHaveBeenCalledTimes(1);
  });

  it('stands a fake runtime in for every definition when useFake is set', async () => {
    const installService = vi.fn<(service: AgentService) => Promise<void>>(() => Promise.resolve());
    const hub = createAgentHub({
      definitions: DEFINITIONS,
      modules: [],
      useFake: true,
      host: {
        isPackaged: false,
        resolveConnection: () => Promise.resolve({}),
        createProxyFetch: () => {
          throw new Error('not used');
        },
        toolkit: () => {
          throw new Error('not used');
        },
        modelPreferences: () => ({ model: null, reasoningEffort: null }),
      },
      installService,
      markUnavailable: () => Promise.resolve(),
    });

    await hub.start(settingsWithActive(ALPHA));

    expect(installService).toHaveBeenCalledTimes(1);
    await expect(hub.getAuthStatus(BETA)).resolves.toMatchObject({ isAuthenticated: true });
  });
});
