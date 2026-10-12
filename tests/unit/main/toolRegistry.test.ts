import { describe, expect, it, vi } from 'vitest';
import {
  type NestedToolCallObserver,
  type ToolLoadFailure,
  type ToolModuleLoaders,
  buildToolRegistry,
  discoverToolLoaders,
  MAX_NESTED_TOOL_DEPTH,
} from '../../../src/main/tools/registry';
import {
  type AemToolExecutor,
  type JsonValue,
  type ToolHost,
  type ToolHostServices,
  type ToolModule,
  newChatId,
  newServerId,
  newToolCallId,
  newTurnId,
} from '../../../src/shared';
import { createCountingIdGenerator } from '../../support/testIds';

const ids = createCountingIdGenerator('reg');
const host: ToolHostServices = {
  bridge: { request: () => Promise.resolve({ kind: 'cancelled' }) },
  currentContext: () => ({
    origin: 'https://aem.example.com',
    serverId: newServerId(ids),
    serverRevision: 0,
    navigationEpoch: 0,
    chatId: newChatId(ids),
    turnId: newTurnId(ids),
  }),
  environmentFacts: () => undefined,
  configuredHosts: () => [],
  openPage: () => Promise.resolve({ kind: 'no_view' }),
  requestUserInput: () => Promise.resolve({ selections: [], freeform: null }),
  clock: () => 1,
  idGenerator: ids,
};

function fakeTool(name: string, overrides: Partial<ToolModule> = {}): ToolModule {
  return {
    name,
    descriptor: {
      name,
      description: `${name} description`,
      parameters: { type: 'object', properties: {} },
    },
    allowlistEntry: `custom:${name}`,
    instructions: `Use '${name}' for its purpose.`,
    createExecutor: () => () => Promise.resolve({ ok: true, value: {} }),
    ...overrides,
  };
}

function loaders(entries: Record<string, () => Promise<unknown>>): ToolModuleLoaders {
  return entries;
}

describe('buildToolRegistry', () => {
  it('registers every enabled tool, in a deterministic order', async () => {
    const registry = await buildToolRegistry({
      host,
      loaders: loaders({
        '/tools/b/tool.ts': () => Promise.resolve({ tool: fakeTool('tool_b') }),
        '/tools/a/tool.ts': () => Promise.resolve({ tool: fakeTool('tool_a') }),
      }),
    });

    expect(registry.enabledNames).toEqual(['tool_a', 'tool_b']);
    expect(registry.allowlistEntries).toEqual(['custom:tool_a', 'custom:tool_b']);
    expect(registry.descriptors.map((d) => d.name)).toEqual(['tool_a', 'tool_b']);
    expect(Object.keys(registry.toolHandlers)).toEqual(['tool_a', 'tool_b']);
    expect(registry.instructions).toContain("'tool_a'");
    expect(registry.instructions).toContain("'tool_b'");
    expect(registry.failures).toEqual([]);
  });

  it('leaves a disabled tool out of the handlers, allowlist, descriptors and instructions', async () => {
    const registry = await buildToolRegistry({
      host,
      loaders: loaders({
        '/tools/a/tool.ts': () => Promise.resolve({ tool: fakeTool('tool_a') }),
        '/tools/off/tool.ts': () =>
          Promise.resolve({ tool: fakeTool('tool_off', { disabled: true }) }),
      }),
    });

    expect(registry.enabledNames).toEqual(['tool_a']);
    expect(registry.disabledNames).toEqual(['tool_off']);
    expect(registry.allowlistEntries).toEqual(['custom:tool_a']);
    expect(registry.instructions).not.toContain('tool_off');
    expect(registry.failures).toEqual([]);
  });

  it('never calls createExecutor for a disabled tool', async () => {
    const createExecutor = vi.fn(() => () => Promise.resolve({ ok: true as const, value: {} }));
    await buildToolRegistry({
      host,
      loaders: loaders({
        '/tools/off/tool.ts': () =>
          Promise.resolve({ tool: fakeTool('tool_off', { disabled: true, createExecutor }) }),
      }),
    });
    expect(createExecutor).not.toHaveBeenCalled();
  });

  it('isolates each failure kind and keeps the healthy tool', async () => {
    const seen: ToolLoadFailure[] = [];
    const registry = await buildToolRegistry({
      host,
      onFailure: (f) => seen.push(f),
      loaders: loaders({
        '/tools/1-load/tool.ts': () => Promise.reject(new Error('boom on import')),
        '/tools/2-shape/tool.ts': () => Promise.resolve({ tool: { name: 'half' } }),
        '/tools/3-no-export/tool.ts': () => Promise.resolve({}),
        '/tools/4-mismatch/tool.ts': () =>
          Promise.resolve({ tool: fakeTool('tool_m', { allowlistEntry: 'custom:other' }) }),
        '/tools/5-factory/tool.ts': () =>
          Promise.resolve({
            tool: fakeTool('tool_f', {
              createExecutor: () => {
                throw new Error('factory exploded');
              },
            }),
          }),
        '/tools/6-good/tool.ts': () => Promise.resolve({ tool: fakeTool('tool_good') }),
      }),
    });

    expect(registry.enabledNames).toEqual(['tool_good']);
    expect(registry.failures.map((f) => f.source)).toEqual([
      '/tools/1-load/tool.ts',
      '/tools/2-shape/tool.ts',
      '/tools/3-no-export/tool.ts',
      '/tools/4-mismatch/tool.ts',
      '/tools/5-factory/tool.ts',
    ]);
    expect(registry.failures[0]?.reason).toMatch(/boom on import/);
    expect(registry.failures[4]?.reason).toMatch(/factory exploded/);
    expect(seen).toEqual(registry.failures);
    expect(registry.allowlistEntries).toEqual(['custom:tool_good']);
    expect(registry.instructions).not.toContain('tool_f');
  });

  it('rejects the second of two tools claiming the same name', async () => {
    const registry = await buildToolRegistry({
      host,
      loaders: loaders({
        '/tools/a/tool.ts': () => Promise.resolve({ tool: fakeTool('same') }),
        '/tools/b/tool.ts': () => Promise.resolve({ tool: fakeTool('same') }),
      }),
    });

    expect(registry.enabledNames).toEqual(['same']);
    expect(registry.failures).toHaveLength(1);
    expect(registry.failures[0]?.reason).toMatch(/Duplicate tool name 'same'/);
  });

  it('with no tools still yields a valid, tool-free registry', async () => {
    const registry = await buildToolRegistry({ host, loaders: {} });
    expect(registry.enabledNames).toEqual([]);
    expect(registry.allowlistEntries).toEqual([]);
    expect(registry.instructions).toMatch(/read-only assistant/);
  });

  it('rejects a manifest whose uses is not a string list', async () => {
    const registry = await buildToolRegistry({
      host,
      loaders: loaders({
        '/tools/a/tool.ts': () => Promise.resolve({ tool: { ...fakeTool('tool_a'), uses: [1] } }),
      }),
    });
    expect(registry.enabledNames).toEqual([]);
    expect(registry.failures).toHaveLength(1);
  });

  it('reports a declared dependency that is not enabled, but keeps the tool', async () => {
    const registry = await buildToolRegistry({
      host,
      loaders: loaders({
        '/tools/a/tool.ts': () =>
          Promise.resolve({ tool: fakeTool('tool_a', { uses: ['tool_off', 'tool_gone'] }) }),
        '/tools/off/tool.ts': () =>
          Promise.resolve({ tool: fakeTool('tool_off', { disabled: true }) }),
      }),
    });
    expect(registry.enabledNames).toEqual(['tool_a']);
    expect(registry.failures.map((f) => f.reason)).toEqual([
      "Declared dependency 'tool_off' is not an enabled tool",
      "Declared dependency 'tool_gone' is not an enabled tool",
    ]);
  });
});

describe('ToolHost.invokeTool (the tool-to-tool bridge)', () => {
  /** Builds a registry whose `caller` captures its host, plus the given callees. */
  async function setUp(params: {
    readonly uses: readonly string[];
    readonly callees?: Readonly<Record<string, AemToolExecutor>>;
    readonly disabled?: readonly string[];
    readonly nestedCalls?: NestedToolCallObserver;
  }): Promise<ToolHost> {
    let captured: ToolHost | undefined;
    const entries: Record<string, () => Promise<unknown>> = {
      // Sorts after the callees' 'b-' prefix is irrelevant: handlers resolve lazily.
      '/tools/a-caller/tool.ts': () =>
        Promise.resolve({
          tool: fakeTool('caller', {
            uses: params.uses,
            createExecutor: (toolHost) => {
              captured = toolHost;
              return () => Promise.resolve({ ok: true, value: {} });
            },
          }),
        }),
    };
    for (const [name, executor] of Object.entries(params.callees ?? {})) {
      entries[`/tools/b-${name}/tool.ts`] = () =>
        Promise.resolve({
          tool: fakeTool(name, {
            createExecutor: () => executor,
            ...(params.disabled?.includes(name) === true ? { disabled: true } : {}),
          }),
        });
    }
    await buildToolRegistry({
      host,
      loaders: loaders(entries),
      ...(params.nestedCalls === undefined ? {} : { nestedCalls: params.nestedCalls }),
    });
    if (captured === undefined) throw new Error('caller was not constructed');
    return captured;
  }

  const parent = (): { toolCallId: ReturnType<typeof newToolCallId>; signal: undefined } => ({
    toolCallId: newToolCallId(ids),
    signal: undefined,
  });

  it('runs a declared, enabled tool registered after the caller and returns its result', async () => {
    const callee = vi.fn<AemToolExecutor>(() =>
      Promise.resolve({ ok: true, value: { echoed: true } }),
    );
    const toolHost = await setUp({ uses: ['callee'], callees: { callee } });

    const result = await toolHost.invokeTool('callee', { a: 1 }, parent());

    expect(result).toEqual({ ok: true, value: { echoed: true } });
    expect(callee).toHaveBeenCalledTimes(1);
    expect(callee.mock.calls[0]?.[0]).toEqual({ a: 1 });
  });

  it('passes the parent abort signal through and mints a fresh tool-call id', async () => {
    const callee = vi.fn<AemToolExecutor>(() => Promise.resolve({ ok: true, value: null }));
    const toolHost = await setUp({ uses: ['callee'], callees: { callee } });
    const controller = new AbortController();
    const parentId = newToolCallId(ids);

    await toolHost.invokeTool('callee', {}, { toolCallId: parentId, signal: controller.signal });

    const context = callee.mock.calls[0]?.[1];
    expect(context?.signal).toBe(controller.signal);
    expect(context?.toolCallId).not.toBe(parentId);
  });

  it('refuses a tool missing from the caller uses list, without running it', async () => {
    const callee = vi.fn<AemToolExecutor>(() => Promise.resolve({ ok: true, value: null }));
    const toolHost = await setUp({ uses: [], callees: { callee } });

    const result = await toolHost.invokeTool('callee', {}, parent());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ACCESS_DENIED');
    expect(callee).not.toHaveBeenCalled();
  });

  it('refuses a self-call even when the tool lists itself', async () => {
    const toolHost = await setUp({ uses: ['caller'] });
    const result = await toolHost.invokeTool('caller', {}, parent());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ACCESS_DENIED');
  });

  it('answers NOT_FOUND for a declared tool that is disabled or absent', async () => {
    const callee = vi.fn<AemToolExecutor>(() => Promise.resolve({ ok: true, value: null }));
    const toolHost = await setUp({
      uses: ['callee', 'absent'],
      callees: { callee },
      disabled: ['callee'],
    });

    for (const name of ['callee', 'absent']) {
      const result = await toolHost.invokeTool(name, {}, parent());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    }
    expect(callee).not.toHaveBeenCalled();
  });

  it('turns a throwing callee into a structured error', async () => {
    const callee: AemToolExecutor = () => Promise.reject(new Error('kaboom'));
    const toolHost = await setUp({ uses: ['callee'], callees: { callee } });
    const result = await toolHost.invokeTool('callee', {}, parent());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNEXPECTED_RESPONSE');
      expect(result.error.message).toMatch(/kaboom/);
    }
  });

  it('limits nesting depth', async () => {
    // A chain: caller -> link -> link -> ... Each link calls itself through a
    // second name so the self-call guard does not trip first.
    let pingHost: ToolHost | undefined;
    let pongHost: ToolHost | undefined;
    const depthsReached: number[] = [];
    let depth = 0;
    const relay =
      (getHost: () => ToolHost | undefined, next: string): AemToolExecutor =>
      async (_args, context) => {
        depth += 1;
        depthsReached.push(depth);
        const result = await getHost()!.invokeTool(next, {}, context);
        depth -= 1;
        return result.ok ? result : { ok: true, value: { stoppedBy: result.error.code } };
      };
    await buildToolRegistry({
      host,
      loaders: loaders({
        '/tools/ping/tool.ts': () =>
          Promise.resolve({
            tool: fakeTool('ping', {
              uses: ['pong'],
              createExecutor: (h) => {
                pingHost = h;
                return relay(() => pingHost, 'pong');
              },
            }),
          }),
        '/tools/pong/tool.ts': () =>
          Promise.resolve({
            tool: fakeTool('pong', {
              uses: ['ping'],
              createExecutor: (h) => {
                pongHost = h;
                return relay(() => pongHost, 'ping');
              },
            }),
          }),
      }),
    });

    const result = await pingHost!.invokeTool('pong', {}, parent());

    expect(result).toEqual({ ok: true, value: { stoppedBy: 'ACCESS_DENIED' } });
    expect(Math.max(...depthsReached)).toBe(MAX_NESTED_TOOL_DEPTH);
  });

  it('tells the observer about a call that ran, in order, with its outcome', async () => {
    const seen: Array<{ phase: string; toolName?: string; outcome?: JsonValue }> = [];
    const callee: AemToolExecutor = () => Promise.resolve({ ok: true, value: { n: 2 } });
    const toolHost = await setUp({
      uses: ['callee'],
      callees: { callee },
      nestedCalls: {
        onCallStarted: (call) => seen.push({ phase: 'started', toolName: call.toolName }),
        onCallSettled: (call, outcome) =>
          seen.push({
            phase: 'settled',
            toolName: call.toolName,
            outcome: outcome.ok ? outcome.value : null,
          }),
      },
    });

    await toolHost.invokeTool('callee', { x: 'y' }, parent());
    await toolHost.invokeTool('not_declared', {}, parent());

    expect(seen).toEqual([
      { phase: 'started', toolName: 'callee' },
      { phase: 'settled', toolName: 'callee', outcome: { n: 2 } },
    ]);
  });
});

describe('discovered tools (the real src/tools folders)', () => {
  it('enables exactly the shipped read tools and leaves aem_create_page disabled', async () => {
    const registry = await buildToolRegistry({ host, loaders: discoverToolLoaders() });

    expect(registry.failures).toEqual([]);
    expect([...registry.enabledNames].sort()).toEqual([
      'aem_get_json',
      'aem_query',
      'aem_query_format_ask',
      'ask_user',
      'browser_navigate',
      'environment_facts',
      'format_table',
    ]);
    expect(registry.disabledNames).toEqual(['aem_create_page']);
    expect([...registry.allowlistEntries].sort()).toEqual([
      'custom:aem_get_json',
      'custom:aem_query',
      'custom:aem_query_format_ask',
      'custom:ask_user',
      'custom:browser_navigate',
      'custom:environment_facts',
      'custom:format_table',
    ]);
  });
});
