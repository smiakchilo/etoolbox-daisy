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

function buildHost(connection: AgentConnection): {
  host: AgentHost;
  installed: AgentService[];
  resolveConnection: ReturnType<typeof vi.fn>;
} {
  const installed: AgentService[] = [];
  const resolveConnection = vi.fn(() => Promise.resolve(connection));
  const host: AgentHost = {
    isPackaged: false,
    resolveConnection,
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
