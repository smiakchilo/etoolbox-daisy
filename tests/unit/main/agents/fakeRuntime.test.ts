import { afterEach, describe, expect, it, vi } from 'vitest';

import { type AgentHost, type AgentService } from '../../../../src/shared';
import { TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY } from '../../../../src/main/agentComposition';
import { createFakeRuntime } from '../../../../src/main/agents/fakeRuntime';

afterEach(() => {
  Reflect.deleteProperty(globalThis, TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY);
});

function host(installService: (service: AgentService) => Promise<void>): AgentHost {
  return {
    isPackaged: false,
    stateDirectory: 'C:\\agents\\fake',
    resolveConnection: () => Promise.resolve({}),
    createProxyFetch: () => {
      throw new Error('not used');
    },
    installService,
    toolkit: () => {
      throw new Error('not used');
    },
    modelPreferences: () => ({ model: null, reasoningEffort: null }),
  };
}

describe('createFakeRuntime', () => {
  it('installs a fake service on start and answers auth from it', async () => {
    const installService = vi.fn<(service: AgentService) => Promise<void>>(() => Promise.resolve());
    const runtime = createFakeRuntime(host(installService));

    await runtime.start(undefined);

    expect(installService).toHaveBeenCalledTimes(1);
    await expect(runtime.getAuthStatus()).resolves.toMatchObject({ isAuthenticated: true });
    await expect(runtime.whenReady()).resolves.toBeUndefined();
  });

  it('answers auth before it has been started', async () => {
    const runtime = createFakeRuntime(host(() => Promise.resolve()));

    await expect(runtime.getAuthStatus()).resolves.toMatchObject({ apiVersion: 1 });
  });

  it('never recycles: reconcile, refresh and stop leave the installed service alone', async () => {
    const installService = vi.fn<(service: AgentService) => Promise<void>>(() => Promise.resolve());
    const runtime = createFakeRuntime(host(installService));
    await runtime.start(undefined);

    await runtime.reconcile(undefined as never);
    await runtime.refresh();
    await runtime.stop();

    expect(installService).toHaveBeenCalledTimes(1);
  });

  it('refuses sign-in and sign-out with a message rather than throwing', async () => {
    const runtime = createFakeRuntime(host(() => Promise.resolve()));

    await expect(runtime.login?.(undefined)).resolves.toMatchObject({ status: 'failed' });
    await expect(runtime.logout?.()).resolves.toHaveProperty('warning');
  });

  it('does not swallow an install failure from start, but whenReady still resolves', async () => {
    const runtime = createFakeRuntime(host(() => Promise.reject(new Error('boom'))));

    await expect(runtime.start(undefined)).rejects.toThrow('boom');
    await expect(runtime.whenReady()).resolves.toBeUndefined();
  });
});
