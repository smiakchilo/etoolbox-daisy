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
  type ModelUsageBody,
} from '../../../../src/shared';
import {
  describeAgentOneShotConformance,
  ONE_SHOT_REQUEST,
} from '../../../support/agentOneShotConformance';
import { USAGE_READ_TIMEOUT_MS } from '../../../../src/agents/openrouter/usageDiagnostics';

const clients = vi.hoisted(() => ({ current: undefined as OpenRouterClient | undefined }));

vi.mock('../../../../src/agents/openrouter/client', () => ({
  createOpenRouterClient: () => clients.current,
}));

function fakeClient(
  text: string,
  calls: OpenRouterCallRequest[],
  hasApiKey = true,
  usage?: unknown,
  fails = false,
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
        getResponse: () =>
          fails ? Promise.reject(new Error('provider error')) : Promise.resolve({}),
        // 'never' models an SDK whose accounting does not arrive (an aborted run).
        getUsage: () => (usage === 'never' ? new Promise(() => undefined) : Promise.resolve(usage)),
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

  it("runs the caller's prompt and instructions as one fresh, tools-disabled call and returns the reply", async () => {
    const calls: OpenRouterCallRequest[] = [];
    clients.current = fakeClient('the reply', calls);
    const { host } = buildHost({ accessToken: 'k' });
    const runtime = createOpenRouterRuntime(host);
    await runtime.start(settings);

    const result = await runtime.complete?.(ONE_SHOT_REQUEST, undefined, () => undefined);

    expect(result).toEqual({ ok: true, value: 'the reply' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: AUTO_MODEL,
      tools: [],
      allowFinalResponse: true,
      reasoningEffort: null,
      instructions: ONE_SHOT_REQUEST.instructions,
      input: ONE_SHOT_REQUEST.prompt,
    });
  });

  it('refuses to complete without a stored API key', async () => {
    clients.current = fakeClient('x', [], false);
    const { host } = buildHost({});
    const runtime = createOpenRouterRuntime(host);
    await runtime.start(settings);

    const result = await runtime.complete?.(ONE_SHOT_REQUEST, undefined, () => undefined);

    expect(result?.ok).toBe(false);
  });

  it('does not call the model once the turn is aborted', async () => {
    const calls: OpenRouterCallRequest[] = [];
    clients.current = fakeClient('x', calls);
    const { host } = buildHost({ accessToken: 'k' });
    const runtime = createOpenRouterRuntime(host);
    await runtime.start(settings);
    const controller = new AbortController();
    controller.abort();

    const result = await runtime.complete?.(ONE_SHOT_REQUEST, controller.signal, () => undefined);

    expect(result).toEqual({
      ok: false,
      error: { message: 'The call was cancelled', cancelled: true },
    });
    expect(calls).toEqual([]);
  });

  it('reports the usage of a call whose accounting never arrives as nothing, without hanging', async () => {
    clients.current = fakeClient('x', [], true, 'never');
    const { host } = buildHost({ accessToken: 'k' });
    const runtime = createOpenRouterRuntime(host);
    await runtime.start(settings);
    const reports: ModelUsageBody[] = [];

    vi.useFakeTimers();
    try {
      const pending = runtime.complete?.(ONE_SHOT_REQUEST, undefined, (usage) =>
        reports.push(usage),
      );
      await vi.advanceTimersByTimeAsync(USAGE_READ_TIMEOUT_MS + 1);
      const result = await pending;

      expect(result).toEqual({ ok: true, value: 'x' });
      // Only the wall-clock duration is known; no tokens are invented.
      expect(reports.every((body) => body.inputTokens === undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describeAgentOneShotConformance('openrouter', async (scenario) => {
  const calls: OpenRouterCallRequest[] = [];
  clients.current = fakeClient(
    scenario.reply ?? '',
    calls,
    true,
    {
      inputTokens: scenario.inputTokens,
      outputTokens: scenario.outputTokens,
      totalTokens: scenario.inputTokens + scenario.outputTokens,
      cachedTokens: 0,
      reasoningTokens: 0,
      modelCalls: 1,
    },
    scenario.fails === true,
  );
  const { host } = buildHost({ accessToken: 'k' });
  const runtime = createOpenRouterRuntime(host);
  await runtime.start(settings);
  const reports: ModelUsageBody[] = [];

  const result = await runtime.complete?.(ONE_SHOT_REQUEST, undefined, (usage) =>
    reports.push(usage),
  );

  return {
    result: result ?? { ok: false, error: { message: 'no complete' } },
    reports,
    sent: { instructions: calls[0]?.instructions ?? '', prompt: calls[0]?.input ?? '' },
  };
});
