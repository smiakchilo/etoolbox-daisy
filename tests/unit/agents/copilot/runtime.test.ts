import { describe, expect, it, vi } from 'vitest';
import type { AgentHost, ModelUsageBody } from '../../../../src/shared';
import {
  describeAgentOneShotConformance,
  ONE_SHOT_REQUEST,
} from '../../../support/agentOneShotConformance';

/**
 * The Copilot secondary-turn call (`complete`): a fresh, tools-disabled session on
 * the shared client and one `sendAndWait`. The session is a double, so this proves
 * the wiring, not the SDK (a live run proves the concurrency).
 */

interface SessionDouble {
  sendAndWait: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  rpc: { options: { update: ReturnType<typeof vi.fn> } };
}

interface ClientDouble {
  createSession: ReturnType<typeof vi.fn>;
  resumeSession: ReturnType<typeof vi.fn>;
  deleteSession: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted(() => ({
  client: undefined as object | undefined,
}));

vi.mock('../../../../src/agents/copilot/runtimeManager', () => ({
  createCopilotRuntimeManager: () => ({
    getClient: () => state.client,
    whenReady: () => Promise.resolve(),
    start: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  }),
}));

import { createCopilotRuntime } from '../../../../src/agents/copilot/runtime';

function makeSession(
  reply: string | undefined,
  usage: readonly Record<string, unknown>[] = [],
  fails = false,
): SessionDouble {
  const listeners = new Set<(event: unknown) => void>();
  return {
    // The model calls the session reports while it answers.
    sendAndWait: vi.fn(() => {
      for (const data of usage) {
        for (const listener of listeners) listener({ type: 'assistant.usage', data });
      }
      if (fails) return Promise.reject(new Error('provider error'));
      return Promise.resolve(reply === undefined ? undefined : { data: { content: reply } });
    }),
    on: vi.fn((listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    abort: vi.fn(() => Promise.resolve()),
    disconnect: vi.fn(() => Promise.resolve()),
    rpc: { options: { update: vi.fn(() => Promise.resolve({ success: true })) } },
  };
}

function makeClient(session: SessionDouble): ClientDouble {
  return {
    createSession: vi.fn(() => Promise.resolve(session)),
    resumeSession: vi.fn(),
    deleteSession: vi.fn(),
  };
}

function makeHost(): AgentHost {
  return {
    isPackaged: false,
    stateDirectory: 'C:\\agents\\copilot',
    resolveConnection: () => Promise.resolve({}),
    createProxyFetch: () => globalThis.fetch,
    installService: () => Promise.resolve(),
    toolkit: () => ({
      allowlistEntries: [],
      instructions: '',
      toolHandlers: {},
      toolDescriptors: [],
      bundledSkillDirectories: [],
    }),
    modelPreferences: () => ({ model: 'mai-code-1.1-flash', reasoningEffort: 'low' }),
    resolveAddonFile: () => Promise.resolve({ ok: false, error: { message: 'not installed' } }),
  };
}

type AddonOutcome = Awaited<ReturnType<AgentHost['resolveAddonFile']>>;

describe('createCopilotRuntime login', () => {
  it('reports the CLI add-on download as sign-in progress', async () => {
    const reportAuthProgress = vi.fn();
    const host: AgentHost = {
      ...makeHost(),
      reportAuthProgress,
      resolveAddonFile: (_id, _file, options) => {
        options?.onProgress?.(0.4);
        return Promise.resolve({ ok: false, error: { message: 'the download failed' } });
      },
    };
    const runtime = createCopilotRuntime(host);

    await expect(runtime.login?.(undefined)).resolves.toEqual({
      status: 'failed',
      message: 'the download failed',
    });
    expect(reportAuthProgress).toHaveBeenCalledWith('copilot', 'Downloading sign-in component 40%');
  });

  it('reports a failed sign-in, never throwing, when the add-on is unavailable', async () => {
    const runtime = createCopilotRuntime(makeHost());

    await expect(runtime.login?.(undefined)).resolves.toEqual({
      status: 'failed',
      message: 'not installed',
    });
  });

  it('rejects a second sign-in while the component is still downloading', async () => {
    let settle: ((outcome: AddonOutcome) => void) | undefined;
    let downloads = 0;
    const host: AgentHost = {
      ...makeHost(),
      resolveAddonFile: () => {
        downloads += 1;
        if (downloads > 1) return Promise.resolve({ ok: false, error: { message: 'no cli' } });
        return new Promise<AddonOutcome>((resolve) => {
          settle = resolve;
        });
      },
    };
    const runtime = createCopilotRuntime(host);

    const first = runtime.login?.(undefined);
    await expect(runtime.login?.(undefined)).resolves.toEqual({
      status: 'failed',
      message: 'A login is already in progress',
    });

    settle?.({ ok: false, error: { message: 'the download failed' } });
    await expect(first).resolves.toEqual({ status: 'failed', message: 'the download failed' });

    // The claim is released once the first attempt settles, so a later click is
    // not refused for ever.
    await expect(runtime.login?.(undefined)).resolves.toEqual({
      status: 'failed',
      message: 'no cli',
    });
  });

  it('aborts the component download when the sign-in is cancelled', async () => {
    let downloadSignal: AbortSignal | undefined;
    const host: AgentHost = {
      ...makeHost(),
      resolveAddonFile: (_id, _file, options) =>
        new Promise<AddonOutcome>((resolve) => {
          const signal = options?.signal;
          downloadSignal = signal;
          signal?.addEventListener(
            'abort',
            () => resolve({ ok: false, error: { message: 'cancelled' } }),
            { once: true },
          );
        }),
    };
    const runtime = createCopilotRuntime(host);

    const attempt = runtime.login?.(undefined);
    // The download is requested synchronously, so the signal is already known.
    expect(downloadSignal?.aborted).toBe(false);

    runtime.cancelLogin?.();

    expect(downloadSignal?.aborted).toBe(true);
    await expect(attempt).resolves.toEqual({ status: 'cancelled' });
  });
});

describe('createCopilotRuntime complete', () => {
  it("runs the caller's prompt and instructions on a fresh, tool-less session, with the chat's model", async () => {
    const session = makeSession('the reply');
    const client = makeClient(session);
    state.client = client;
    const runtime = createCopilotRuntime(makeHost());

    const result = await runtime.complete?.(ONE_SHOT_REQUEST, undefined, () => undefined);

    expect(result).toEqual({ ok: true, value: 'the reply' });
    const config = client.createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config['availableTools']).toEqual([]);
    expect(config['model']).toBe('mai-code-1.1-flash');
    expect(config['reasoningEffort']).toBe('low');
    expect(JSON.stringify(config['systemMessage'])).toContain(ONE_SHOT_REQUEST.instructions);
    expect((session.sendAndWait.mock.calls[0]?.[0] as { prompt: string }).prompt).toBe(
      ONE_SHOT_REQUEST.prompt,
    );
    expect(session.disconnect).toHaveBeenCalledTimes(1);
  });

  it('fails when the model gives no reply, and still closes the session', async () => {
    const session = makeSession(undefined);
    state.client = makeClient(session);
    const runtime = createCopilotRuntime(makeHost());

    const result = await runtime.complete?.(ONE_SHOT_REQUEST, undefined, () => undefined);

    expect(result?.ok).toBe(false);
    expect(session.disconnect).toHaveBeenCalledTimes(1);
  });

  it('creates no session once the turn is aborted', async () => {
    const session = makeSession('x');
    const client = makeClient(session);
    state.client = client;
    const runtime = createCopilotRuntime(makeHost());
    const controller = new AbortController();
    controller.abort();

    const result = await runtime.complete?.(ONE_SHOT_REQUEST, controller.signal, () => undefined);

    expect(result).toEqual({
      ok: false,
      error: { message: 'The call was cancelled', cancelled: true },
    });
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it('stops listening to the throwaway session once the call is over', async () => {
    const session = makeSession('x', [{ inputTokens: 1, outputTokens: 1 }]);
    state.client = makeClient(session);
    const runtime = createCopilotRuntime(makeHost());

    await runtime.complete?.(ONE_SHOT_REQUEST, undefined, () => undefined);

    const unsubscribe = session.on.mock.results[0]?.value as () => boolean;
    expect(unsubscribe()).toBe(false);
  });
});

describeAgentOneShotConformance('copilot', async (scenario) => {
  const session = makeSession(
    scenario.reply,
    [
      {
        model: 'mai-code-1.1-flash',
        inputTokens: scenario.inputTokens,
        outputTokens: scenario.outputTokens,
      },
    ],
    scenario.fails === true,
  );
  const client = makeClient(session);
  state.client = client;
  const runtime = createCopilotRuntime(makeHost());
  const reports: ModelUsageBody[] = [];

  const result = await runtime.complete?.(ONE_SHOT_REQUEST, undefined, (usage) =>
    reports.push(usage),
  );

  const config = client.createSession.mock.calls[0]?.[0] as
    { systemMessage?: { content?: string } } | undefined;
  const sentPrompt = session.sendAndWait.mock.calls[0]?.[0] as { prompt: string } | undefined;
  return {
    result: result ?? { ok: false, error: { message: 'no complete' } },
    reports,
    sent: {
      instructions: config?.systemMessage?.content ?? '',
      prompt: sentPrompt?.prompt ?? '',
    },
  };
});
