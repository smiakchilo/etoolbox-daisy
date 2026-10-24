import { describe, expect, it, vi } from 'vitest';
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
  type ModelPreference,
} from '../../../../src/shared';
import {
  type ConformanceUsage,
  conformanceCalls,
  describeAgentDiagnosticsConformance,
} from '../../../support/agentDiagnosticsConformance';
import { USAGE_READ_TIMEOUT_MS } from '../../../../src/agents/openrouter/usageDiagnostics';
import { flushMicrotasks } from '../../../support/asyncWaits';

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
  /** The resolved `getResponse` value; defaults to an empty response. */
  readonly response?: unknown;
  /** The resolved `getUsage` value (the run's aggregate); absent means the SDK reports none. */
  readonly usage?: unknown;
  /** `getUsage` never settles - an aborted run whose accounting does not arrive. */
  readonly usageNever?: boolean;
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
              () =>
                script.fail === true ? reject(new Error('boom')) : resolve(script.response ?? {}),
              reject,
            );
          }),
        getUsage: () =>
          script.usageNever === true ? new Promise(() => undefined) : Promise.resolve(script.usage),
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

const flush = (): Promise<void> => flushMicrotasks(8);

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
      'model.changed',
      'assistant.message.started',
      'assistant.text.delta',
      'assistant.text.delta',
      'model.usage',
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
      'model.changed',
      'tool.call.requested',
      'tool.call.approved',
      'tool.result',
      'model.usage',
      'session.state.changed',
    ]);
    const requested = events.find((e) => e.type === 'tool.call.requested');
    expect(requested?.type === 'tool.call.requested' ? requested.toolName : undefined).toBe(
      'aem_get_json',
    );
    expect(finalState(events)).toBe('idle');
  });

  it('stops the run at a turn-completing tool result, via the predicate handed to the client', async () => {
    let runTool: RunTool | undefined;
    const stops: (boolean | undefined)[] = [];
    const completeSpec: ToolSpec = {
      name: 'aem_query_format_ask',
      description: 'search',
      parameters: { type: 'object', properties: {} },
      executor: () => Promise.resolve(ok({ turnComplete: true })),
    };
    const client: OpenRouterClient = {
      hasApiKey: true,
      createConversationState: () => ({ fake: true }),
      callModel: (request) => ({
        getTextStream: async function* () {},
        getReasoningStream: async function* () {},
        getResponse: async () => {
          stops.push(request.shouldStopTurn?.());
          // An ordinary read: the turn must continue.
          await runTool?.(TOOL_SPEC, { path: '/content/x' }, { callId: 'call_1' });
          stops.push(request.shouldStopTurn?.());
          // The search composite finishing: the turn ends here.
          await runTool?.(completeSpec, { terms: 'waldo' }, { callId: 'call_2' });
          stops.push(request.shouldStopTurn?.());
          return {};
        },
        getUsage: () => Promise.resolve(undefined),
      }),
      listModels: () => Promise.resolve([]),
    };
    const service = build({
      client,
      buildTools: (rt) => {
        runTool = rt;
        return [completeSpec];
      },
    });
    const events = collect(service);
    await service.initialize();
    await service.openConversation({ chatId: CHAT });

    await service.sendPrompt({ chatId: CHAT, turnId: TURN, prompt: 'search' });
    await awaitTurnEnd(events);

    expect(stops).toEqual([false, false, true]);
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

    expect(eventTypes(events)).toEqual([
      'session.state.changed',
      'model.changed',
      'error',
      'session.state.changed',
    ]);
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
    expect(eventTypes(events)).toEqual([
      'session.state.changed',
      'model.changed',
      'error',
      'session.state.changed',
    ]);
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

  it('reports usage from the final response without reading its output', async () => {
    const service = build({
      client: createFakeClient({
        response: {
          model: 'openai/gpt-x-2025',
          output: [{ secret: 'conversation content' }],
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            inputTokensDetails: { cachedTokens: 100 },
            outputTokensDetails: { reasoningTokens: 12 },
            cost: 0.0042,
          },
        },
      }),
      buildTools: () => [],
      modelPreferences: () => ({ model: 'openai/gpt-x', reasoningEffort: 'high' }),
    });
    const events = collect(service);
    await service.initialize();
    await service.openConversation({ chatId: CHAT });
    await service.sendPrompt({ chatId: CHAT, turnId: TURN, prompt: 'hi' });
    await awaitTurnEnd(events);

    const usage = events.find((e) => e.type === 'model.usage');
    expect(usage).toMatchObject({
      type: 'model.usage',
      turnId: TURN,
      model: 'openai/gpt-x-2025',
      reasoningEffort: 'high',
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 100,
      reasoningTokens: 12,
      cost: 0.0042,
    });
    expect(JSON.stringify(usage)).not.toContain('conversation content');
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
      '',
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

describe("createOpenRouterAgentService - a stopped turn's usage", () => {
  const TOTALS = {
    inputTokens: 30,
    outputTokens: 4,
    totalTokens: 34,
    cachedTokens: 0,
    reasoningTokens: 0,
    modelCalls: 2,
  };

  async function stoppedTurn(
    script: FakeScript,
    afterStop: (service: ReturnType<typeof build>) => Promise<void>,
  ) {
    const service = build({
      client: createFakeClient({ hangUntilAbort: true, ...script }),
      buildTools: () => [],
    });
    const events = collect(service);
    await service.initialize();
    await service.openConversation({ chatId: CHAT });
    await service.sendPrompt({ chatId: CHAT, turnId: TURN, prompt: 'hi' });
    await flush();
    await afterStop(service);
    for (let i = 0; i < 64; i += 1) await flush();
    return events;
  }

  it('reports the rounds a Stop interrupted, once, on the turn that made them', async () => {
    const events = await stoppedTurn({ usage: TOTALS }, async (service) => {
      await service.abort(CHAT);
    });

    const usage = events.filter((event) => event.type === 'model.usage');
    expect(usage).toMatchObject([{ turnId: TURN, inputTokens: 30, outputTokens: 4 }]);
    // The Stop's own terminal states are unchanged: no second idle from the stale run.
    expect(
      events.filter((event) => event.type === 'session.state.changed').map((e) => e.state),
    ).toEqual(['sending', 'cancelling', 'idle']);
  });

  it('reports nothing for a chat that was closed under the turn - its journal is gone', async () => {
    const events = await stoppedTurn({ usage: TOTALS }, async (service) => {
      await service.closeConversation(CHAT);
    });

    expect(events.some((event) => event.type === 'model.usage')).toBe(false);
  });

  it('is not held open by an aborted run whose accounting never arrives', async () => {
    vi.useFakeTimers();
    try {
      const service = build({
        client: createFakeClient({ hangUntilAbort: true, usageNever: true }),
        buildTools: () => [],
      });
      const events = collect(service);
      await service.initialize();
      await service.openConversation({ chatId: CHAT });
      await service.sendPrompt({ chatId: CHAT, turnId: TURN, prompt: 'hi' });
      await flush();

      await service.abort(CHAT);
      await vi.advanceTimersByTimeAsync(USAGE_READ_TIMEOUT_MS + 1);

      // The Stop completed at once; the late read gave up without inventing usage.
      expect(finalState(events)).toBe('idle');
      expect(events.some((event) => event.type === 'model.usage')).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
describeAgentDiagnosticsConformance('openrouter', async (initial) => {
  let preference: ModelPreference = initial;
  let response: unknown = {};
  let totals: unknown;
  let failNext = false;
  let hangNext = false;
  const service = build({
    client: createFakeClient({
      get response() {
        return response;
      },
      get usage() {
        return totals;
      },
      get fail() {
        return failNext;
      },
      get hangUntilAbort() {
        return hangNext;
      },
    }),
    buildTools: () => [],
    modelPreferences: () => preference,
  });
  const events = collect(service);
  await service.initialize();
  await service.openConversation({ chatId: CHAT });
  return {
    events,
    chatId: CHAT,
    setPreference: (next) => {
      preference = next;
    },
    runTurn: async (turnId, usage, options) => {
      // The SDK's `getResponse` is only the last round of a tool loop; the whole
      // run's spend is what `getUsage` aggregates, which the adapter must report.
      const calls = conformanceCalls(usage);
      const last = calls.at(-1);
      const sum = (pick: (call: ConformanceUsage) => number): number =>
        calls.reduce((total, call) => total + pick(call), 0);
      const costs = calls.filter((call) => call.cost !== undefined);
      response =
        last === undefined
          ? {}
          : {
              model: last.model,
              usage: { inputTokens: last.inputTokens, outputTokens: last.outputTokens },
            };
      totals =
        calls.length === 0
          ? undefined
          : {
              inputTokens: sum((call) => call.inputTokens),
              outputTokens: sum((call) => call.outputTokens),
              totalTokens: sum((call) => call.inputTokens + call.outputTokens),
              cachedTokens: 0,
              reasoningTokens: 0,
              modelCalls: calls.length,
              ...(costs.length > 0 ? { cost: sum((call) => call.cost ?? 0) } : {}),
            };
      failNext = options?.failAfterUsage === true;
      hangNext = options?.stopAfterUsage === true;
      await service.sendPrompt({ chatId: CHAT, turnId, prompt: 'hi' });
      if (options?.stopAfterUsage === true) {
        // The run is mid-loop when the user stops it; its accounting arrives after.
        await flush();
        await service.abort(CHAT);
        for (let i = 0; i < 64 && !events.some((e) => e.type === 'model.usage'); i += 1) {
          await flush();
        }
        return;
      }
      await awaitTurnEnd(events);
    },
  };
});
