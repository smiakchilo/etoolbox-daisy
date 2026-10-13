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
  type BrokerOutcome,
  type CurrentAemToolContext,
  type JsonValue,
  type Result,
  type ToolDiagnosticCode,
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
) => Result<JsonValue, ToolError> | Promise<Result<JsonValue, ToolError>>;

/**
 * A page fixture. Its total defaults to **exact**, so no background count is
 * started unless a test explicitly passes an `atLeast` total - which keeps the
 * pre-count scenarios focused on the loop itself. `hasMore: true` with an exact
 * total is a legitimate state (the guess cap was not reached but a later page
 * still exists).
 */
function queryPage(
  rows: number,
  hasMore: boolean | 'unknown',
  offset = 0,
  total?: JsonValue,
): JsonValue {
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
      total: total ?? { accuracy: 'exact', value: offset + rows + (hasMore === false ? 0 : 10) },
    },
    textResultForLlm: 'rows',
    resultType: 'success',
  };
}

/** A page whose total is a lower bound (the guess cap was reached). */
function lowerBoundPage(rows: number, hasMore: boolean | 'unknown', offset = 0): JsonValue {
  return queryPage(rows, hasMore, offset, { accuracy: 'atLeast', value: 100 });
}

const tableOk: JsonValue = { operation: 'format_table', resultType: 'success' };
const loadMore: JsonValue = { selections: ['Load more'], freeform: null };

const COUNT_CONTEXT: CurrentAemToolContext = {
  origin: 'https://aem.example',
  serverId: 'server-1' as never,
  serverRevision: 1,
  navigationEpoch: 0,
  chatId: 'chat-1' as never,
  turnId: 'turn-1' as never,
};

function countResponse(total: number): BrokerOutcome {
  return {
    kind: 'response',
    status: 200,
    contentType: 'application/json',
    bodyText: JSON.stringify({ success: true, hits: [], total }),
  };
}

interface HostOptions {
  /** Supplied only in count tests; the default throws to prove no count ran. */
  readonly currentContext?: () => CurrentAemToolContext;
  readonly count?: (url: string) => BrokerOutcome | Promise<BrokerOutcome>;
  readonly onDiagnostic?: (code: ToolDiagnosticCode) => void;
}

function makeHost(
  responder: Responder,
  contentRoots?: readonly string[],
  options: HostOptions = {},
) {
  const calls: Invocation[] = [];
  const countUrls: string[] = [];
  const diagnostics: ToolDiagnosticCode[] = [];
  const host: ToolHost = {
    bridge: {
      request: (_envelope, url) => {
        countUrls.push(url);
        return Promise.resolve(
          options.count?.(url) ?? ({ kind: 'cancelled' } satisfies BrokerOutcome),
        );
      },
    },
    currentContext:
      options.currentContext ??
      (() => {
        throw new Error('the composite must reach AEM only through aem_query');
      }),
    environmentFacts: () =>
      contentRoots === undefined
        ? undefined
        : {
            origin: 'https://aem.example',
            contentRoots,
            componentRoots: ['/apps'],
            contentPriorityPaths: [],
          },
    configuredHosts: () => [],
    openPage: () => Promise.resolve({ kind: 'no_view' }),
    requestUserInput: () => Promise.reject(new Error('the composite asks only through ask_user')),
    clock: () => 1,
    idGenerator: createCountingIdGenerator('qfa'),
    reportToolDiagnostic: (code) => {
      diagnostics.push(code);
      options.onDiagnostic?.(code);
    },
    invokeTool: (name, args) => {
      calls.push({ name, args });
      return Promise.resolve(responder(name, args));
    },
  };
  return { host, calls, countUrls, diagnostics };
}

/** A promise whose resolution the test controls. */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets pending microtasks/promise chains run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
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

describe('aem_query_format_ask background count', () => {
  it('starts no count when page 1 is exact (never even reaches for a context)', async () => {
    const { host, calls, countUrls } = makeHost((name) =>
      name === 'aem_query' ? ok(queryPage(2, false)) : ok(tableOk),
    );
    await createAemQueryFormatAskExecutor(host)({ terms: 'x' }, callContext);
    expect(countUrls).toEqual([]);
    // The default host throws from `currentContext`, so a count would reject
    // rather than silently pass; the call list proves none ran.
    expect(
      calls.every((call) => call.name !== 'format_table' || call.args['totalPending'] !== true),
    ).toBe(true);
  });

  it('runs one count when page 1 is a lower bound, and settles the total in place during the ask', async () => {
    const gate = deferred<BrokerOutcome>();
    const ask = deferred<Result<JsonValue, ToolError>>();
    const { host, calls, countUrls, diagnostics } = makeHost(
      (name, args) => {
        if (name === 'aem_query') {
          const offset = args['offset'] as number;
          return ok(offset === 0 ? lowerBoundPage(2, true) : queryPage(2, false, 2));
        }
        if (name === 'ask_user') return ask.promise;
        return ok(tableOk);
      },
      ['/content/site'],
      { currentContext: () => COUNT_CONTEXT, count: () => gate.promise },
    );
    const running = createAemQueryFormatAskExecutor(host)(
      { terms: 'waldo', limit: 2 },
      callContext,
    );
    await flush();

    // Page 1 is on screen with the spinner flag, and exactly one count request
    // (no guessTotal) reached the bridge.
    const page1 = calls.find((call) => call.name === 'format_table');
    expect(page1?.args['totalPending']).toBe(true);
    expect(page1?.args['mode']).toBe('new');
    expect(countUrls).toHaveLength(1);
    expect(new URL(countUrls[0] ?? '').searchParams.getAll('p.guessTotal')).toEqual([]);
    expect(new URL(countUrls[0] ?? '').searchParams.get('path')).toBe('/content/site');
    expect(diagnostics).toEqual([]);

    // The count settles while the turn waits on the question: an extra append
    // carries the exact total and clears the spinner.
    gate.resolve(countResponse(1234));
    await flush();
    const settle = calls.filter((call) => call.name === 'format_table').at(-1);
    const settleData = settle?.args['data'] as Record<string, JsonValue>;
    expect(settle?.args['mode']).toBe('append');
    expect(settle?.args['totalPending']).toBe(false);
    expect((settleData['rows'] as readonly JsonValue[]).length).toBe(0);
    expect(settle?.args['totalLine']).toBe('Total: 1234 results');

    // A later page keeps the exact total and shows no spinner.
    ask.resolve(ok(loadMore));
    const result = await running;
    expect(payload(result)).toMatchObject({
      pages: 2,
      total: { accuracy: 'exact', value: 1234 },
      ended: 'exhausted',
    });
    const lastPage = calls.filter((call) => call.name === 'format_table').at(-1);
    expect(lastPage?.args['totalLine']).toBe('Total: 1234 results');
    expect(lastPage?.args['totalPending']).toBe(false);
  });

  it('keeps the fallback and logs AEM_COUNT_FAILED when the count request fails', async () => {
    const { host, calls, countUrls, diagnostics } = makeHost(
      (name, args) => {
        if (name === 'aem_query') {
          return ok(
            (args['offset'] as number) === 0
              ? lowerBoundPage(2, true)
              : lowerBoundPage(2, false, 2),
          );
        }
        return ok(name === 'ask_user' ? loadMore : tableOk);
      },
      ['/content/site'],
      {
        currentContext: () => COUNT_CONTEXT,
        count: () => ({ kind: 'network_error', message: 'x' }),
      },
    );
    const result = await createAemQueryFormatAskExecutor(host)(
      { terms: 'waldo', limit: 2 },
      callContext,
    );

    expect(countUrls).toHaveLength(1);
    expect(diagnostics).toEqual(['AEM_COUNT_FAILED']);
    // The table keeps page 2's fallback line; the settle call carried none.
    const settle = calls.filter((call) => call.name === 'format_table').at(-1);
    expect(settle?.args['totalPending']).toBe(false);
    expect(settle?.args).not.toHaveProperty('totalLine');
    expect(payload(result)['total']).toMatchObject({ accuracy: 'atLeast', value: 100 });
  });

  it('aborts a never-resolving count when the search ends, and leaves no spinner', async () => {
    const gate = deferred<BrokerOutcome>();
    const { host, calls } = makeHost(
      (name) => {
        if (name === 'aem_query') return ok(lowerBoundPage(2, 'unknown'));
        // The user declines the question: the loop ends "stopped".
        if (name === 'ask_user') return ok({ selections: [], freeform: null });
        return ok(tableOk);
      },
      ['/content/site'],
      { currentContext: () => COUNT_CONTEXT, count: () => gate.promise },
    );
    const result = await createAemQueryFormatAskExecutor(host)({ terms: 'waldo' }, callContext);

    const settle = calls.filter((call) => call.name === 'format_table').at(-1);
    expect(settle?.args['totalPending']).toBe(false);
    expect(payload(result)).toMatchObject({ ended: 'stopped' });
    // Resolving the abandoned count afterwards must not enqueue a second settle.
    const before = calls.length;
    gate.resolve(countResponse(7));
    await flush();
    expect(calls.length).toBe(before);
  });

  it('starts at most one count across several lower-bound pages', async () => {
    let queries = 0;
    const { host, countUrls } = makeHost(
      (name, args) => {
        if (name === 'aem_query') {
          queries += 1;
          // Two lower-bound pages, then an exhausted exact page.
          return ok(
            queries < 3
              ? lowerBoundPage(2, true, args['offset'] as number)
              : queryPage(1, false, args['offset'] as number),
          );
        }
        return ok(name === 'ask_user' ? loadMore : tableOk);
      },
      ['/content/site'],
      { currentContext: () => COUNT_CONTEXT, count: () => countResponse(500) },
    );
    await createAemQueryFormatAskExecutor(host)({ terms: 'waldo', limit: 2 }, callContext);
    expect(countUrls).toHaveLength(1);
  });

  it('sums one count request per effective root, sequentially', async () => {
    const { host, countUrls } = makeHost(
      (name) => (name === 'aem_query' ? ok(lowerBoundPage(2, false)) : ok(tableOk)),
      ['/content/a', '/content/b'],
      { currentContext: () => COUNT_CONTEXT, count: () => countResponse(10) },
    );
    const result = await createAemQueryFormatAskExecutor(host)({ terms: 'waldo' }, callContext);
    expect(countUrls).toHaveLength(2);
    expect(new URL(countUrls[0] ?? '').searchParams.get('path')).toBe('/content/a');
    expect(new URL(countUrls[1] ?? '').searchParams.get('path')).toBe('/content/b');
    expect(payload(result)['total']).toMatchObject({ accuracy: 'exact', value: 20 });
  });

  it('does not enqueue a settle for a count that resolves after an early error', async () => {
    const gate = deferred<BrokerOutcome>();
    const failure = createToolError('NETWORK_ERROR', 'down', 'r' as never);
    const { host, calls } = makeHost(
      (name, args) => {
        if (name === 'aem_query') {
          return (args['offset'] as number) === 0 ? ok(lowerBoundPage(2, true)) : err(failure);
        }
        return ok(name === 'ask_user' ? loadMore : tableOk);
      },
      ['/content/site'],
      { currentContext: () => COUNT_CONTEXT, count: () => gate.promise },
    );
    const result = await createAemQueryFormatAskExecutor(host)(
      { terms: 'waldo', limit: 2 },
      callContext,
    );
    expect(result).toEqual({ ok: false, error: failure });

    // The count resolves after the executor returned: it must not append a
    // second settle table into a run that is already over.
    const before = calls.length;
    gate.resolve(countResponse(999));
    await flush();
    expect(calls.length).toBe(before);
  });
});

describe('describeSearchTotal', () => {
  it('words exact, at-least and unknown totals', () => {
    expect(describeSearchTotal({ accuracy: 'exact', value: 3 }, false)).toBe('3');
    expect(describeSearchTotal({ accuracy: 'atLeast', value: 9 }, true)).toBe('9+');
    expect(describeSearchTotal({ accuracy: 'atLeast', value: 9 }, 'unknown')).toBe('at least 9');
    expect(describeSearchTotal({ accuracy: 'estimated', value: 9 }, true)).toBe('9+');
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
