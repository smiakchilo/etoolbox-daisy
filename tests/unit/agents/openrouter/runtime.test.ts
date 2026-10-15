import { describe, expect, it, vi } from 'vitest';
import { createOpenRouterRuntime } from '../../../../src/agents/openrouter/runtime';
import {
  defaultAppSettings,
  type AgentConnection,
  type AgentHost,
  type AgentService,
} from '../../../../src/shared';

/**
 * Runtime wiring for the OpenRouter agent, against a fake host: start installs
 * a service, auth/presence are projected from the resolved key, and stop clears
 * them. No network, no SDK client construction beyond the stateless wrapper.
 */

function buildHost(
  connection: AgentConnection,
  options: {
    /** Overrides the connection resolution so a test can hold `start` open. */
    readonly resolveConnection?: () => Promise<AgentConnection>;
  } = {},
): {
  host: AgentHost;
  installed: AgentService[];
  resolveConnection: ReturnType<typeof vi.fn>;
} {
  const installed: AgentService[] = [];
  const resolveConnection = vi.fn(options.resolveConnection ?? (() => Promise.resolve(connection)));
  const host: AgentHost = {
    isPackaged: false,
    stateDirectory: 'C:\\agents\\openrouter',
    resolveConnection,
    createProxyFetch: () => globalThis.fetch,
    installService: (service) => {
      installed.push(service);
      return Promise.resolve();
    },
    toolkit: () => ({
      allowlistEntries: [],
      instructions: 'You are a read-only AEM assistant.',
      toolHandlers: {},
      toolDescriptors: [],
      bundledSkillDirectories: [],
    }),
    modelPreferences: () => ({ model: null, reasoningEffort: null }),
  };
  return { host, installed, resolveConnection };
}

const settings = defaultAppSettings();

describe('createOpenRouterRuntime', () => {
  it('installs a service and reports authentication from a stored key', async () => {
    const { host, installed } = buildHost({ accessToken: 'sk-or-v1-key' });
    const runtime = createOpenRouterRuntime(host);

    await runtime.start(settings);

    expect(installed).toHaveLength(1);
    await expect(runtime.getAuthStatus()).resolves.toMatchObject({ isAuthenticated: true });
    await expect(runtime.getAuthPresence?.()).resolves.toEqual({ present: true });
  });

  it('waits out an in-flight install before reporting auth, so a startup-racing read is not a false signed-out', async () => {
    // Regression: the Agents tab disables its Model/Effort pickers on the live
    // auth status. Reading it while the initial install was still running
    // reported "signed out" (the token is assigned only at the end of
    // `install`), leaving the pickers disabled until the user touched another
    // control and forced a second read. Both projections must await the
    // install chain first, exactly as `loadModelCatalog` does.
    let release!: () => void;
    const installGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { host } = buildHost(
      {},
      {
        resolveConnection: async () => {
          await installGate;
          return { accessToken: 'sk-or-v1-key' };
        },
      },
    );
    const runtime = createOpenRouterRuntime(host);

    const starting = runtime.start(settings);
    let statusSettled = false;
    const status = runtime.getAuthStatus().then((value) => {
      statusSettled = true;
      return value;
    });
    let presenceSettled = false;
    const presence = runtime.getAuthPresence?.().then((value) => {
      presenceSettled = true;
      return value;
    });

    // Flush microtasks; the install is deliberately still gated, so neither
    // read may have answered yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(statusSettled).toBe(false);
    expect(presenceSettled).toBe(false);

    release();
    await starting;
    await expect(status).resolves.toMatchObject({ isAuthenticated: true });
    await expect(presence).resolves.toEqual({ present: true });
  });

  it('reports signed out when no key is resolved', async () => {
    const { host } = buildHost({});
    const runtime = createOpenRouterRuntime(host);

    await runtime.start(settings);

    await expect(runtime.getAuthStatus()).resolves.toMatchObject({ isAuthenticated: false });
    await expect(runtime.getAuthPresence?.()).resolves.toEqual({ present: false });
  });

  it('clears auth after stop', async () => {
    const { host } = buildHost({ accessToken: 'k' });
    const runtime = createOpenRouterRuntime(host);
    await runtime.start(settings);

    await runtime.stop();

    await expect(runtime.getAuthPresence?.()).resolves.toEqual({ present: false });
  });

  it('recycles on refresh and re-installs', async () => {
    const { host, installed } = buildHost({ accessToken: 'k' });
    const runtime = createOpenRouterRuntime(host);
    await runtime.start(settings);

    await runtime.refresh(settings);

    expect(installed).toHaveLength(2);
  });
});
