import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OpenRouterCall,
  OpenRouterCallRequest,
  OpenRouterClient,
} from '../../../../src/agents/openrouter/types';
import { AUTO_MODEL } from '../../../../src/agents/openrouter/agentService';
import { createOpenRouterRuntime } from '../../../../src/agents/openrouter/runtime';
import {
  defaultAppSettings,
  type AgentConnection,
  type AgentHost,
  type AgentService,
} from '../../../../src/shared';

const clients = vi.hoisted(() => ({ current: undefined as OpenRouterClient | undefined }));

vi.mock('../../../../src/agents/openrouter/client', () => ({
  createOpenRouterClient: () => clients.current,
}));

function fakeClient(
  text: string,
  calls: OpenRouterCallRequest[],
  hasApiKey = true,
): OpenRouterClient {
  return {
    hasApiKey,
    createConversationState: () => ({}),
    callModel: (request) => {
      calls.push(request);
      const call: OpenRouterCall = {
        getTextStream: async function* () {
          await Promise.resolve();
          yield text;
        },
        getReasoningStream: async function* () {
          // no reasoning in the answer test
        },
        getResponse: () => Promise.resolve({}),
      };
      return call;
    },
    listModels: () => Promise.resolve([]),
  };
}

beforeEach(() => {
  clients.current = fakeClient('{"matches":[]}', []);
});

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

  it('answers with one fresh, tools-disabled call and returns a verdict per item', async () => {
    const calls: OpenRouterCallRequest[] = [];
    clients.current = fakeClient('{"matches":[2]}', calls);
    const { host } = buildHost({ accessToken: 'k' });
    const runtime = createOpenRouterRuntime(host);
    await runtime.start(settings);

    const result = await runtime.answer?.(
      {
        instruction: 'Waldo is good',
        items: [
          { id: '1', text: 'a bad Waldo' },
          { id: '2', text: 'a good Waldo' },
        ],
      },
      undefined,
    );

    expect(result).toEqual({
      ok: true,
      value: [
        { id: '1', match: false },
        { id: '2', match: true },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: AUTO_MODEL,
      tools: [],
      allowFinalResponse: true,
      reasoningEffort: null,
    });
    expect(calls[0]?.input).toContain('Waldo is good');
    expect(calls[0]?.input).toContain('[2] a good Waldo');
  });

  it('refuses to answer without a stored API key', async () => {
    clients.current = fakeClient('{"matches":[]}', [], false);
    const { host } = buildHost({});
    const runtime = createOpenRouterRuntime(host);
    await runtime.start(settings);

    const result = await runtime.answer?.({ instruction: 'x', items: [] }, undefined);

    expect(result?.ok).toBe(false);
  });

  it('does not answer once the turn is aborted', async () => {
    const calls: OpenRouterCallRequest[] = [];
    clients.current = fakeClient('{"matches":[]}', calls);
    const { host } = buildHost({ accessToken: 'k' });
    const runtime = createOpenRouterRuntime(host);
    await runtime.start(settings);
    const controller = new AbortController();
    controller.abort();

    const result = await runtime.answer?.({ instruction: 'x', items: [] }, controller.signal);

    expect(result).toEqual({
      ok: false,
      error: { message: 'The answer call was cancelled', cancelled: true },
    });
    expect(calls).toEqual([]);
  });
});
