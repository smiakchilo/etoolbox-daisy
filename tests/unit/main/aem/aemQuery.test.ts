import { describe, expect, it, vi } from 'vitest';
import { executeAemQuery, type AemQueryRequest } from '../../../../src/shared';
import type { BrokerOutcome } from '../../../../src/shared';
import { aemQueryArgsSchema, type AemQueryArgs } from '../../../../src/shared';
import {
  chatIdSchema,
  requestIdSchema,
  serverIdSchema,
  turnIdSchema,
} from '../../../../src/shared';
import {
  renderToolResultForModel,
  toolResultSchema,
  type ToolResult,
} from '../../../../src/shared';

const ORIGIN = 'https://author.example';

function envelope(argsOverrides: Partial<AemQueryArgs> = {}): AemQueryRequest {
  return {
    operation: 'aem_query',
    requestId: requestIdSchema.parse('req-1'),
    chatId: chatIdSchema.parse('chat-1'),
    turnId: turnIdSchema.parse('turn-1'),
    serverId: serverIdSchema.parse('server-1'),
    serverRevision: 3,
    navigationEpoch: 2,
    deadlineMs: 1_000_000,
    args: aemQueryArgsSchema.parse({
      predicates: { path: '/content/site' },
      ...argsOverrides,
    }),
  };
}

function jsonResponse(body: unknown, status = 200): BrokerOutcome {
  return {
    kind: 'response',
    status,
    contentType: 'application/json',
    bodyText: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function run(
  outcome: BrokerOutcome,
  argsOverrides: Partial<AemQueryArgs> = {},
): Promise<ToolResult> {
  return executeAemQuery(envelope(argsOverrides), {
    origin: ORIGIN,
    fetchThroughBridge: () => Promise.resolve(outcome),
    now: () => 1_700_000_000_000,
  });
}

function expectSuccess(result: ToolResult) {
  if (!result.ok)
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  if (result.operation !== 'aem_query') throw new Error('expected an aem_query result');
  return result;
}

function expectError(result: ToolResult) {
  if (result.ok) throw new Error('expected a tool error');
  return result;
}

/** A well-formed QueryBuilder success body. */
function queryBody(
  hits: readonly unknown[],
  extra: { more?: boolean; total?: number } = {},
): Record<string, unknown> {
  return {
    success: true,
    results: hits.length,
    hits: [...hits],
    ...(extra.more === undefined ? {} : { more: extra.more }),
    ...(extra.total === undefined ? {} : { total: extra.total }),
  };
}

describe('executeAemQuery - the successful path', () => {
  it('returns rows that satisfy the shared tool result contract', async () => {
    const result = await run(
      jsonResponse(
        queryBody([{ 'jcr:path': '/content/site/a' }, { 'jcr:path': '/content/site/b' }], {
          more: false,
          total: 2,
        }),
      ),
    );
    expect(toolResultSchema.safeParse(result).success).toBe(true);
    const success = expectSuccess(result);
    expect(success.rows).toHaveLength(2);
    expect(success.sourceOrigin).toBe(ORIGIN);
    expect(success.serverRevision).toBe(3);
    expect(success.fetchedAt).toBe(1_700_000_000_000);
  });

  it('reports the predicates the query actually ran with', async () => {
    const result = await run(jsonResponse(queryBody([])), {
      predicates: { path: '/content/site', type: 'cq:Page' },
    });
    expect(expectSuccess(result).predicates).toEqual({
      path: '/content/site',
      type: 'cq:Page',
    });
  });

  it("reports selection as 'selected', never 'all', because hits are always projected", async () => {
    const result = await run(jsonResponse(queryBody([])));
    const selection = expectSuccess(result).selection;
    expect(selection.kind).toBe('selected');
  });

  it("names the agent's requested properties in the selection", async () => {
    const result = await run(jsonResponse(queryBody([])), { properties: ['jcr:title'] });
    const selection = expectSuccess(result).selection;
    if (selection.kind !== 'selected') throw new Error('expected a selected projection');
    expect(selection.properties).toEqual(['jcr:path', 'jcr:title']);
  });

  it('requests /bin/querybuilder.json on the selected origin', async () => {
    const fetchThroughBridge = vi.fn<(url: string) => Promise<BrokerOutcome>>(() =>
      Promise.resolve(jsonResponse(queryBody([]))),
    );
    await executeAemQuery(envelope(), {
      origin: ORIGIN,
      fetchThroughBridge,
      now: () => 0,
    });
    const requested = new URL(fetchThroughBridge.mock.calls[0]?.[0] ?? '');
    expect(requested.origin).toBe(ORIGIN);
    expect(requested.pathname).toBe('/bin/querybuilder.json');
  });
});

describe('executeAemQuery - success:false is never an empty result', () => {
  it('reports a rejected query as an error even though HTTP was 200', async () => {
    const result = await run(
      jsonResponse({ success: false, error: "unknown predicate 'acmeThing'" }),
    );
    const error = expectError(result);
    expect(error.error.code).toBe('UNEXPECTED_RESPONSE');
  });

  it('says the query was rejected rather than that nothing matched', async () => {
    const result = await run(jsonResponse({ success: false, error: 'boom' }));
    const message = expectError(result).error.message;
    expect(message).toMatch(/rejected/i);
    expect(message).toMatch(/not an empty result/i);
  });

  it("never echoes AEM's own error text back to the model", async () => {
    const result = await run(
      jsonResponse({ success: false, error: 'SECRET-INTERNAL-DETAIL-12345' }),
    );
    expect(expectError(result).error.message).not.toContain('SECRET-INTERNAL-DETAIL-12345');
  });

  it('treats a 200 body with hits but no success flag as a rejection, not a result', async () => {
    // The dangerous shape: it looks entirely like data.
    const result = await run(jsonResponse({ hits: [{ 'jcr:path': '/content/site/a' }] }));
    expect(expectError(result).error.message).toMatch(/rejected/i);
  });

  it('reports a success:true body with no hits array as malformed, not as zero rows', async () => {
    const result = await run(jsonResponse({ success: true, results: 0 }));
    expect(expectError(result).error.code).toBe('UNEXPECTED_RESPONSE');
  });

  it('does return zero rows when the query genuinely matched nothing', async () => {
    // The other side of the same coin: a real empty result must stay a
    // success, or the tool would cry wolf on every legitimate empty search.
    const result = await run(jsonResponse(queryBody([], { more: false, total: 0 })));
    const success = expectSuccess(result);
    expect(success.rows).toEqual([]);
    expect(success.pagination.total).toEqual({ accuracy: 'exact', value: 0 });
  });
});

describe('executeAemQuery - pagination is reported honestly', () => {
  it('preserves the requested offset and limit', async () => {
    const result = await run(jsonResponse(queryBody([{ 'jcr:path': '/a' }], { more: true })), {
      offset: 100,
      limit: 25,
    });
    const { pagination } = expectSuccess(result);
    expect(pagination.offset).toBe(100);
    expect(pagination.limit).toBe(25);
    expect(pagination.returned).toBe(1);
  });

  it("preserves AEM's own 'more' flag", async () => {
    const result = await run(
      jsonResponse(queryBody([{ 'jcr:path': '/a' }], { more: true, total: 900 })),
    );
    expect(expectSuccess(result).pagination.hasMore).toBe(true);
  });

  it("reports hasMore as 'unknown' when AEM sent no more flag, never as false", async () => {
    const result = await run(jsonResponse(queryBody([{ 'jcr:path': '/a' }], { total: 900 })));
    expect(expectSuccess(result).pagination.hasMore).toBe('unknown');
  });

  it('marks a total as estimated when more results exist beyond the page', async () => {
    const result = await run(
      jsonResponse(queryBody([{ 'jcr:path': '/a' }], { more: true, total: 900 })),
    );
    expect(expectSuccess(result).pagination.total).toEqual({
      accuracy: 'estimated',
      value: 900,
    });
  });

  it('marks a total as exact only when the page provably accounts for all of it', async () => {
    const result = await run(
      jsonResponse(
        queryBody([{ 'jcr:path': '/a' }, { 'jcr:path': '/b' }], { more: false, total: 2 }),
      ),
    );
    expect(expectSuccess(result).pagination.total).toEqual({ accuracy: 'exact', value: 2 });
  });

  it('does not claim an exact total when more:false disagrees with the arithmetic', async () => {
    // `more: false` with a total larger than offset+returned is internally
    // inconsistent; the estimate is the only honest reading.
    const result = await run(
      jsonResponse(queryBody([{ 'jcr:path': '/a' }], { more: false, total: 900 })),
    );
    expect(expectSuccess(result).pagination.total).toEqual({
      accuracy: 'estimated',
      value: 900,
    });
  });

  it('accounts for the offset when judging whether a total is exact', async () => {
    const result = await run(
      jsonResponse(queryBody([{ 'jcr:path': '/c' }], { more: false, total: 3 })),
      { offset: 2 },
    );
    expect(expectSuccess(result).pagination.total).toEqual({ accuracy: 'exact', value: 3 });
  });

  it('reports an unknown total rather than inventing a number', async () => {
    const result = await run(jsonResponse(queryBody([{ 'jcr:path': '/a' }], { more: true })));
    expect(expectSuccess(result).pagination.total).toEqual({ accuracy: 'unknown' });
  });

  it('rejects a non-integer or negative total instead of passing it through', async () => {
    const result = await run(
      jsonResponse(queryBody([{ 'jcr:path': '/a' }], { more: true, total: -5 })),
    );
    expect(expectSuccess(result).pagination.total).toEqual({ accuracy: 'unknown' });
  });
});

describe('executeAemQuery - two pages are never presented as a complete result', () => {
  it("issues exactly one HTTP request per tool call, never following 'more'", async () => {
    const fetchThroughBridge = vi.fn<(url: string) => Promise<BrokerOutcome>>(() =>
      Promise.resolve(jsonResponse(queryBody([{ 'jcr:path': '/a' }], { more: true, total: 5000 }))),
    );
    await executeAemQuery(envelope({ limit: 1 }), {
      origin: ORIGIN,
      fetchThroughBridge,
      now: () => 0,
    });
    // The whole prohibition on secretly loading every page reduces to this
    // number. If it is ever greater than 1, the application is paging behind
    // the agent's back.
    expect(fetchThroughBridge).toHaveBeenCalledTimes(1);
  });

  it('returns only the rows of the requested page, not the reported total', async () => {
    const result = await run(
      jsonResponse(queryBody([{ 'jcr:path': '/a' }], { more: true, total: 5000 })),
      { limit: 1 },
    );
    const success = expectSuccess(result);
    expect(success.rows).toHaveLength(1);
    expect(success.pagination.returned).toBe(1);
  });

  it('tells the model in prose that more results exist and that the total is estimated', async () => {
    const result = await run(
      jsonResponse(queryBody([{ 'jcr:path': '/a' }], { more: true, total: 5000 })),
      { limit: 1 },
    );
    const rendered = renderToolResultForModel(result);
    expect(rendered).toMatch(/more results exist/i);
    expect(rendered).toMatch(/higher offset/i);
    expect(rendered).toMatch(/approximately 5000/i);
    expect(rendered).toMatch(/estimated/i);
  });

  it('does not describe an estimated total as an exact count', async () => {
    const rendered = renderToolResultForModel(
      await run(jsonResponse(queryBody([{ 'jcr:path': '/a' }], { more: true, total: 5000 }))),
    );
    // The count may only ever appear qualified. A bare "5000 match(es) in
    // total" is the exact-form rendering and must not be reachable here.
    expect(rendered).not.toMatch(/(?<!approximately )5000 match\(es\) in total/);
  });
});

describe('executeAemQuery - transport and HTTP failures', () => {
  it('reports a 414 explicitly rather than as an unexpected status', async () => {
    const result = await run({
      kind: 'response',
      status: 414,
      contentType: 'text/html',
      bodyText: '<html lang="en">URI Too Long</html>',
    });
    const error = expectError(result);
    expect(error.error.code).toBe('INVALID_ARGUMENT');
    expect(error.error.message).toMatch(/too long/i);
  });

  it('does not suggest retrying a 414 by another method', async () => {
    const result = await run({
      kind: 'response',
      status: 414,
      contentType: 'text/html',
      bodyText: '',
    });
    const error = expectError(result);
    expect(error.error.retryable).toBe(false);
    expect(error.error.message).toMatch(/cannot be retried/i);
  });

  it('treats a 403 as a permission problem, not a request to sign in again', async () => {
    const result = await run({
      kind: 'response',
      status: 403,
      contentType: 'text/html',
      bodyText: '',
    });
    const error = expectError(result);
    expect(error.error.code).toBe('NOT_AUTHORIZED');
    expect(error.error.requiredAction).toBe('none');
  });

  it('treats a 200 HTML login page as an auth failure, not as data', async () => {
    const result = await run({
      kind: 'response',
      status: 200,
      contentType: 'text/html',
      bodyText: "<html lang='en'><form id='login'></form></html>",
    });
    expect(expectError(result).error.requiredAction).toBe('sign_in_to_aem');
  });

  it('reports a reserved predicate before any request is made', async () => {
    const fetchThroughBridge = vi.fn<(url: string) => Promise<BrokerOutcome>>(() =>
      Promise.resolve(jsonResponse(queryBody([]))),
    );
    const result = await executeAemQuery(
      {
        ...envelope(),
        // Bypasses the args schema on purpose, to prove this module refuses
        // independently of it.
        args: { predicates: { 'p.limit': '9999' }, offset: 0, limit: 50 },
      },
      { origin: ORIGIN, fetchThroughBridge, now: () => 0 },
    );
    expect(expectError(result).error.code).toBe('INVALID_ARGUMENT');
    expect(fetchThroughBridge).not.toHaveBeenCalled();
  });

  it.each([
    ['cancelled', { kind: 'cancelled' } as const, 'CANCELLED'],
    ['timeout', { kind: 'timeout' } as const, 'TIMEOUT'],
    ['network_error', { kind: 'network_error' } as const, 'NETWORK_ERROR'],
    ['no_view', { kind: 'no_view' } as const, 'ACCESS_DENIED'],
    ['bridge_unavailable', { kind: 'bridge_unavailable' } as const, 'ACCESS_DENIED'],
  ])('maps a %s broker outcome to %s', async (_label, outcome, code) => {
    const result = await run(outcome as BrokerOutcome);
    expect(expectError(result).error.code).toBe(code);
  });

  it('never returns an empty row set in place of a transport failure', async () => {
    const result = await run({ kind: 'network_error' } as BrokerOutcome);
    expect(result.ok).toBe(false);
    expect('rows' in result).toBe(false);
  });
});
