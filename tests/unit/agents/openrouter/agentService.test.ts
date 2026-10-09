import { describe, expect, it } from 'vitest';
import {
  AUTO_MODEL,
  createOpenRouterAgentService,
} from '../../../../src/agents/openrouter/agentService';
import type {
  OpenRouterCall,
  OpenRouterCallRequest,
  OpenRouterClient,
  RunTool,
  ToolSpec,
} from '../../../../src/agents/openrouter/types';
import {
  chatIdSchema,
  createToolError,
  err,
  newRequestId,
  ok,
  turnIdSchema,
  type AgentEvent,
  type AuthStatus,
} from '../../../../src/shared';

/**
 * Event-mapping tests for the OpenRouter adapter, driven by a fake
 * `OpenRouterClient` (and an injected `buildTools`) so the SDK is never loaded.
 * The fake `callModel` lets a test run a tool through the captured `runTool`,
 * exactly as the real SDK's auto-execution loop would.
 */

const CHAT = chatIdSchema.parse('chat-1');
const TURN = turnIdSchema.parse('turn-1');
const OTHER_CHAT = chatIdSchema.parse('chat-2');

const SIGNED_IN: AuthStatus = { apiVersion: 1, isAuthenticated: true };

function idGenerator(): () => string {
  let n = 0;
  return () => `id-${(n += 1)}`;
}

interface FakeScript {
  readonly text?: readonly string[];
  readonly reasoning?: readonly string[];
  /** Invoked while `getResponse` is pending - where the SDK would run tools. */
  readonly duringResponse?: () => Promise<void> | void;
  readonly fail?: boolean;
  /** Keep `getResponse` pending until `signal` aborts, mirroring a live request. */
  readonly hangUntilAbort?: boolean;
}

function createFakeClient(script: FakeScript, hasApiKey = true): OpenRouterClient {
  return {
    hasApiKey,
    createConversationState: () => ({ fake: true }),
    callModel(request: OpenRouterCallRequest): OpenRouterCall {
      return {
        getTextStream: async function* () {
          await Promise.resolve();
          for (const delta of script.text ?? []) yield delta;
        },
        getReasoningStream: async function* () {
          await Promise.resolve();
          for (const delta of script.reasoning ?? []) yield delta;
        },
        getResponse: () =>
          new Promise((resolve, reject) => {
            if (script.hangUntilAbort) {
              request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
                once: true,
              });
              return;
            }
            Promise.resolve(script.duringResponse?.()).then(
              () => (script.fail === true ? reject(new Error('boom')) : resolve({})),
              reject,
            );
          }),
      };
    },
    listModels: () => Promise.resolve([]),
  };
}

const TOOL_SPEC: ToolSpec = {
  name: 'aem_get_json',
  description: 'read',
  parameters: { type: 'object', properties: {} },
  executor: () => Promise.resolve(ok({ textResultForLlm: 'ok', resultType: 'success' })),
};

function build(options: {
  client: OpenRouterClient;
  buildTools: (runTool: RunTool) => readonly unknown[];
  authStatus?: AuthStatus;
  modelPreferences?: () => { model: string | null; reasoningEffort: string | null };
}) {
  return createOpenRouterAgentService({
    client: options.client,
    authStatus: options.authStatus ?? SIGNED_IN,
    instructions: 'You are a read-only AEM assistant.',
    buildTools: options.buildTools,
    ...(options.modelPreferences !== undefined
      ? { modelPreferences: options.modelPreferences }
      : {}),
    idGenerator: idGenerator(),
  });
}

function collect(service: {
  onEvent: (listener: (event: AgentEvent) => void) => () => void;
}): AgentEvent[] {
  const events: AgentEvent[] = [];
  service.onEvent((event) => events.push(event));
  return events;
}

const eventTypes = (events: readonly AgentEvent[]): string[] => events.map((event) => event.type);
const finalState = (events: readonly AgentEvent[]): string | undefined => {
  const last = events.at(-1);
  return last?.type === 'session.state.changed' ? last.state : undefined;
};

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/**
 * Waits for a detached turn to reach its terminal `session.state.changed`
 * (`idle`/`error`/`closed`). `sendPrompt` now returns as soon as the turn is
 * accepted (matching the Copilot adapter), so a test that wants to assert the
 * whole event list must let the run actually finish first.
 */
async function awaitTurnEnd(events: readonly AgentEvent[]): Promise<void> {
  for (let i = 0; i < 128; i += 1) {
    const last = events.at(-1);
    if (
      last?.type === 'session.state.changed' &&
      (last.state === 'idle' || last.state === 'error' || last.state === 'closed')
    ) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('the turn never reached a terminal state');
}

describe('createOpenRouterAgentService', () => {
  it('refuses to send without an API key', async () => {
    const service = build({ client: createFakeClient({}, false), buildTools: () => [] });
    await service.initialize();
    await service.openConversation({ chatId: CHAT });

    const result = await service.sendPrompt({ chatId: CHAT, turnId: TURN, prompt: 'hi' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.requiredAction).toBe('sign_in_to_agent');
  });

  it('maps a plain text turn to started/deltas/completed then idle', async () => {
    const service = build({
      client: createFakeClient({ text: ['Hello', ' world'] }),
      buildTools: () => [],
    });
    const events = collect(service);
    await service.initialize();
    await service.openConversation({ chatId: CHAT });

    const result = await service.sendPrompt({ chatId: CHAT, turnId: TURN, prompt: 'hi' });
    expect(result.ok).toBe(true);
    await awaitTurnEnd(events);
    expect(eventTypes(events)).toEqual([
      'session.state.changed',
      'assistant.message.started',
      'assistant.text.delta',
      'assistant.text.delta',
      'assistant.message.completed',
      'session.state.changed',
    ]);
    const completed = events.find((e) => e.type === 'assistant.message.completed');
    expect(completed?.type === 'assistant.message.completed' ? completed.content : undefined).toBe(
      'Hello world',
    );
    expect(finalState(events)).toBe('idle');
  });

  it('emits requested/approved/result for a tool-only turn', async () => {
    let runTool: RunTool | undefined;
    const service = build({
      client: createFakeClient({
        duringResponse: async () => {
          await runTool?.(TOOL_SPEC, { path: '/content/x' }, { callId: 'call_1' });
        },
      }),
      buildTools: (rt) => {
        runTool = rt;
        return [];
      },
    });
    const events = collect(service);
    await service.initialize();
    await service.openConversation({ chatId: CHAT });

    await service.sendPrompt({ chatId: CHAT, turnId: TURN, prompt: 'read it' });
    await awaitTurnEnd(events);
    expect(eventTypes(events)).toEqual([
      'session.state.changed',
      'tool.call.requested',
      'tool.call.approved',
      'tool.result',
      'session.state.changed',
    ]);
    const requested = events.find((e) => e.type === 'tool.call.requested');
    expect(requested?.type === 'tool.call.requested' ? requested.toolName : undefined).toBe(
      'aem_get_json',
    );
    expect(finalState(events)).toBe('idle');
  });

  it('emits user.input.requested carrying actions for a pending question', async () => {
    let question: Promise<unknown> | undefined;
    const service = build({
      client: createFakeClient({
        duringResponse: () => {
          question = service.requestUserInput(CHAT, {
            actions: ['Load more'],
            multiple: false,
            freeInput: false,
          });
        },
      }),
      buildTools: () => [],
    });
    const events = collect(service);
    await service.initialize();
    await service.openConversation({ chatId: CHAT });
    await service.sendPrompt({ chatId: CHAT, turnId: TURN, prompt: 'more?' });

    for (let i = 0; i < 64 && !events.some((e) => e.type === 'user.input.requested'); i += 1) {
      await Promise.resolve();
    }
    const requested = events.find((e) => e.type === 'user.input.requested');
    expect(requested).toMatchObject({
      type: 'user.input.requested',
      actions: ['Load more'],
      multiple: false,
      freeInput: false,
    });
    if (requested?.type !== 'user.input.requested') throw new Error('no question emitted');
    expect(requested.question).toBeUndefined();

    await service.respondToInput(CHAT, requested.requestId, {
      selections: ['Load more'],
      freeform: null,
    });
    await question;
    await awaitTurnEnd(events);
    expect(finalState(events)).toBe('idle');
  });

  it('emits an error event and recovers to idle when the request fails', async () => {
    const service = build({ client: createFakeClient({ fail: true }), buildTools: () => [] });
    const events = collect(service);
    await service.initialize();
    await service.openConversation({ chatId: CHAT });

    const result = await service.sendPrompt({ chatId: CHAT, turnId: TURN, prompt: 'hi' });
    // The turn was accepted; its failure arrives later as an event.
    expect(result.ok).toBe(true);
    await awaitTurnEnd(events);

    expect(eventTypes(events)).toEqual(['session.state.changed', 'error', 'session.state.changed']);
    const error = events.find((event) => event.type === 'error');
    expect(error?.type === 'error' ? error.error.code : undefined).toBe('AGENT_UNAVAILABLE');
    // The adapter recovers the session so the composer is never left disabled.
    expect(finalState(events)).toBe('idle');
  });

  it('refuses a prompt and recovers to idle when callModel throws synchronously', async () => {
    const client: OpenRouterClient = {
      hasApiKey: true,
      createConversationState: () => ({ fake: true }),
      callModel: () => {
        throw new Error('sync boom');
      },
      listModels: () => Promise.resolve([]),
    };
    const service = build({ client, buildTools: () => [] });
    const events = collect(service);
    await service.initialize();
    await service.openConversation({ chatId: CHAT });

    const result = await service.sendPrompt({ chatId: CHAT, turnId: TURN, prompt: 'hi' });
    expect(result.ok).toBe(false);
    expect(eventTypes(events)).toEqual(['session.state.changed', 'error', 'session.state.changed']);
    expect(finalState(events)).toBe('idle');
  });

  it('renders a failed tool outcome for the model and records the error', async () => {
    const failingSpec: ToolSpec = {
      ...TOOL_SPEC,
      executor: () =>
        Promise.resolve(
          err(createToolError('NOT_FOUND', 'no such node', newRequestId(idGenerator()))),
        ),
    };
    let returned: unknown;
    let runTool: RunTool | undefined;
    const service = build({
      client: createFakeClient({
        duringResponse: async () => {
          returned = await runTool?.(failingSpec, {}, { callId: 'call_7' });
        },
      }),
      buildTools: (rt) => {
        runTool = rt;
        return [];
      },
    });
    const events = collect(service);
    await service.initialize();
    await service.openConversation({ chatId: CHAT });
    await service.sendPrompt({ chatId: CHAT, turnId: TURN, prompt: 'go' });
    await awaitTurnEnd(events);

    const result = events.find((e) => e.type === 'tool.result');
    expect(
      result?.type === 'tool.result' && !result.outcome.ok ? result.outcome.error.code : undefined,
    ).toBe('NOT_FOUND');
    expect(returned).toMatchObject({ resultType: 'failure' });
  });

  it('abort emits cancelling then idle and suppresses the failed completion', async () => {
    const service = build({
      client: createFakeClient({ hangUntilAbort: true }),
      buildTools: () => [],
    });
    const events = collect(service);
    await service.initialize();
    await service.openConversation({ chatId: CHAT });

    const pending = service.sendPrompt({ chatId: CHAT, turnId: TURN, prompt: 'hi' });
    await flush();
    await service.abort(CHAT);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(events.map((e) => (e.type === 'session.state.changed' ? e.state : ''))).toEqual([
      'sending',
      'cancelling',
      'idle',
    ]);
  });

  it('refuses a second prompt while a turn is in flight', async () => {
    const service = build({
      client: createFakeClient({ hangUntilAbort: true }),
      buildTools: () => [],
    });
    await service.initialize();
    await service.openConversation({ chatId: CHAT });

    const first = service.sendPrompt({ chatId: CHAT, turnId: TURN, prompt: 'hi' });
    await flush();
    const second = await service.sendPrompt({ chatId: CHAT, turnId: TURN, prompt: 'again' });
    expect(second.ok).toBe(false);
    await service.abort(CHAT);
    await first;
  });

  it('applies the configured model, defaulting (Auto) to openrouter/auto', async () => {
    const requests: OpenRouterCallRequest[] = [];
    const base = createFakeClient({ text: ['x'] });
    const recording: OpenRouterClient = {
      ...base,
      callModel: (request) => {
        requests.push(request);
        return base.callModel(request);
      },
    };
    const service = build({
      client: recording,
      buildTools: () => [],
      modelPreferences: () => ({ model: null, reasoningEffort: null }),
    });
    await service.initialize();
    await service.openConversation({ chatId: CHAT });
    await service.sendPrompt({ chatId: CHAT, turnId: TURN, prompt: 'hi' });

    expect(requests[0]?.model).toBe(AUTO_MODEL);
    expect(requests[0]?.instructions).toContain('read-only');
  });

  it('tears down the previous conversation when a different one opens', async () => {
    const service = build({ client: createFakeClient({ text: ['x'] }), buildTools: () => [] });
    const events = collect(service);
    await service.initialize();
    await service.openConversation({ chatId: CHAT });
    await service.openConversation({ chatId: OTHER_CHAT });

    expect(eventTypes(events)).toEqual(['session.state.changed']);
    const closed = events.at(0);
    expect(closed?.type === 'session.state.changed' ? closed.state : undefined).toBe('closed');
    expect(service.getOpenSessionId()).toBeDefined();
  });

  it('does not throw when disposed mid-turn', async () => {
    const service = build({
      client: createFakeClient({ hangUntilAbort: true }),
      buildTools: () => [],
    });
    await service.initialize();
    await service.openConversation({ chatId: CHAT });
    const pending = service.sendPrompt({ chatId: CHAT, turnId: TURN, prompt: 'hi' });
    await flush();
    await expect(service.dispose()).resolves.toBeUndefined();
    await pending;
  });
});
