import { describe, expect, it } from 'vitest';
import {
  AEM_QUERY_FORMAT_ASK_TOOL_DESCRIPTOR,
  AEM_QUERY_FORMAT_ASK_TOOL_NAME,
  createAemQueryFormatAskExecutor,
  describeSearchTotal,
} from '../../../src/tools/aem-query-format-ask/aemQueryFormatAsk';
import { renderer } from '../../../src/tools/aem-query-format-ask/renderer';
import { tool } from '../../../src/tools/aem-query-format-ask/tool';
import {
  type JsonValue,
  type Result,
  type ToolError,
  type ToolHost,
  SEARCH_PAGE_SIZE,
  createToolError,
  err,
  ok,
} from '../../../src/shared';
import { createCountingIdGenerator } from '../../support/testIds';

interface Invocation {
  readonly name: string;
  readonly args: Readonly<Record<string, JsonValue>>;
}

type Responder = (
  name: string,
  args: Readonly<Record<string, JsonValue>>,
) => Result<JsonValue, ToolError>;

function queryPage(rows: number, hasMore: boolean | 'unknown', offset = 0): JsonValue {
  return {
    ok: true,
    operation: 'aem_query',
    rows: Array.from({ length: rows }, (_, index) => ({
      'jcr:path': `/content/p${String(offset + index)}`,
    })),
    pagination: {
      offset,
      limit: 2,
      returned: rows,
      hasMore,
      total: { accuracy: 'estimated', value: 5 },
    },
    textResultForLlm: 'rows',
    resultType: 'success',
  };
}

const tableOk: JsonValue = { operation: 'format_table', resultType: 'success' };
const loadMore: JsonValue = { selections: ['Load more'], freeform: null };

function makeHost(responder: Responder, contentRoots?: readonly string[]) {
  const calls: Invocation[] = [];
  const host: ToolHost = {
    bridge: { request: () => Promise.resolve({ kind: 'cancelled' }) },
    currentContext: () => {
      throw new Error('the composite must reach AEM only through aem_query');
    },
    environmentFacts: () =>
      contentRoots === undefined
        ? undefined
        : { origin: 'https://aem.example', contentRoots, componentRoots: ['/apps'] },
    configuredHosts: () => [],
    openPage: () => Promise.resolve({ kind: 'no_view' }),
    requestUserInput: () => Promise.reject(new Error('the composite asks only through ask_user')),
    clock: () => 1,
    idGenerator: createCountingIdGenerator('qfa'),
    invokeTool: (name, args) => {
      calls.push({ name, args });
      return Promise.resolve(responder(name, args));
    },
  };
  return { host, calls };
}

const callContext = { toolCallId: 'call-1' as never, signal: undefined };

function payload(result: Result<JsonValue, ToolError>): Record<string, JsonValue> {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
  return result.value as Record<string, JsonValue>;
}

describe('aem_query_format_ask manifest', () => {
  it('declares its parts and the composite name', () => {
    expect(tool.name).toBe(AEM_QUERY_FORMAT_ASK_TOOL_NAME);
    expect(tool.descriptor).toBe(AEM_QUERY_FORMAT_ASK_TOOL_DESCRIPTOR);
    expect(tool.allowlistEntry).toBe('custom:aem_query_format_ask');
    expect(tool.uses).toEqual(['aem_query', 'format_table', 'ask_user']);
  });
});

describe('aem_query_format_ask executor', () => {
  it('runs one query and one table, and no button when the results are exhausted', async () => {
    const { host, calls } = makeHost(
      (name) => (name === 'aem_query' ? ok(queryPage(2, false)) : ok(tableOk)),
      ['/content/site'],
    );
    const result = await createAemQueryFormatAskExecutor(host)({ terms: 'waldo' }, callContext);

    expect(calls.map((call) => call.name)).toEqual(['aem_query', 'format_table']);
    expect(calls[0]?.args).toEqual({
      predicates: { fulltext: 'waldo' },
      roots: ['/content/site'],
      properties: [],
      limit: SEARCH_PAGE_SIZE,
      offset: 0,
    });
    const tableArgs = calls[1]?.args;
    expect(tableArgs?.['mode']).toBe('new');
    expect((tableArgs?.['data'] as Record<string, JsonValue>)['rows']).toHaveLength(2);
    expect(payload(result)).toMatchObject({
      operation: 'aem_query_format_ask',
      terms: 'waldo',
      roots: ['/content/site'],
      pageSize: SEARCH_PAGE_SIZE,
      pages: 1,
      rows: 2,
      hasMore: false,
      ended: 'exhausted',
      resultType: 'success',
    });
  });

  it('loads the next page on "Load more" and appends it', async () => {
    let queries = 0;
    const { host, calls } = makeHost((name, args) => {
      if (name === 'aem_query') {
        queries += 1;
        return ok(queryPage(2, queries < 2, args['offset'] as number));
      }
      return ok(name === 'ask_user' ? loadMore : tableOk);
    });
    const result = await createAemQueryFormatAskExecutor(host)(
      { terms: 'waldo', limit: 2 },
      callContext,
    );

    expect(calls.map((call) => call.name)).toEqual([
      'aem_query',
      'format_table',
      'ask_user',
      'aem_query',
      'format_table',
    ]);
    expect(calls[2]?.args).toEqual({ actions: ['Load more'] });
    expect(calls[3]?.args['offset']).toBe(2);
    expect(calls[4]?.args['mode']).toBe('append');
    expect(payload(result)).toMatchObject({ pages: 2, rows: 4, ended: 'exhausted' });
  });

  it('ends as stopped, successfully, when the button is cancelled', async () => {
    const { host, calls } = makeHost((name) => {
      if (name === 'aem_query') return ok(queryPage(2, 'unknown'));
      if (name === 'ask_user') {
        return err(createToolError('CANCELLED', 'stopped', 'r' as never));
      }
      return ok(tableOk);
    });
    const result = await createAemQueryFormatAskExecutor(host)({ terms: 'waldo' }, callContext);

    expect(calls.map((call) => call.name)).toEqual(['aem_query', 'format_table', 'ask_user']);
    expect(payload(result)).toMatchObject({ pages: 1, ended: 'stopped', hasMore: 'unknown' });
  });

  it('defaults the roots to /content when the host has no facts', async () => {
    const { host, calls } = makeHost((name) =>
      name === 'aem_query' ? ok(queryPage(0, false)) : ok(tableOk),
    );
    await createAemQueryFormatAskExecutor(host)({ terms: 'x' }, callContext);
    expect(calls[0]?.args['roots']).toEqual(['/content']);
  });

  it('runs hand-built predicates, scoped to the content roots, with chosen properties', async () => {
    const { host, calls } = makeHost(
      (name) => (name === 'aem_query' ? ok(queryPage(1, false)) : ok(tableOk)),
      ['/content/site'],
    );
    const result = await createAemQueryFormatAskExecutor(host)(
      { predicates: { type: 'cq:Page', fulltext: 'waldo' }, properties: ['jcr:content/jcr:title'] },
      callContext,
    );

    expect(calls[0]?.args).toEqual({
      predicates: { type: 'cq:Page', fulltext: 'waldo' },
      roots: ['/content/site'],
      properties: ['jcr:content/jcr:title'],
      limit: SEARCH_PAGE_SIZE,
      offset: 0,
    });
    const summary = payload(result);
    expect(summary).toMatchObject({ predicates: { type: 'cq:Page', fulltext: 'waldo' } });
    expect(summary).not.toHaveProperty('terms');
  });

  it('passes no roots when the predicates carry their own path', async () => {
    const { host, calls } = makeHost(
      (name) => (name === 'aem_query' ? ok(queryPage(1, false)) : ok(tableOk)),
      ['/content/site'],
    );
    const result = await createAemQueryFormatAskExecutor(host)(
      { predicates: { path: '/content/other', type: 'cq:Page' } },
      callContext,
    );

    expect(calls[0]?.args).not.toHaveProperty('roots');
    expect(payload(result)).not.toHaveProperty('roots');
  });

  it('returns the query error unchanged and shows no table', async () => {
    const failure = createToolError('NETWORK_ERROR', 'down', 'r' as never);
    const { host, calls } = makeHost(() => err(failure));
    const result = await createAemQueryFormatAskExecutor(host)({ terms: 'x' }, callContext);

    expect(result).toEqual({ ok: false, error: failure });
    expect(calls.map((call) => call.name)).toEqual(['aem_query']);
  });

  it('rejects an unexpected query payload', async () => {
    const { host } = makeHost(() => ok({ nope: true }));
    const result = await createAemQueryFormatAskExecutor(host)({ terms: 'x' }, callContext);
    expect(!result.ok && result.error.code).toBe('UNEXPECTED_RESPONSE');
  });

  it('rejects invalid arguments without calling anything', async () => {
    const { host, calls } = makeHost(() => ok(tableOk));
    const execute = createAemQueryFormatAskExecutor(host);
    for (const args of [
      {},
      { terms: '  ' },
      { terms: 'x', limit: 0 },
      { terms: 'x', extra: 1 },
      { terms: 'x', predicates: { type: 'cq:Page' } },
    ]) {
      const result = await execute(args, callContext);
      expect(!result.ok && result.error.code).toBe('INVALID_ARGUMENT');
    }
    expect(calls).toEqual([]);
  });

  it('honours an already-aborted signal before any step', async () => {
    const { host, calls } = makeHost(() => ok(tableOk));
    const controller = new AbortController();
    controller.abort();
    const result = await createAemQueryFormatAskExecutor(host)(
      { terms: 'x' },
      { toolCallId: 'call-1' as never, signal: controller.signal },
    );
    expect(!result.ok && result.error.code).toBe('CANCELLED');
    expect(calls).toEqual([]);
  });
});

describe('describeSearchTotal', () => {
  it('words exact, estimated and unknown totals', () => {
    expect(describeSearchTotal({ accuracy: 'exact', value: 3 }, false)).toBe('3');
    expect(describeSearchTotal({ accuracy: 'estimated', value: 9 }, true)).toBe('9+');
    expect(describeSearchTotal({ accuracy: 'estimated', value: 9 }, 'unknown')).toBe(
      'approximately 9',
    );
    expect(describeSearchTotal({ accuracy: 'unknown' }, true)).toBe('unknown');
    expect(describeSearchTotal(undefined, undefined)).toBe('unknown');
  });
});

describe('aem_query_format_ask renderer', () => {
  it('summarises a hand-built search from its predicates', () => {
    expect(renderer.describeCall({ predicates: { type: 'cq:Page', fulltext: 'waldo' } })).toEqual({
      summary: 'Search: type=cq:Page; fulltext=waldo',
      parameters: [{ label: 'Predicates', value: 'type=cq:Page; fulltext=waldo' }],
    });
  });

  it('summarises a pending call from its arguments', () => {
    expect(renderer.describeCall({ terms: 'waldo', limit: 20 })).toEqual({
      summary: 'Search: waldo',
      parameters: [
        { label: 'Terms', value: 'waldo' },
        { label: 'Page size', value: '20' },
      ],
    });
  });

  it('adds roots, pages, rows and total once the search finished', () => {
    const details = renderer.describeCall(
      { terms: 'waldo' },
      {
        operation: 'aem_query_format_ask',
        roots: ['/content/a', '/content/b'],
        pageSize: 50,
        pages: 2,
        rows: 73,
        total: { accuracy: 'exact', value: 73 },
        hasMore: false,
      },
    );
    expect(details).toEqual({
      summary: 'Search: waldo',
      parameters: [
        { label: 'Terms', value: 'waldo' },
        { label: 'Roots', value: '/content/a, /content/b' },
        { label: 'Page size', value: '50' },
        { label: 'Pages', value: '2' },
        { label: 'Rows', value: '73' },
        { label: 'Total', value: '73' },
      ],
    });
  });
});
