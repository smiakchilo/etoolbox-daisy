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
  type ToolExecutor,
  type InternalToolModule,
  type JsonValue,
  type ModelToolModule,
  type ToolHost,
  type ToolHostServices,
  newChatId,
  newServerId,
  newToolCallId,
  newTurnId,
} from '../../../src/shared';
import { NO_SKILLS } from '../../support/fakeSkillHost';
import { createCountingIdGenerator } from '../../support/testIds';
import { REAL_SESSION_TEMPLATE, MINIMAL_SESSION_TEMPLATE } from '../../support/ruleResources';

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
  skills: NO_SKILLS,
  openPage: () => Promise.resolve({ kind: 'no_view' }),
  requestUserInput: () => Promise.resolve({ selections: [], freeform: null }),
  clock: () => 1,
  idGenerator: ids,
};

function fakeTool(name: string, overrides: Partial<ModelToolModule> = {}): ModelToolModule {
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
      instructionsTemplate: MINIMAL_SESSION_TEMPLATE,
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
      instructionsTemplate: MINIMAL_SESSION_TEMPLATE,
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

  it('keeps an internal tool away from the model but invokable through uses', async () => {
    let captured: ToolHost | undefined;
    const registry = await buildToolRegistry({
      instructionsTemplate: MINIMAL_SESSION_TEMPLATE,
      host,
      loaders: loaders({
        '/tools/a/tool.ts': () =>
          Promise.resolve({
            tool: fakeTool('tool_a', {
              uses: ['tool_hidden'],
              createExecutor: (toolHost) => {
                captured = toolHost;
                return () => Promise.resolve({ ok: true, value: {} });
              },
            }),
          }),
        '/tools/hidden/tool.ts': () =>
          Promise.resolve({
            // An internal tool needs no descriptor, allowlist entry or
            // instructions - only a name and an executor.
            tool: {
              name: 'tool_hidden',
              internal: true,
              createExecutor: () => () => Promise.resolve({ ok: true, value: { hidden: true } }),
            } satisfies InternalToolModule,
          }),
      }),
    });

    expect(registry.enabledNames).toEqual(['tool_a']);
    expect(registry.internalNames).toEqual(['tool_hidden']);
    expect(Object.keys(registry.toolHandlers)).toEqual(['tool_a']);
    expect(registry.descriptors.map((d) => d.name)).toEqual(['tool_a']);
    expect(registry.allowlistEntries).toEqual(['custom:tool_a']);
    expect(registry.instructions).not.toContain('tool_hidden');
    expect(registry.failures).toEqual([]);
    const result = await captured?.invokeTool(
      'tool_hidden',
      {},
      { toolCallId: newToolCallId(ids), signal: undefined },
    );
    expect(result).toEqual({ ok: true, value: { hidden: true } });
  });

  it('rejects a manifest whose internal flag is not a boolean', async () => {
    const registry = await buildToolRegistry({
      instructionsTemplate: MINIMAL_SESSION_TEMPLATE,
      host,
      loaders: loaders({
        '/tools/a/tool.ts': () =>
          Promise.resolve({ tool: { ...fakeTool('tool_a'), internal: 'yes' } }),
      }),
    });
    expect(registry.enabledNames).toEqual([]);
    expect(registry.failures).toHaveLength(1);
  });

  it('never calls createExecutor for a disabled tool', async () => {
    const createExecutor = vi.fn(() => () => Promise.resolve({ ok: true as const, value: {} }));
    await buildToolRegistry({
      instructionsTemplate: MINIMAL_SESSION_TEMPLATE,
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
      instructionsTemplate: MINIMAL_SESSION_TEMPLATE,
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
      instructionsTemplate: MINIMAL_SESSION_TEMPLATE,
      host,
      loaders: loaders({
        '/tools/a/tool.ts': () => Promise.resolve({ tool: fakeTool('same') }),
        '/tools/b/tool.ts': () => Promise.resolve({ tool: fakeTool('same') }),
      }),
    });

    expect(registry.enabledNames).toEqual(['same']);
    expect(registry.failures).toHaveLength(1);
    expect(registry.failures[0]?.reason).toContain('same');
  });

  it('with no tools still yields a valid, tool-free registry', async () => {
    const registry = await buildToolRegistry({
      instructionsTemplate: REAL_SESSION_TEMPLATE,
      host,
      loaders: {},
    });
    expect(registry.enabledNames).toEqual([]);
    expect(registry.allowlistEntries).toEqual([]);
    expect(registry.instructions.trim().length).toBeGreaterThan(0);
  });

  it('rejects a manifest whose uses is not a string list', async () => {
    const registry = await buildToolRegistry({
      instructionsTemplate: MINIMAL_SESSION_TEMPLATE,
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
      instructionsTemplate: MINIMAL_SESSION_TEMPLATE,
      host,
      loaders: loaders({
        '/tools/a/tool.ts': () =>
          Promise.resolve({ tool: fakeTool('tool_a', { uses: ['tool_off', 'tool_gone'] }) }),
        '/tools/off/tool.ts': () =>
          Promise.resolve({ tool: fakeTool('tool_off', { disabled: true }) }),
      }),
    });
    expect(registry.enabledNames).toEqual(['tool_a']);
    expect(registry.failures).toHaveLength(2);
    expect(registry.failures[0]?.reason).toContain('tool_off');
    expect(registry.failures[1]?.reason).toContain('tool_gone');
  });
});

describe('ToolHost.invokeTool (the tool-to-tool bridge)', () => {
  /** Builds a registry whose `caller` captures its host, plus the given callees. */
  async function setUp(params: {
    readonly uses: readonly string[];
    readonly callees?: Readonly<Record<string, ToolExecutor>>;
    readonly disabled?: readonly string[];
    readonly nestedCalls?: NestedToolCallObserver;
    readonly transparent?: boolean;
  }): Promise<ToolHost> {
    let captured: ToolHost | undefined;
    const entries: Record<string, () => Promise<unknown>> = {
      // Sorts after the callees' 'b-' prefix is irrelevant: handlers resolve lazily.
      '/tools/a-caller/tool.ts': () =>
        Promise.resolve({
          tool: fakeTool('caller', {
            uses: params.uses,
            ...(params.transparent === true ? { transparent: true } : {}),
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
      instructionsTemplate: MINIMAL_SESSION_TEMPLATE,
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
    const callee = vi.fn<ToolExecutor>(() =>
      Promise.resolve({ ok: true, value: { echoed: true } }),
    );
    const toolHost = await setUp({ uses: ['callee'], callees: { callee } });

    const result = await toolHost.invokeTool('callee', { a: 1 }, parent());

    expect(result).toEqual({ ok: true, value: { echoed: true } });
    expect(callee).toHaveBeenCalledTimes(1);
    expect(callee.mock.calls[0]?.[0]).toEqual({ a: 1 });
  });

  it('passes the parent abort signal through and mints a fresh tool-call id', async () => {
    const callee = vi.fn<ToolExecutor>(() => Promise.resolve({ ok: true, value: null }));
    const toolHost = await setUp({ uses: ['callee'], callees: { callee } });
    const controller = new AbortController();
    const parentId = newToolCallId(ids);

    await toolHost.invokeTool('callee', {}, { toolCallId: parentId, signal: controller.signal });

    const context = callee.mock.calls[0]?.[1];
    expect(context?.signal).toBe(controller.signal);
    expect(context?.toolCallId).not.toBe(parentId);
    expect(context?.nested).toBe(true);
  });

  it('refuses a tool missing from the caller uses list, without running it', async () => {
    const callee = vi.fn<ToolExecutor>(() => Promise.resolve({ ok: true, value: null }));
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
    const callee = vi.fn<ToolExecutor>(() => Promise.resolve({ ok: true, value: null }));
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
    const callee: ToolExecutor = () => Promise.reject(new Error('kaboom'));
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
      (getHost: () => ToolHost | undefined, next: string): ToolExecutor =>
      async (_args, context) => {
        depth += 1;
        depthsReached.push(depth);
        const result = await getHost()!.invokeTool(next, {}, context);
        depth -= 1;
        return result.ok ? result : { ok: true, value: { stoppedBy: result.error.code } };
      };
    await buildToolRegistry({
      instructionsTemplate: MINIMAL_SESSION_TEMPLATE,
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
    const callee: ToolExecutor = () => Promise.resolve({ ok: true, value: { n: 2 } });
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

  it('keeps the nested calls of a transparent tool from the observer, yet still runs them', async () => {
    const seen: string[] = [];
    const callee = vi.fn<ToolExecutor>(() => Promise.resolve({ ok: true, value: { n: 3 } }));
    const toolHost = await setUp({
      uses: ['callee'],
      callees: { callee },
      transparent: true,
      nestedCalls: {
        onCallStarted: (call) => seen.push(call.toolName),
        onCallSettled: (call) => seen.push(call.toolName),
      },
    });

    const result = await toolHost.invokeTool('callee', {}, parent());

    expect(result).toEqual({ ok: true, value: { n: 3 } });
    expect(callee).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
  });
});

describe('discovered tools (the real src/tools folders)', () => {
  it('enables exactly the shipped tools, keeps memo_reflection internal and aem_create_page disabled', async () => {
    const registry = await buildToolRegistry({
      instructionsTemplate: MINIMAL_SESSION_TEMPLATE,
      host,
      loaders: discoverToolLoaders(),
    });

    expect(registry.failures).toEqual([]);
    expect([...registry.enabledNames].sort()).toEqual([
      'aem_get_json',
      'aem_query',
      'aem_query_format_ask',
      'aem_semantic_search',
      'ask_user',
      'browser_navigate',
      'environment_facts',
      'format_table',
      'http_fetch',
      'load_skill',
      'memo',
      'page_audit',
      'page_read',
      'skill_resource',
      'skill_script',
    ]);
    expect([...registry.internalNames]).toEqual(['memo_reflection']);
    expect(registry.disabledNames).toEqual(['aem_create_page']);
    expect([...registry.allowlistEntries].sort()).toEqual([
      'custom:aem_get_json',
      'custom:aem_query',
      'custom:aem_query_format_ask',
      'custom:aem_semantic_search',
      'custom:ask_user',
      'custom:browser_navigate',
      'custom:environment_facts',
      'custom:format_table',
      'custom:http_fetch',
      'custom:load_skill',
      'custom:memo',
      'custom:page_audit',
      'custom:page_read',
      'custom:skill_resource',
      'custom:skill_script',
    ]);
  });
});

describe('the shipped page_audit report', () => {
  it('returns its scores and evidence in the result, with no nested tool calls', async () => {
    const nested: {
      readonly toolName: string;
      readonly args: Readonly<Record<string, JsonValue>>;
    }[] = [];
    const registry = await buildToolRegistry({
      instructionsTemplate: MINIMAL_SESSION_TEMPLATE,
      host: {
        ...host,
        pageAudit: () =>
          Promise.resolve({
            kind: 'report',
            url: 'https://aem.example.com/content/x.html',
            formFactor: 'desktop',
            scores: [{ category: 'accessibility', score: 0.42 }],
            failures: [
              {
                category: 'accessibility',
                id: 'heading-order',
                title: 'Heading elements are not in a sequentially-descending order',
                score: 0,
                evidence: [
                  {
                    kind: 'table',
                    columns: [{ key: 'node', label: 'Failing Elements' }],
                    rows: [
                      [
                        {
                          kind: 'selector',
                          selector: 'h4.card__title',
                          snippet: '<h4 class="card__title">Hi</h4>',
                          label: 'h4',
                        },
                      ],
                    ],
                  },
                ],
              },
            ],
          }),
      },
      loaders: discoverToolLoaders(),
      nestedCalls: {
        onCallStarted: (call) => nested.push({ toolName: call.toolName, args: call.args }),
        onCallSettled: () => undefined,
      },
    });
    expect(registry.failures).toEqual([]);

    const executor = registry.toolHandlers['page_audit'];
    if (executor === undefined) throw new Error('page_audit is not registered');
    const result = await executor({}, { toolCallId: newToolCallId(ids), signal: undefined });

    expect(result.ok).toBe(true);
    // The report is painted by the renderer from the result; no nested
    // `format_table` call is made.
    expect(nested).toEqual([]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        resultType: 'success',
        failures: [
          {
            evidence: [
              { kind: 'table', rows: [[{ kind: 'selector', selector: 'h4.card__title' }]] },
            ],
          },
        ],
      },
    });
  });
});

describe('buildToolRegistry session instructions template', () => {
  const build = (template: string) =>
    buildToolRegistry({
      instructionsTemplate: template,
      host,
      loaders: loaders({ '/tools/a/tool.ts': () => Promise.resolve({ tool: fakeTool('tool_a') }) }),
    });

  it('splices the tool paragraphs into the template at the placeholder', async () => {
    const registry = await build(MINIMAL_SESSION_TEMPLATE);
    expect(registry.instructions).toBe("Before.\n\nUse 'tool_a' for its purpose.\n\nAfter.");
  });

  it('rejects a template without exactly one placeholder, so no session starts without its policy', async () => {
    await expect(build('No placeholder')).rejects.toThrow();
  });
});

describe('the shipped tools describe their arguments themselves', () => {
  it('gives every model-facing descriptor a non-empty description and instructions', async () => {
    const registry = await buildToolRegistry({
      instructionsTemplate: MINIMAL_SESSION_TEMPLATE,
      host,
      loaders: discoverToolLoaders(),
    });
    expect(registry.descriptors.length).toBeGreaterThan(0);
    for (const descriptor of registry.descriptors) {
      expect(descriptor.description.trim().length).toBeGreaterThan(0);
    }
    expect(registry.instructions.trim().length).toBeGreaterThan(0);
  });
});
