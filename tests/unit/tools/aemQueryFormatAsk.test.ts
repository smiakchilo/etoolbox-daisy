import { describe, expect, it } from 'vitest';
import { NO_SKILLS } from '../../support/fakeSkillHost';
import {
  AEM_QUERY_FORMAT_ASK_TOOL_DESCRIPTOR,
  AEM_QUERY_FORMAT_ASK_TOOL_NAME,
  createAemQueryFormatAskExecutor,
} from '../../../src/tools/aem-query-format-ask/aemQueryFormatAsk';
import { renderer } from '../../../src/tools/aem-query-format-ask/renderer';
import { tool } from '../../../src/tools/aem-query-format-ask/tool';
import {
  type BrokerOutcome,
  type CurrentToolContext,
  type JsonValue,
  type Result,
  type ToolDiagnosticCode,
  type ToolError,
  type ToolHost,
  CONTENT_ROOT_DEFAULT,
  LOAD_ALL_ROW_LIMIT,
  SEARCH_PAGE_SIZE,
  ancestorPublicationPredicates,
  applyPublicationFilter,
  contentPublicationPredicates,
  createToolError,
  describePublication,
  err,
  ok,
} from '../../../src/shared';
import { flushMicrotasks as flush } from '../../support/asyncWaits';
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

const COUNT_CONTEXT: CurrentToolContext = {
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
  readonly currentContext?: () => CurrentToolContext;
  readonly count?: (url: string) => BrokerOutcome | Promise<BrokerOutcome>;
  readonly onDiagnostic?: (code: ToolDiagnosticCode) => void;
  /** DAM roots the facts report; omitted means none, so a default-roots test can prove order. */
  readonly damRoots?: readonly string[];
  /** Called with the actions the executor adds to the question that is pending. */
  readonly onAddActions?: (actions: readonly string[]) => void;
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
            damRoots: [...(options.damRoots ?? [])],
            contentPriorityPaths: [],
          },
    configuredHosts: () => [],
    skills: NO_SKILLS,
    openPage: () => Promise.resolve({ kind: 'no_view' }),
    requestUserInput: () => Promise.reject(new Error('the composite asks only through ask_user')),
    clock: () => 1,
    idGenerator: createCountingIdGenerator('qfa'),
    reportToolDiagnostic: (code) => {
      diagnostics.push(code);
      options.onDiagnostic?.(code);
    },
    addUserInputActions: (actions) => {
      options.onAddActions?.(actions);
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
const callContext = { toolCallId: 'call-1' as never, signal: undefined };

function payload(result: Result<JsonValue, ToolError>): Record<string, JsonValue> {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
  return result.value as Record<string, JsonValue>;
}

/** The buttons an ask_user call offered; their wording is the executor's own. */
function actionsOf(call: Invocation | undefined): readonly JsonValue[] {
  return (call?.args['actions'] as JsonValue[] | undefined) ?? [];
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
      // The whole search is one call, so it always ends the turn: the model is
      // not resumed for a "search is finished" completion (TURN_COMPLETE_RESULT_KEY).
      turnComplete: true,
      resultType: 'success',
    });
  });

  it('defaults to the content roots followed by the DAM roots', async () => {
    const { host, calls } = makeHost(
      (name) => (name === 'aem_query' ? ok(queryPage(2, false)) : ok(tableOk)),
      ['/content/site'],
      { damRoots: ['/content/dam/site'] },
    );
    const result = await createAemQueryFormatAskExecutor(host)({ terms: 'waldo' }, callContext);

    expect(calls[0]?.args['roots']).toEqual(['/content/site', '/content/dam/site']);
    expect(payload(result)['roots']).toEqual(['/content/site', '/content/dam/site']);
  });

  it('collapses a DAM root nested inside a content root, so a plain `/content` still covers DAM', async () => {
    const { host, calls } = makeHost(
      (name) => (name === 'aem_query' ? ok(queryPage(1, false)) : ok(tableOk)),
      ['/content'],
      { damRoots: ['/content/dam'] },
    );
    await createAemQueryFormatAskExecutor(host)({ terms: 'waldo' }, callContext);

    expect(calls[0]?.args['roots']).toEqual(['/content']);
  });

  it('uses explicit roots as given, without adding the DAM roots', async () => {
    const { host, calls } = makeHost(
      (name) => (name === 'aem_query' ? ok(queryPage(1, false)) : ok(tableOk)),
      ['/content/site'],
      { damRoots: ['/content/dam/site'] },
    );
    await createAemQueryFormatAskExecutor(host)(
      { terms: 'waldo', roots: ['/content/other'] },
      callContext,
    );

    expect(calls[0]?.args['roots']).toEqual(['/content/other']);
  });

  it('resolves a path fragment in roots before the query, here from a content root', async () => {
    const { host, calls } = makeHost(
      (name) => (name === 'aem_query' ? ok(queryPage(1, false)) : ok(tableOk)),
      ['/content/site/us/en', '/content/site/de'],
    );
    await createAemQueryFormatAskExecutor(host)({ terms: 'waldo', roots: ['us/en'] }, callContext);

    expect(calls.map((call) => call.name)).toEqual(['aem_query', 'format_table']);
    expect(calls[0]?.args['roots']).toEqual(['/content/site/us/en']);
  });

  it('asks the user, before any query, when a fragment resolves to nothing', async () => {
    const { host, calls } = makeHost(
      (name, args) => {
        if (name === 'ask_user') return ok({ selections: [], freeform: '/content/typed/us/en' });
        if (name === 'aem_query' && args['limit'] === 200) return ok(queryPage(0, false));
        return name === 'aem_query' ? ok(queryPage(1, false)) : ok(tableOk);
      },
      ['/content/site'],
    );
    await createAemQueryFormatAskExecutor(host)({ terms: 'waldo', roots: ['us/en'] }, callContext);

    expect(calls.map((call) => call.name)).toEqual([
      'aem_query',
      'ask_user',
      'aem_query',
      'format_table',
    ]);
    expect(calls[2]?.args['roots']).toEqual(['/content/typed/us/en']);
  });

  it('runs no search and shows no table when the user dismisses the scope question', async () => {
    const { host, calls } = makeHost((name) =>
      name === 'ask_user'
        ? err(createToolError('CANCELLED', 'dismissed', 'r' as never))
        : ok(queryPage(0, false)),
    );
    const result = await createAemQueryFormatAskExecutor(host)(
      { terms: 'waldo', roots: ['us/en'] },
      callContext,
    );

    expect(!result.ok && result.error.code).toBe('CANCELLED');
    expect(calls.map((call) => call.name)).toEqual(['aem_query', 'ask_user']);
  });

  it('refuses a description in words as a root, without calling anything', async () => {
    const { host, calls } = makeHost(() => ok(tableOk));
    const result = await createAemQueryFormatAskExecutor(host)(
      { terms: 'waldo', roots: ['the US site'] },
      callContext,
    );

    expect(!result.ok && result.error.code).toBe('INVALID_ARGUMENT');
    expect(calls).toEqual([]);
  });

  it('loads the next page on "Load more" and appends it', async () => {
    let queries = 0;
    const { host, calls } = makeHost((name, args) => {
      if (name === 'aem_query') {
        queries += 1;
        // A total far beyond the "Load all" budget: this test is about the
        // single-page Load more path, which stays the only button.
        return ok(
          queryPage(2, queries < 2, args['offset'] as number, { accuracy: 'exact', value: 5000 }),
        );
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
    expect(actionsOf(calls[2])).toHaveLength(1);
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

  it('defaults the roots to the shared content default when the host has no facts', async () => {
    const { host, calls } = makeHost((name) =>
      name === 'aem_query' ? ok(queryPage(0, false)) : ok(tableOk),
    );
    await createAemQueryFormatAskExecutor(host)({ terms: 'x' }, callContext);
    expect(calls[0]?.args['roots']).toEqual([CONTENT_ROOT_DEFAULT]);
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

  it('shows a component instance against its page and its path within it (detected from the query)', async () => {
    const { host, calls } = makeHost(
      (name) =>
        name === 'aem_query'
          ? ok({
              ok: true,
              operation: 'aem_query',
              rows: [
                { 'jcr:path': '/content/site/a/jcr:content/root/text' },
                { 'jcr:path': '/content/site/a/jcr:content/root/text_2' },
                { 'jcr:path': '/content/site/b/jcr:content/root/text' },
                // No `/jcr:content/`: left exactly as it came back.
                { 'jcr:path': '/content/site/c' },
              ],
              pagination: {
                offset: 0,
                limit: 50,
                returned: 4,
                hasMore: false,
                total: { accuracy: 'exact', value: 4 },
              },
              textResultForLlm: 'rows',
              resultType: 'success',
            })
          : ok(tableOk),
      ['/content/site'],
    );
    const result = await createAemQueryFormatAskExecutor(host)(
      { predicates: { type: 'nt:unstructured', property: 'sling:resourceType' } },
      callContext,
    );

    const tableData = calls[1]?.args['data'] as Record<string, JsonValue>;
    expect(tableData['rows']).toEqual([
      { 'jcr:path': '/content/site/a', node: 'jcr:content/root/text' },
      // The same page as the row above: its page path is blanked, the row kept.
      { 'jcr:path': '', node: 'jcr:content/root/text_2' },
      { 'jcr:path': '/content/site/b', node: 'jcr:content/root/text' },
      // No `/jcr:content/`: the page path alone, no node.
      { 'jcr:path': '/content/site/c' },
    ]);
    // The query is forwarded unchanged - the split is derived, never an argument.
    expect(calls[0]?.args['predicates']).toEqual({
      type: 'nt:unstructured',
      property: 'sling:resourceType',
    });
    expect(payload(result)).toMatchObject({ pages: 1, rows: 4, ended: 'exhausted' });
  });

  it('blanks a repeated page path across a Load more page boundary', async () => {
    // Page 1 ends on /content/site/a and page 2 opens on it again: the seam must
    // not repeat the page path (the blanking state outlives one page), and every
    // row is still present and numbered.
    let queries = 0;
    const { host, calls } = makeHost((name) => {
      if (name === 'aem_query') {
        queries += 1;
        const firstPage = queries === 1;
        return ok({
          ok: true,
          operation: 'aem_query',
          rows: firstPage
            ? [
                { 'jcr:path': '/content/site/a/jcr:content/root/text' },
                { 'jcr:path': '/content/site/a/jcr:content/root/text_2' },
              ]
            : [{ 'jcr:path': '/content/site/a/jcr:content/root/text_3' }],
          pagination: {
            offset: firstPage ? 0 : 2,
            limit: 2,
            returned: firstPage ? 2 : 1,
            hasMore: firstPage,
            total: { accuracy: 'exact', value: 3 },
          },
          textResultForLlm: 'rows',
          resultType: 'success',
        });
      }
      return ok(name === 'ask_user' ? loadMore : tableOk);
    });
    await createAemQueryFormatAskExecutor(host)(
      { predicates: { type: 'nt:unstructured', property: 'sling:resourceType' }, limit: 2 },
      callContext,
    );

    const first = calls[1]?.args['data'] as Record<string, JsonValue>;
    const second = calls[4]?.args['data'] as Record<string, JsonValue>;
    expect(first['rows']).toEqual([
      { 'jcr:path': '/content/site/a', node: 'jcr:content/root/text' },
      { 'jcr:path': '', node: 'jcr:content/root/text_2' },
    ]);
    expect(second['rows']).toEqual([{ 'jcr:path': '', node: 'jcr:content/root/text_3' }]);
  });

  it('leaves a path alone when the query is not a component search', async () => {
    const { host, calls } = makeHost(
      (name) =>
        name === 'aem_query'
          ? ok({
              ok: true,
              operation: 'aem_query',
              rows: [{ 'jcr:path': '/content/site/a/jcr:content/root/text' }],
              pagination: {
                offset: 0,
                limit: 50,
                returned: 1,
                hasMore: false,
                total: { accuracy: 'exact', value: 1 },
              },
              textResultForLlm: 'rows',
              resultType: 'success',
            })
          : ok(tableOk),
      ['/content/site'],
    );
    await createAemQueryFormatAskExecutor(host)(
      { predicates: { type: 'cq:Page', property: 'jcr:content/cq:template' } },
      callContext,
    );

    const tableData = calls[1]?.args['data'] as Record<string, JsonValue>;
    expect(tableData['rows']).toEqual([{ 'jcr:path': '/content/site/a/jcr:content/root/text' }]);
  });

  it('filters a plain-term search by publication, and echoes the filter, not the added predicates', async () => {
    const { host, calls } = makeHost(
      (name) => (name === 'aem_query' ? ok(queryPage(1, false)) : ok(tableOk)),
      ['/content/site'],
    );
    const result = await createAemQueryFormatAskExecutor(host)(
      { terms: 'waldo', publication: 'published' },
      callContext,
    );

    expect({ ok: true, predicates: calls[0]?.args['predicates'] }).toEqual(
      applyPublicationFilter({ fulltext: 'waldo' }, 'published'),
    );
    expect(payload(result)).toMatchObject({ terms: 'waldo', publication: 'published' });
  });

  it('echoes the original hand-built predicates when a publication filter is added', async () => {
    const { host, calls } = makeHost(
      (name) => (name === 'aem_query' ? ok(queryPage(1, false)) : ok(tableOk)),
      ['/content/site'],
    );
    const predicates = { type: 'cq:Page', property: 'jcr:content/cq:template' };
    const result = await createAemQueryFormatAskExecutor(host)(
      { predicates, publication: 'unpublished' },
      callContext,
    );

    expect(calls[0]?.args['predicates']).toEqual({
      ...predicates,
      ...contentPublicationPredicates('unpublished'),
    });
    expect(payload(result)['predicates']).toEqual(predicates);
    expect(payload(result)['publication']).toBe('unpublished');
  });

  it('still shows a filtered component search against its pages', async () => {
    const { host, calls } = makeHost(
      (name) =>
        name === 'aem_query'
          ? ok({
              ok: true,
              operation: 'aem_query',
              rows: [{ 'jcr:path': '/content/site/a/jcr:content/root/text' }],
              pagination: {
                offset: 0,
                limit: 50,
                returned: 1,
                hasMore: false,
                total: { accuracy: 'exact', value: 1 },
              },
              textResultForLlm: 'rows',
              resultType: 'success',
            })
          : ok(tableOk),
      ['/content/site'],
    );
    const predicates = { type: 'nt:unstructured', property: 'sling:resourceType' };
    await createAemQueryFormatAskExecutor(host)(
      { predicates, publication: 'published' },
      callContext,
    );

    expect(calls[0]?.args['predicates']).toEqual({
      ...predicates,
      ...ancestorPublicationPredicates('published'),
    });
    const tableData = calls[1]?.args['data'] as Record<string, JsonValue>;
    expect(tableData['rows']).toEqual([
      { 'jcr:path': '/content/site/a', node: 'jcr:content/root/text' },
    ]);
  });

  it('refuses a publication filter on a shape it cannot apply, without calling anything', async () => {
    const { host, calls } = makeHost(() => ok(tableOk), ['/content/site']);
    const result = await createAemQueryFormatAskExecutor(host)(
      { predicates: { type: 'nt:unstructured', fulltext: 'waldo' }, publication: 'published' },
      callContext,
    );

    expect(!result.ok && result.error.code).toBe('INVALID_ARGUMENT');
    expect(calls).toEqual([]);
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

describe('aem_query_format_ask "Load all"', () => {
  const loadAll: JsonValue = { selections: ['Load all'], freeform: null };

  it("offers Load all beside Load more when the page's own exact total fits the budget", async () => {
    const { host, calls } = makeHost(
      (name, args) => {
        if (name === 'aem_query') {
          const offset = args['offset'] as number;
          return ok(
            offset === 0
              ? queryPage(2, true, 0, { accuracy: 'exact', value: 4 })
              : queryPage(2, false, 2, { accuracy: 'exact', value: 4 }),
          );
        }
        return ok(name === 'ask_user' ? loadMore : tableOk);
      },
      ['/content/site'],
    );
    const result = await createAemQueryFormatAskExecutor(host)(
      { terms: 'waldo', limit: 2 },
      callContext,
    );

    expect(actionsOf(calls[2])).toHaveLength(2);
    expect(payload(result)).toMatchObject({ pages: 2, rows: 4, ended: 'exhausted' });
  });

  it('loads the whole remainder in one request on a Load all click, without asking again', async () => {
    const { host, calls } = makeHost(
      (name, args) => {
        if (name === 'aem_query') {
          const offset = args['offset'] as number;
          const limit = args['limit'] as number;
          const rows = Math.min(limit, 6 - offset);
          return ok(queryPage(rows, offset + rows < 6, offset, { accuracy: 'exact', value: 6 }));
        }
        return ok(name === 'ask_user' ? loadAll : tableOk);
      },
      ['/content/site'],
    );
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
    // One request for everything still missing, from where the table stopped.
    expect(calls[3]?.args).toMatchObject({ offset: 2, limit: 4 });
    expect(calls[4]?.args).toMatchObject({ mode: 'append' });
    expect(payload(result)).toMatchObject({ pages: 2, rows: 6, ended: 'exhausted' });
  });

  it('stops after the one Load all request even if the result still reports more', async () => {
    const { host, calls } = makeHost(
      (name, args) => {
        if (name === 'aem_query') {
          const offset = args['offset'] as number;
          return ok(queryPage(2, true, offset, { accuracy: 'exact', value: 6 }));
        }
        return ok(name === 'ask_user' ? loadAll : tableOk);
      },
      ['/content/site'],
    );
    const result = await createAemQueryFormatAskExecutor(host)(
      { terms: 'waldo', limit: 2 },
      callContext,
    );

    expect(calls.filter((call) => call.name === 'aem_query')).toHaveLength(2);
    expect(payload(result)).toMatchObject({ ended: 'stopped' });
  });

  it('does not offer Load all when the exact total exceeds the row budget', async () => {
    const { host, calls } = makeHost(
      (name, args) => {
        if (name === 'aem_query') {
          const offset = args['offset'] as number;
          const total = { accuracy: 'exact', value: LOAD_ALL_ROW_LIMIT + 3 } as const;
          return ok(offset === 0 ? queryPage(2, true, 0, total) : queryPage(2, false, 2, total));
        }
        return ok(name === 'ask_user' ? loadMore : tableOk);
      },
      ['/content/site'],
    );
    await createAemQueryFormatAskExecutor(host)({ terms: 'waldo', limit: 2 }, callContext);

    expect(actionsOf(calls[2])).toHaveLength(1);
  });

  /** A lower-bound page 1 whose count the test settles, with page 2 exact. */
  function lateCountHost(options: {
    readonly firstAsk: Promise<Result<JsonValue, ToolError>>;
    readonly count: Promise<BrokerOutcome>;
    readonly revealed: (readonly string[])[];
  }) {
    let asked = 0;
    return makeHost(
      (name, args) => {
        if (name === 'aem_query') {
          const offset = args['offset'] as number;
          return ok(
            offset < 4
              ? lowerBoundPage(2, true, offset)
              : queryPage(2, false, offset, { accuracy: 'exact', value: 6 }),
          );
        }
        if (name === 'ask_user') {
          asked += 1;
          return asked === 1 ? options.firstAsk : ok(loadMore);
        }
        return ok(tableOk);
      },
      ['/content/site'],
      {
        currentContext: () => COUNT_CONTEXT,
        count: () => options.count,
        onAddActions: (actions) => options.revealed.push(actions),
      },
    );
  }

  it('reveals Load all on the pending question the moment a lower-bound count settles', async () => {
    const gate = deferred<BrokerOutcome>();
    const firstAsk = deferred<Result<JsonValue, ToolError>>();
    const revealed: (readonly string[])[] = [];
    const { host, calls } = lateCountHost({
      firstAsk: firstAsk.promise,
      count: gate.promise,
      revealed,
    });

    const running = createAemQueryFormatAskExecutor(host)(
      { terms: 'waldo', limit: 2 },
      callContext,
    );
    await flush();

    // Page 1's question went up with Load more only: the total was still counting.
    expect(actionsOf(calls.find((call) => call.name === 'ask_user'))).toHaveLength(1);
    expect(revealed).toEqual([]);

    // The count settles (it fits): the same question gains Load all.
    gate.resolve(countResponse(6));
    await flush();
    expect(revealed).toHaveLength(1);

    firstAsk.resolve(ok(loadMore));
    await running;

    // What was revealed is exactly the button a later question carries.
    const asks = calls.filter((call) => call.name === 'ask_user');
    expect(asks).toHaveLength(2);
    expect(actionsOf(asks[1])[1]).toBe(revealed[0]?.[0]);
  });

  it('reveals nothing when the settled total is beyond the page budget', async () => {
    const gate = deferred<BrokerOutcome>();
    const firstAsk = deferred<Result<JsonValue, ToolError>>();
    const revealed: (readonly string[])[] = [];
    const { host } = lateCountHost({ firstAsk: firstAsk.promise, count: gate.promise, revealed });

    const running = createAemQueryFormatAskExecutor(host)(
      { terms: 'waldo', limit: 2 },
      callContext,
    );
    await flush();
    gate.resolve(countResponse(5000));
    await flush();
    firstAsk.resolve(ok(loadMore));
    await running;

    expect(revealed).toEqual([]);
  });

  it('reveals nothing when the count fails', async () => {
    const gate = deferred<BrokerOutcome>();
    const firstAsk = deferred<Result<JsonValue, ToolError>>();
    const revealed: (readonly string[])[] = [];
    const { host } = lateCountHost({ firstAsk: firstAsk.promise, count: gate.promise, revealed });

    const running = createAemQueryFormatAskExecutor(host)(
      { terms: 'waldo', limit: 2 },
      callContext,
    );
    await flush();
    gate.resolve({ kind: 'cancelled' });
    await flush();
    firstAsk.resolve(ok(loadMore));
    await running;

    expect(revealed).toEqual([]);
  });

  it('reveals nothing once the question is answered, even if the count settles later', async () => {
    const gate = deferred<BrokerOutcome>();
    const revealed: (readonly string[])[] = [];
    const { host } = lateCountHost({
      firstAsk: Promise.resolve(ok({ selections: [], freeform: null })),
      count: gate.promise,
      revealed,
    });

    await createAemQueryFormatAskExecutor(host)({ terms: 'waldo', limit: 2 }, callContext);
    gate.resolve(countResponse(6));
    await flush();

    expect(revealed).toEqual([]);
  });

  it('reveals nothing while the next page loads between two questions', async () => {
    const gate = deferred<BrokerOutcome>();
    const nextPage = deferred<Result<JsonValue, ToolError>>();
    const secondAsk = deferred<Result<JsonValue, ToolError>>();
    const revealed: (readonly string[])[] = [];
    let asked = 0;
    const { host } = makeHost(
      (name, args) => {
        if (name === 'aem_query') {
          return (args['offset'] as number) === 0
            ? ok(lowerBoundPage(2, true, 0))
            : nextPage.promise;
        }
        if (name === 'ask_user') {
          asked += 1;
          return asked === 1 ? ok(loadMore) : secondAsk.promise;
        }
        return ok(tableOk);
      },
      ['/content/site'],
      {
        currentContext: () => COUNT_CONTEXT,
        count: () => gate.promise,
        onAddActions: (actions) => revealed.push(actions),
      },
    );

    const running = createAemQueryFormatAskExecutor(host)(
      { terms: 'waldo', limit: 2 },
      callContext,
    );
    await flush();
    gate.resolve(countResponse(6));
    await flush();
    expect(revealed).toEqual([]);

    nextPage.resolve(ok(lowerBoundPage(2, false, 2)));
    secondAsk.resolve(ok({ selections: [], freeform: null }));
    await running;
  });

  it('does not reveal a button the question already carries', async () => {
    const revealed: (readonly string[])[] = [];
    const { host } = makeHost(
      (name, args) => {
        if (name === 'aem_query') {
          const offset = args['offset'] as number;
          return ok(queryPage(2, offset === 0, offset, { accuracy: 'exact', value: 4 }));
        }
        return ok(name === 'ask_user' ? loadMore : tableOk);
      },
      ['/content/site'],
      { onAddActions: (actions) => revealed.push(actions) },
    );
    await createAemQueryFormatAskExecutor(host)({ terms: 'waldo', limit: 2 }, callContext);

    expect(revealed).toEqual([]);
  });

  it('treats a Load all answer as Load more when the total no longer fits the budget', async () => {
    const { host, calls } = makeHost(
      (name, args) => {
        if (name === 'aem_query') {
          const offset = args['offset'] as number;
          return ok(queryPage(2, offset < 4, offset, { accuracy: 'exact', value: 5000 }));
        }
        return ok(name === 'ask_user' ? loadAll : tableOk);
      },
      ['/content/site'],
    );
    await createAemQueryFormatAskExecutor(host)({ terms: 'waldo', limit: 2 }, callContext);

    // One question per page: a forged Load all never switched on unbounded paging.
    expect(calls.filter((call) => call.name === 'ask_user').length).toBeGreaterThan(1);
  });
});

describe('aem_query_format_ask background count', () => {
  it('counts with the publication filter, so the honest total is the filtered one', async () => {
    const { host, countUrls } = makeHost(
      (name) => (name === 'aem_query' ? ok(lowerBoundPage(2, false)) : ok(tableOk)),
      ['/content/site'],
      { currentContext: () => COUNT_CONTEXT, count: () => countResponse(7) },
    );
    await createAemQueryFormatAskExecutor(host)(
      { predicates: { type: 'cq:Page' }, publication: 'unpublished' },
      callContext,
    );
    await flush();

    expect(countUrls).toHaveLength(1);
    const params = new URL(countUrls[0] ?? '').searchParams;
    for (const [key, value] of Object.entries(contentPublicationPredicates('unpublished'))) {
      expect(params.get(key)).toBe(value);
    }
  });

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
    expect(settle?.args['totalLine']).toContain('1234');

    // A later page keeps the exact total and shows no spinner.
    ask.resolve(ok(loadMore));
    const result = await running;
    expect(payload(result)).toMatchObject({
      pages: 2,
      total: { accuracy: 'exact', value: 1234 },
      ended: 'exhausted',
    });
    const lastPage = calls.filter((call) => call.name === 'format_table').at(-1);
    expect(lastPage?.args['totalLine']).toContain('1234');
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

describe('aem_query_format_ask renderer', () => {
  it('derives its summary from the call arguments and adds rows once the search finished', () => {
    const byTerms = renderer.describeCall({ terms: 'waldo', limit: 20 });
    const byPredicates = renderer.describeCall({
      predicates: { type: 'cq:Page', fulltext: 'waldo' },
    });
    const finished = renderer.describeCall(
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

    expect(byTerms.summary).toContain('waldo');
    expect(byPredicates.summary).toContain('waldo');
    expect(finished.summary).toContain('waldo');
    expect(finished.parameters.length).toBeGreaterThan(byTerms.parameters.length);
    expect(finished.parameters.some((row) => row.value.includes('73'))).toBe(true);
  });

  it('adds a publication row only when the search is filtered, distinct per state', () => {
    const plain = renderer.describeCall({ terms: 'waldo' });
    const published = renderer.describeCall({ terms: 'waldo', publication: 'published' });
    const unpublished = renderer.describeCall({ terms: 'waldo', publication: 'unpublished' });

    expect(published.parameters).toHaveLength(plain.parameters.length + 1);
    expect(unpublished.parameters).toHaveLength(plain.parameters.length + 1);
    const added = (details: typeof published) =>
      details.parameters.find((row) => !plain.parameters.some((p) => p.label === row.label));
    expect(added(published)?.value).toBe(describePublication('published'));
    expect(added(unpublished)?.value).toBe(describePublication('unpublished'));
  });
});
