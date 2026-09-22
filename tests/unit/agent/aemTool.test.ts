import { describe, expect, it, vi } from 'vitest';

import {
  createAemGetJsonExecutor,
  createAemQueryExecutor,
  buildAemToolPolicy,
  AEM_ASSISTANT_INSTRUCTIONS,
  AEM_GET_JSON_ALLOWLIST_ENTRY,
  AEM_GET_JSON_TOOL_NAME,
  AEM_QUERY_ALLOWLIST_ENTRY,
  AEM_QUERY_TOOL_NAME,
  type AemGetJsonExecutorConfig,
  type AemGetJsonRequestEnvelope,
  type AemQueryRequestEnvelope,
  type CurrentAemToolContext,
} from '../../../src/agent/aemTool';
import type { ToolCallId } from '../../../src/shared';
import {
  newChatId,
  newRequestId,
  newServerId,
  newTurnId,
  requestIdSchema,
  type IdGenerator,
} from '../../../src/shared';
import { createToolError } from '../../../src/shared';
import type { ToolResult } from '../../../src/shared';
import type { JsonValue } from '../../../src/shared';

/** Mints reproducible ids, mirroring `sdkAgentService.test.ts`'s identically-named helper. */
function counterIdGenerator(): IdGenerator {
  let counter = 0;
  return () => `test-id-${String(counter++)}`;
}

const BOUND_ORIGIN = 'https://aem-author.example.com';

function makeContext(
  ids: IdGenerator,
  overrides: Partial<CurrentAemToolContext> = {},
): CurrentAemToolContext {
  return {
    origin: BOUND_ORIGIN,
    serverId: newServerId(ids),
    serverRevision: 1,
    navigationEpoch: 0,
    chatId: newChatId(ids),
    turnId: newTurnId(ids),
    ...overrides,
  };
}

function makeSuccessResult(requestId: ReturnType<typeof newRequestId>): ToolResult {
  return {
    ok: true,
    operation: 'aem_get_json',
    requestId,
    sourceOrigin: BOUND_ORIGIN,
    serverRevision: 1,
    path: '/content/foo',
    fetchedAt: 1_700_000_000_000,
    data: { 'jcr:title': 'Foo' },
    selection: { kind: 'all' },
    children: { requested: false },
  };
}

function makeFailureResult(requestId: ReturnType<typeof newRequestId>): ToolResult {
  return {
    ok: false,
    error: createToolError(
      'NOT_FOUND',
      'AEM reports that no resource exists at that path.',
      requestId,
    ),
  };
}

interface RuntimeDeps extends Record<string, unknown> {
  readonly fetchThroughBridge: (url: string) => Promise<unknown>;
  readonly now: () => number;
}

function makeRuntimeDeps(): RuntimeDeps {
  return {
    fetchThroughBridge: vi.fn(() => Promise.resolve({ kind: 'response' })),
    now: () => 1_700_000_000_000,
  };
}

function makeConfig(
  ids: IdGenerator,
  execute: (
    envelope: AemGetJsonRequestEnvelope,
    deps: { readonly origin: string } & RuntimeDeps,
  ) => Promise<ToolResult>,
  context: () => CurrentAemToolContext,
): AemGetJsonExecutorConfig<RuntimeDeps> {
  return {
    execute,
    runtimeDeps: makeRuntimeDeps(),
    currentContext: context,
    clock: () => 1_700_000_000_000,
    idGenerator: ids,
  };
}

function toolCallContext(signal?: AbortSignal): {
  toolCallId: ToolCallId;
  signal: AbortSignal | undefined;
} {
  return { toolCallId: 'tool-call-1' as ToolCallId, signal };
}

function asPayload(value: JsonValue): { textResultForLlm: string; resultType: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected an object payload');
  }
  const record = value as Record<string, JsonValue>;
  const textResultForLlm = record['textResultForLlm'];
  const resultType = record['resultType'];
  if (typeof textResultForLlm !== 'string' || typeof resultType !== 'string') {
    throw new Error(`payload missing textResultForLlm/resultType: ${JSON.stringify(value)}`);
  }
  return { textResultForLlm, resultType };
}

describe('aemTool - createAemGetJsonExecutor', () => {
  it("validates the model's args, binds the application's current origin, and reaches execute with both", async () => {
    const ids = counterIdGenerator();
    const context = makeContext(ids);
    const execute = vi.fn<
      (
        envelope: AemGetJsonRequestEnvelope,
        deps: { readonly origin: string } & RuntimeDeps,
      ) => Promise<ToolResult>
    >((envelope) => Promise.resolve(makeSuccessResult(envelope.requestId)));
    const executor = createAemGetJsonExecutor(makeConfig(ids, execute, () => context));

    const result = await executor({ path: '/content/foo' }, toolCallContext());

    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    const [envelope, deps] = execute.mock.calls[0]!;
    expect(envelope.operation).toBe('aem_get_json');
    expect(envelope.args).toEqual({ path: '/content/foo' });
    expect(envelope.chatId).toBe(context.chatId);
    expect(envelope.turnId).toBe(context.turnId);
    expect(envelope.serverId).toBe(context.serverId);
    expect(envelope.serverRevision).toBe(context.serverRevision);
    expect(envelope.navigationEpoch).toBe(context.navigationEpoch);
    expect(requestIdSchema.safeParse(envelope.requestId).success).toBe(true);
    // The single most important property this module has: the origin the
    // handler is called with is the application-bound one, never derived
    // from `args`.
    expect(deps.origin).toBe(BOUND_ORIGIN);

    if (!result.ok) throw new Error('expected ok');
    const payload = asPayload(result.value);
    expect(payload.resultType).toBe('success');
    expect(payload.textResultForLlm).toContain('/content/foo');
  });

  it('rejects invalid/malicious args before any fetch (a JCR traversal path)', async () => {
    const ids = counterIdGenerator();
    const context = makeContext(ids);
    const execute = vi.fn(() => Promise.resolve(makeSuccessResult(newRequestId(ids))));
    const executor = createAemGetJsonExecutor(makeConfig(ids, execute, () => context));

    const result = await executor({ path: '/content/../secret' }, toolCallContext());

    expect(execute).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.error.code).toBe('INVALID_ARGUMENT');
    expect(result.error.message).toBeTruthy();
  });

  it("has no channel for a tool-argument field to influence the origin: an extraneous 'origin' argument is rejected before any fetch", async () => {
    const ids = counterIdGenerator();
    const context = makeContext(ids);
    const execute = vi.fn(() => Promise.resolve(makeSuccessResult(newRequestId(ids))));
    const executor = createAemGetJsonExecutor(makeConfig(ids, execute, () => context));

    const maliciousArgs: Record<string, JsonValue> = {
      path: '/content/foo',
      origin: 'https://evil.example.com',
    };
    const result = await executor(maliciousArgs, toolCallContext());

    expect(execute).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.error.code).toBe('INVALID_ARGUMENT');
  });

  it("always passes the current context's origin to execute, independent of args, and follows context when it changes", async () => {
    const ids = counterIdGenerator();
    let origin = 'https://server-a.example.com';
    const execute = vi.fn<
      (
        envelope: AemGetJsonRequestEnvelope,
        deps: { readonly origin: string } & RuntimeDeps,
      ) => Promise<ToolResult>
    >((envelope) => Promise.resolve(makeSuccessResult(envelope.requestId)));
    const executor = createAemGetJsonExecutor(
      makeConfig(ids, execute, () => makeContext(ids, { origin })),
    );

    await executor({ path: '/content/foo' }, toolCallContext());
    origin = 'https://server-b.example.com';
    await executor({ path: '/content/foo' }, toolCallContext());

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]![1].origin).toBe('https://server-a.example.com');
    expect(execute.mock.calls[1]![1].origin).toBe('https://server-b.example.com');
  });

  it('maps a successful ToolResult to resultType: success with rendered text', async () => {
    const ids = counterIdGenerator();
    const context = makeContext(ids);
    const execute = vi.fn<
      (
        envelope: AemGetJsonRequestEnvelope,
        deps: { readonly origin: string } & RuntimeDeps,
      ) => Promise<ToolResult>
    >((envelope) => Promise.resolve(makeSuccessResult(envelope.requestId)));
    const executor = createAemGetJsonExecutor(makeConfig(ids, execute, () => context));

    const result = await executor({ path: '/content/foo' }, toolCallContext());

    if (!result.ok) throw new Error('expected ok');
    const payload = asPayload(result.value);
    expect(payload.resultType).toBe('success');
    expect(payload.textResultForLlm).toContain('AEM node /content/foo');
  });

  it('maps a failed ToolResult to a returned err(ToolError), with the error still readable', async () => {
    const ids = counterIdGenerator();
    const context = makeContext(ids);
    const execute = vi.fn<
      (
        envelope: AemGetJsonRequestEnvelope,
        deps: { readonly origin: string } & RuntimeDeps,
      ) => Promise<ToolResult>
    >((envelope) => Promise.resolve(makeFailureResult(envelope.requestId)));
    const executor = createAemGetJsonExecutor(makeConfig(ids, execute, () => context));

    const result = await executor({ path: '/content/foo' }, toolCallContext());

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.error.message).toContain('no resource exists at that path');
  });

  it('honours an already-aborted signal: performs no fetch and returns a cancelled failure', async () => {
    const ids = counterIdGenerator();
    const context = makeContext(ids);
    const execute = vi.fn(() => Promise.resolve(makeSuccessResult(newRequestId(ids))));
    const executor = createAemGetJsonExecutor(makeConfig(ids, execute, () => context));

    const controller = new AbortController();
    controller.abort();
    const result = await executor({ path: '/content/foo' }, toolCallContext(controller.signal));

    expect(execute).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.error.code).toBe('CANCELLED');
  });

  it('proceeds normally when the signal is present but not aborted', async () => {
    const ids = counterIdGenerator();
    const context = makeContext(ids);
    const execute = vi.fn<
      (
        envelope: AemGetJsonRequestEnvelope,
        deps: { readonly origin: string } & RuntimeDeps,
      ) => Promise<ToolResult>
    >((envelope) => Promise.resolve(makeSuccessResult(envelope.requestId)));
    const executor = createAemGetJsonExecutor(makeConfig(ids, execute, () => context));

    const controller = new AbortController();
    const result = await executor({ path: '/content/foo' }, toolCallContext(controller.signal));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });
});

describe('aemTool - buildAemToolPolicy', () => {
  it('allows exactly the two custom tools, and supplies the bundled base instruction', () => {
    const policy = buildAemToolPolicy();
    expect(policy.availableTools).toEqual([
      AEM_GET_JSON_ALLOWLIST_ENTRY,
      AEM_QUERY_ALLOWLIST_ENTRY,
    ]);
    expect(policy.instructions).toBe(AEM_ASSISTANT_INSTRUCTIONS);
    expect(policy.instructions).toBeTruthy();
  });

  it('leaves skills disabled when no bundled directory is supplied', () => {
    expect(buildAemToolPolicy().bundledSkillDirectories).toBeUndefined();
    expect(buildAemToolPolicy([]).bundledSkillDirectories).toBeUndefined();
  });

  it('points skills at the application-owned directory when one is supplied', () => {
    const policy = buildAemToolPolicy(['C:\\app\\resources\\skills']);
    expect(policy.bundledSkillDirectories).toEqual(['C:\\app\\resources\\skills']);
  });

  it('tells the model that later pages need another call at a higher offset', () => {
    expect(AEM_ASSISTANT_INSTRUCTIONS).toMatch(/higher 'offset'/);
    expect(AEM_ASSISTANT_INSTRUCTIONS).toMatch(/never present one page as the complete set/i);
  });

  it('tells the model it cannot modify AEM', () => {
    expect(AEM_ASSISTANT_INSTRUCTIONS).toMatch(/cannot write, delete, or otherwise modify/i);
  });

  it("registers the executor under the descriptor's own tool name", () => {
    expect(AEM_GET_JSON_TOOL_NAME).toBe('aem_get_json');
    expect(AEM_GET_JSON_ALLOWLIST_ENTRY.endsWith(AEM_GET_JSON_TOOL_NAME)).toBe(true);
    expect(AEM_QUERY_TOOL_NAME).toBe('aem_query');
    expect(AEM_QUERY_ALLOWLIST_ENTRY.endsWith(AEM_QUERY_TOOL_NAME)).toBe(true);
  });
});

describe('aemTool - createAemQueryExecutor', () => {
  function makeQuerySuccess(requestId: ReturnType<typeof newRequestId>): ToolResult {
    return {
      ok: true,
      operation: 'aem_query',
      requestId,
      sourceOrigin: BOUND_ORIGIN,
      serverRevision: 1,
      predicates: { path: '/content/site' },
      fetchedAt: 1_700_000_000_000,
      rows: [{ 'jcr:path': '/content/site/a' }],
      selection: { kind: 'selected', properties: ['jcr:path'] },
      pagination: {
        offset: 0,
        limit: 50,
        returned: 1,
        hasMore: true,
        total: { accuracy: 'estimated', value: 900 },
      },
    };
  }

  function makeQueryConfig(
    ids: IdGenerator,
    execute: (
      envelope: AemQueryRequestEnvelope,
      deps: { readonly origin: string } & RuntimeDeps,
    ) => Promise<ToolResult>,
    context: () => CurrentAemToolContext,
  ) {
    return {
      execute,
      runtimeDeps: makeRuntimeDeps(),
      currentContext: context,
      clock: () => 1_700_000_000_000,
      idGenerator: ids,
    };
  }

  it('binds the origin from the application context, never from tool arguments', async () => {
    const ids = counterIdGenerator();
    let seenOrigin: string | undefined;
    const executor = createAemQueryExecutor(
      makeQueryConfig(
        ids,
        (envelope, deps) => {
          seenOrigin = deps.origin;
          return Promise.resolve(makeQuerySuccess(envelope.requestId));
        },
        () => makeContext(ids),
      ),
    );
    // Every one of these would be an origin if the executor let arguments
    // decide; none of them is even a field of `aemQueryArgsSchema`.
    const result = await executor(
      {
        predicates: { path: '/content/site' },
        origin: 'https://attacker.example',
        url: 'https://attacker.example/bin/querybuilder.json',
      },
      toolCallContext(),
    );
    // `.strict()` on the args schema rejects the extra keys outright, which
    // is the stronger guarantee: they cannot even be carried.
    expect(result.ok).toBe(false);
    expect(seenOrigin).toBeUndefined();
  });

  it('uses the bound origin for a well-formed call', async () => {
    const ids = counterIdGenerator();
    let seenOrigin: string | undefined;
    const executor = createAemQueryExecutor(
      makeQueryConfig(
        ids,
        (envelope, deps) => {
          seenOrigin = deps.origin;
          return Promise.resolve(makeQuerySuccess(envelope.requestId));
        },
        () => makeContext(ids),
      ),
    );
    const result = await executor({ predicates: { path: '/content/site' } }, toolCallContext());
    expect(result.ok).toBe(true);
    expect(seenOrigin).toBe(BOUND_ORIGIN);
  });

  it('builds an aem_query envelope with application-owned staleness fields', async () => {
    const ids = counterIdGenerator();
    let seen: AemQueryRequestEnvelope | undefined;
    const executor = createAemQueryExecutor(
      makeQueryConfig(
        ids,
        (envelope) => {
          seen = envelope;
          return Promise.resolve(makeQuerySuccess(envelope.requestId));
        },
        () => makeContext(ids, { serverRevision: 7, navigationEpoch: 4 }),
      ),
    );
    await executor({ predicates: { path: '/content/site' }, limit: 10 }, toolCallContext());
    expect(seen?.operation).toBe('aem_query');
    expect(seen?.serverRevision).toBe(7);
    expect(seen?.navigationEpoch).toBe(4);
    expect(seen?.args.limit).toBe(10);
    expect(seen?.args.offset).toBe(0);
  });

  it('rejects a reserved output parameter supplied as a predicate', async () => {
    const ids = counterIdGenerator();
    const execute = vi.fn(() => Promise.resolve(makeQuerySuccess(newRequestId(ids))));
    const executor = createAemQueryExecutor(makeQueryConfig(ids, execute, () => makeContext(ids)));
    const result = await executor({ predicates: { 'p.limit': '9999' } }, toolCallContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_ARGUMENT');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a limit above 200 before reaching the handler', async () => {
    const ids = counterIdGenerator();
    const execute = vi.fn(() => Promise.resolve(makeQuerySuccess(newRequestId(ids))));
    const executor = createAemQueryExecutor(makeQueryConfig(ids, execute, () => makeContext(ids)));
    const result = await executor(
      { predicates: { path: '/content/site' }, limit: 201 },
      toolCallContext(),
    );
    expect(result.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('honours an already-aborted signal before validating anything', async () => {
    const ids = counterIdGenerator();
    const execute = vi.fn(() => Promise.resolve(makeQuerySuccess(newRequestId(ids))));
    const executor = createAemQueryExecutor(makeQueryConfig(ids, execute, () => makeContext(ids)));
    const controller = new AbortController();
    controller.abort();
    const result = await executor({ predicates: {} }, toolCallContext(controller.signal));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CANCELLED');
    expect(execute).not.toHaveBeenCalled();
  });

  it('passes the pagination signal through to the model-facing text', async () => {
    const ids = counterIdGenerator();
    const executor = createAemQueryExecutor(
      makeQueryConfig(
        ids,
        (envelope) => Promise.resolve(makeQuerySuccess(envelope.requestId)),
        () => makeContext(ids),
      ),
    );
    const result = await executor({ predicates: { path: '/content/site' } }, toolCallContext());
    if (!result.ok) throw new Error('expected success');
    expect(JSON.stringify(result.value)).toMatch(/more results exist/i);
    expect(JSON.stringify(result.value)).toMatch(/estimated/i);
  });

  it('returns a domain failure as an error, never as an empty row set', async () => {
    const ids = counterIdGenerator();
    const executor = createAemQueryExecutor(
      makeQueryConfig(
        ids,
        (envelope) => Promise.resolve(makeFailureResult(envelope.requestId)),
        () => makeContext(ids),
      ),
    );
    const result = await executor({ predicates: { path: '/content/site' } }, toolCallContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
  });

  it('converts a thrown handler exception into a tool error rather than propagating it', async () => {
    const ids = counterIdGenerator();
    const executor = createAemQueryExecutor(
      makeQueryConfig(
        ids,
        () => Promise.reject(new Error('bridge exploded')),
        () => makeContext(ids),
      ),
    );
    const result = await executor({ predicates: { path: '/content/site' } }, toolCallContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNEXPECTED_RESPONSE');
  });
});
