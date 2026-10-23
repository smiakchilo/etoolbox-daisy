import { describe, expect, it, vi } from 'vitest';
import type { AgentHost } from '../../../../src/shared';

/**
 * The Copilot answer call: a fresh, tools-disabled session on the shared client,
 * one `sendAndWait`, and the shared prompt/parser. The session is a double, so
 * this proves the wiring, not the SDK (a live run proves the concurrency).
 */

interface SessionDouble {
  sendAndWait: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
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

function makeSession(answer: string | undefined): SessionDouble {
  return {
    sendAndWait: vi.fn(() =>
      Promise.resolve(answer === undefined ? undefined : { data: { content: answer } }),
    ),
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
  };
}

describe('createCopilotRuntime answer', () => {
  it('creates a fresh, tool-less session and parses its verdicts', async () => {
    const session = makeSession('{"matches":[2]}');
    const client = makeClient(session);
    state.client = client;
    const runtime = createCopilotRuntime(makeHost());

    const result = await runtime.answer?.(
      {
        instruction: 'Waldo is good',
        items: [
          { id: '1', text: 'bad Waldo' },
          { id: '2', text: 'good Waldo' },
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
    const config = client.createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config['availableTools']).toEqual([]);
    expect(config['model']).toBe('mai-code-1.1-flash');
    expect(config['reasoningEffort']).toBe('low');
    const prompt = (session.sendAndWait.mock.calls[0]?.[0] as { prompt: string }).prompt;
    expect(prompt).toContain('Waldo is good');
    expect(prompt).toContain('[2] good Waldo');
    expect(session.disconnect).toHaveBeenCalledTimes(1);
  });

  it('returns a failure for an unusable answer, and still closes the session', async () => {
    const session = makeSession('{"matches":[9]}');
    state.client = makeClient(session);
    const runtime = createCopilotRuntime(makeHost());

    const result = await runtime.answer?.(
      { instruction: 'x', items: [{ id: '1', text: 'a' }] },
      undefined,
    );

    expect(result?.ok).toBe(false);
    expect(session.disconnect).toHaveBeenCalledTimes(1);
  });

  it('creates no session once the turn is aborted', async () => {
    const session = makeSession('{"matches":[]}');
    const client = makeClient(session);
    state.client = client;
    const runtime = createCopilotRuntime(makeHost());
    const controller = new AbortController();
    controller.abort();

    const result = await runtime.answer?.({ instruction: 'x', items: [] }, controller.signal);

    expect(result).toEqual({
      ok: false,
      error: { message: 'The answer call was cancelled', cancelled: true },
    });
    expect(client.createSession).not.toHaveBeenCalled();
  });
});
