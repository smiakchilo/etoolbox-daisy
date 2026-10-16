import { describe, expect, it } from 'vitest';
import { NO_SKILLS } from '../../support/fakeSkillHost';
import {
  AEM_SEMANTIC_SEARCH_TOOL_DESCRIPTOR,
  AEM_SEMANTIC_SEARCH_TOOL_NAME,
  buildContentReadUrl,
  createAemSemanticSearchExecutor,
  extractExcerpts,
} from '../../../src/tools/aem-semantic-search/aemSemanticSearch';
import { renderer } from '../../../src/tools/aem-semantic-search/renderer';
import { tool } from '../../../src/tools/aem-semantic-search/tool';
import {
  type BrokerOutcome,
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

const ORIGIN = 'https://aem.example';

function queryPage(paths: readonly string[], hasMore: boolean | 'unknown'): JsonValue {
  return {
    ok: true,
    operation: 'aem_query',
    rows: paths.map((path) => ({ 'jcr:path': path })),
    pagination: { hasMore, total: { accuracy: 'atLeast', value: 7 } },
    textResultForLlm: 'rows',
    resultType: 'success',
  };
}

const tableOk: JsonValue = { operation: 'format_table', resultType: 'success' };
const noAnswer: JsonValue = { selections: [], freeform: null };

/** Answers an ask_user call by clicking the first action it offered. */
function clickFirstAction(args: Readonly<Record<string, JsonValue>>): JsonValue {
  const actions = args['actions'] as string[];
  return { selections: [actions[0] as string], freeform: null };
}

/** A content read answers with the hit's own node carrying a text naming the hit. */
function contentFor(url: string): BrokerOutcome {
  const path = new URL(url).searchParams.get('path') ?? '';
  return {
    kind: 'response',
    status: 200,
    contentType: 'application/json',
    bodyText: JSON.stringify({
      success: true,
      hits: [{ 'jcr:path': path, text: `<p>Waldo at ${path}</p>`, 'jcr:primaryType': 'x' }],
    }),
  };
}

function makeHost(
  responder: Responder,
  read: (url: string) => BrokerOutcome = contentFor,
  contentRoots: readonly string[] = ['/content/site'],
  damRoots: readonly string[] = [],
) {
  const calls: Invocation[] = [];
  const reads: string[] = [];
  const host: ToolHost = {
    bridge: {
      request: (_envelope, url) => {
        reads.push(url);
        return Promise.resolve(read(url));
      },
    },
    currentContext: () => ({
      origin: ORIGIN,
      serverId: 'srv' as never,
      serverRevision: 1,
      navigationEpoch: 1,
      chatId: 'chat' as never,
      turnId: 'turn' as never,
    }),
    environmentFacts: () => ({
      origin: ORIGIN,
      contentRoots,
      componentRoots: ['/apps'],
      damRoots,
      contentPriorityPaths: [],
    }),
    configuredHosts: () => [],
    skills: NO_SKILLS,
    openPage: () => Promise.resolve({ kind: 'no_view' }),
    requestUserInput: () => Promise.reject(new Error('asks only through ask_user')),
    clock: () => 1,
    idGenerator: createCountingIdGenerator('sem'),
    invokeTool: (name, args) => {
      calls.push({ name, args });
      return Promise.resolve(responder(name, args));
    },
  };
  return { host, calls, reads };
}

const callContext = { toolCallId: 'call-1' as never, signal: undefined };

function payload(result: Result<JsonValue, ToolError>): Record<string, JsonValue> {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
  return result.value as Record<string, JsonValue>;
}

function tableData(call: Invocation | undefined): Record<string, JsonValue> {
  return call?.args['data'] as Record<string, JsonValue>;
}

const paths = (count: number, from = 0): string[] =>
  Array.from({ length: count }, (_, index) => `/content/site/p${String(from + index)}`);

describe('aem_semantic_search manifest', () => {
  it('declares its parts and its name', () => {
    expect(tool.name).toBe(AEM_SEMANTIC_SEARCH_TOOL_NAME);
    expect(tool.descriptor).toBe(AEM_SEMANTIC_SEARCH_TOOL_DESCRIPTOR);
    expect(tool.allowlistEntry).toBe('custom:aem_semantic_search');
    expect(tool.uses).toEqual(['aem_query', 'format_table', 'ask_user']);
  });
});

describe('aem_semantic_search executor', () => {
  it('queries one page, reads EVERY hit and returns them all as candidates', async () => {
    const { host, calls, reads } = makeHost(() => ok(queryPage(paths(6), true)));
    const result = await createAemSemanticSearchExecutor(host)(
      { terms: 'Waldo', context: 'Waldo is good' },
      callContext,
    );

    expect(calls.map((call) => call.name)).toEqual(['aem_query']);
    expect(calls[0]?.args).toEqual({
      predicates: { fulltext: 'Waldo' },
      roots: ['/content/site'],
      properties: [],
      limit: SEARCH_PAGE_SIZE,
      offset: 0,
    });
    expect(reads).toHaveLength(6);
    const value = payload(result);
    expect(value).toMatchObject({
      operation: 'aem_semantic_search',
      searchId: expect.any(String) as unknown,
      candidates: 6,
      candidatesRead: 6,
      page: 1,
    });
    // Call A returns candidates to judge: it must never end the turn.
    expect(value['turnComplete']).toBeUndefined();
    const text = value['textResultForLlm'] as string;
    for (const path of paths(6)) {
      expect(text).toContain(path);
    }
    expect(text).toContain('Waldo at /content/site/p0');
  });

  it('defaults to the content roots followed by the DAM roots', async () => {
    const { host, calls } = makeHost(
      () => ok(queryPage(paths(2), false)),
      contentFor,
      ['/content/site'],
      ['/content/dam/site'],
    );
    const result = await createAemSemanticSearchExecutor(host)(
      { terms: 'Waldo', context: 'Waldo is good' },
      callContext,
    );

    expect(calls[0]?.args['roots']).toEqual(['/content/site', '/content/dam/site']);
    expect(payload(result)['roots']).toEqual(['/content/site', '/content/dam/site']);
  });

  it('resolves a path fragment in roots before the query, here from a content root', async () => {
    const { host, calls } = makeHost(() => ok(queryPage(paths(2), false)), contentFor, [
      '/content/site/us/en',
      '/content/site/de',
    ]);
    const result = await createAemSemanticSearchExecutor(host)(
      { terms: 'Waldo', context: 'Waldo is good', roots: ['us/en'] },
      callContext,
    );

    expect(calls.map((call) => call.name)).toEqual(['aem_query']);
    expect(calls[0]?.args['roots']).toEqual(['/content/site/us/en']);
    expect(payload(result)['roots']).toEqual(['/content/site/us/en']);
  });

  it('asks the user, before the search, when a fragment resolves to nothing, and ends if dismissed', async () => {
    const { host, calls } = makeHost((name, args) =>
      name === 'ask_user'
        ? err(createToolError('CANCELLED', 'dismissed', 'r' as never))
        : ok(queryPage(args['limit'] === 200 ? [] : paths(2), false)),
    );
    const result = await createAemSemanticSearchExecutor(host)(
      { terms: 'Waldo', context: 'Waldo is good', roots: ['us/en'] },
      callContext,
    );

    expect(!result.ok && result.error.code).toBe('CANCELLED');
    expect(calls.map((call) => call.name)).toEqual(['aem_query', 'ask_user']);
  });

  it('refuses a description in words as a root, without calling anything', async () => {
    const { host, calls } = makeHost(() => ok(queryPage(paths(1), false)));
    const result = await createAemSemanticSearchExecutor(host)(
      { terms: 'Waldo', context: 'Waldo is good', roots: ['the US site'] },
      callContext,
    );

    expect(!result.ok && result.error.code).toBe('INVALID_ARGUMENT');
    expect(calls).toEqual([]);
  });

  it('shows the judged matches, offers a click-through, and returns the next page to judge', async () => {
    let queries = 0;
    const { host, calls } = makeHost((name, args) => {
      if (name === 'aem_query') {
        queries += 1;
        return ok(queryPage(paths(3, (queries - 1) * 3), queries < 2));
      }
      return ok(name === 'ask_user' ? clickFirstAction(args) : tableOk);
    });
    const execute = createAemSemanticSearchExecutor(host);
    const started = payload(
      await execute({ terms: 'Waldo', context: 'good', limit: 3 }, callContext),
    );
    const searchId = started['searchId'] as string;

    const second = payload(
      await execute({ searchId, matches: [3, { candidate: 1, excerpt: 1 }] }, callContext),
    );
    expect(calls.map((call) => call.name)).toEqual([
      'aem_query',
      'format_table',
      'ask_user',
      'aem_query',
    ]);
    const firstTable = calls[1];
    expect(firstTable?.args['mode']).toBe('new');
    expect(firstTable?.args['totalLine']).toContain('2');
    expect(tableData(firstTable)['rows']).toEqual([
      {
        'jcr:path': '/content/site/p2',
        property: 'text',
        citation: 'Waldo at /content/site/p2',
      },
      {
        'jcr:path': '/content/site/p0',
        property: 'text',
        citation: 'Waldo at /content/site/p0',
      },
    ]);
    expect(tableData(firstTable)['pagination']).toMatchObject({ hasMore: true });
    expect(calls[2]?.args).toEqual({ actions: [expect.any(String) as unknown] });
    expect(calls[3]?.args['offset']).toBe(3);
    expect(second).toMatchObject({ searchId, candidates: 3, page: 2, matchesShown: 2 });
    // A page of candidates still has to be judged, so the turn continues.
    expect(second['turnComplete']).toBeUndefined();

    const finished = payload(await execute({ searchId, matches: [] }, callContext));
    expect(calls[4]?.name).toBe('format_table');
    expect(calls[4]?.args['mode']).toBe('append');
    expect(tableData(calls[4])['rows']).toEqual([]);
    expect(calls[4]?.args['totalLine']).toContain('2');
    expect(calls).toHaveLength(5);
    expect(finished).toMatchObject({
      ended: 'exhausted',
      matchesShown: 2,
      candidatesRead: 6,
      // The search is over, so this call ends the turn (TURN_COMPLETE_RESULT_KEY).
      turnComplete: true,
    });
  });

  it('still gives a total line while nothing has matched', async () => {
    const { host, calls } = makeHost((name) =>
      ok(name === 'aem_query' ? queryPage(paths(2), true) : noAnswer),
    );
    const execute = createAemSemanticSearchExecutor(host);
    const searchId = payload(await execute({ terms: 'x', context: 'y' }, callContext))[
      'searchId'
    ] as string;
    const result = payload(await execute({ searchId, matches: [] }, callContext));

    expect(typeof calls[1]?.args['totalLine']).toBe('string');
    expect(calls[1]?.args['totalLine']).not.toBe('');
    expect(result).toMatchObject({ ended: 'stopped', matchesShown: 0 });
  });

  it('ends as stopped when the Load more question is cancelled', async () => {
    const { host } = makeHost((name) => {
      if (name === 'aem_query') return ok(queryPage(paths(1), 'unknown'));
      if (name === 'ask_user') return err(createToolError('CANCELLED', 'no', 'r' as never));
      return ok(tableOk);
    });
    const execute = createAemSemanticSearchExecutor(host);
    const searchId = payload(await execute({ terms: 'x', context: 'y' }, callContext))[
      'searchId'
    ] as string;
    expect(payload(await execute({ searchId, matches: [1] }, callContext))).toMatchObject({
      ended: 'stopped',
      matchesShown: 1,
    });
    const again = await execute({ searchId, matches: [] }, callContext);
    expect(!again.ok && again.error.code).toBe('INVALID_ARGUMENT');
  });

  it('skips straight past pages with no hits and still reports a total', async () => {
    const { host, calls, reads } = makeHost((name) =>
      ok(name === 'aem_query' ? queryPage([], false) : tableOk),
    );
    const result = payload(
      await createAemSemanticSearchExecutor(host)({ terms: 'x', context: 'y' }, callContext),
    );
    expect(reads).toEqual([]);
    expect(calls.map((call) => call.name)).toEqual(['aem_query', 'format_table']);
    expect(typeof calls[1]?.args['totalLine']).toBe('string');
    expect(calls[1]?.args['totalLine']).not.toBe('');
    expect(result).toMatchObject({ ended: 'exhausted' });
  });

  it('falls back to the hit itself when no node contains the terms, and marks unreadable hits', async () => {
    const read = (url: string): BrokerOutcome => {
      const params = new URL(url).searchParams;
      if (params.get('path') === '/content/site/p1') return { kind: 'network_error', message: 'x' };
      if (params.has('fulltext')) {
        return {
          kind: 'response',
          status: 200,
          contentType: 'application/json',
          bodyText: '{"success":true,"hits":[]}',
        };
      }
      return contentFor(url);
    };
    const { host, reads } = makeHost(() => ok(queryPage(paths(2), false)), read);
    const value = payload(
      await createAemSemanticSearchExecutor(host)({ terms: 'Waldo', context: 'y' }, callContext),
    );
    expect(reads).toHaveLength(4);
    const text = value['textResultForLlm'] as string;
    expect(text).toContain('Waldo at /content/site/p0');
    expect(text).toContain('/content/site/p1');
  });

  it('cancels the whole call when a read is cancelled', async () => {
    const { host } = makeHost(
      () => ok(queryPage(paths(3), true)),
      () => ({ kind: 'cancelled' }),
    );
    const result = await createAemSemanticSearchExecutor(host)(
      { terms: 'x', context: 'y' },
      callContext,
    );
    expect(!result.ok && result.error.code).toBe('CANCELLED');
  });

  it('rejects an unknown searchId, an out-of-range candidate and incomplete arguments', async () => {
    const { host, calls } = makeHost(() => ok(queryPage(paths(2), true)));
    const execute = createAemSemanticSearchExecutor(host);
    const unknown = await execute({ searchId: 'nope', matches: [] }, callContext);
    expect(!unknown.ok && unknown.error.code).toBe('INVALID_ARGUMENT');

    const searchId = payload(await execute({ terms: 'x', context: 'y' }, callContext))[
      'searchId'
    ] as string;
    const outOfRange = await execute({ searchId, matches: [3] }, callContext);
    expect(!outOfRange.ok && outOfRange.error.code).toBe('INVALID_ARGUMENT');
    expect(calls.map((call) => call.name)).toEqual(['aem_query']);

    for (const args of [{}, { terms: 'x' }, { searchId }, { terms: 'x', context: 'y', extra: 1 }]) {
      const result = await execute(args, callContext);
      expect(!result.ok && result.error.code).toBe('INVALID_ARGUMENT');
    }
  });

  it('honours an already-aborted signal', async () => {
    const { host, calls } = makeHost(() => ok(tableOk));
    const controller = new AbortController();
    controller.abort();
    const result = await createAemSemanticSearchExecutor(host)(
      { terms: 'x', context: 'y' },
      { toolCallId: 'call-1' as never, signal: controller.signal },
    );
    expect(!result.ok && result.error.code).toBe('CANCELLED');
    expect(calls).toEqual([]);
  });

  it('reports reading progress while it reads the page', async () => {
    const progress: string[] = [];
    const { host } = makeHost(() => ok(queryPage(paths(3), true)));
    const withProgress: ToolHost = {
      ...host,
      reportToolProgress: (_toolCallId, text) => {
        progress.push(text);
      },
    };
    await createAemSemanticSearchExecutor(withProgress)(
      { terms: 'Waldo', context: 'y', limit: 3 },
      callContext,
    );
    // One "0 of n" before the reads start, then one per completed read.
    expect(progress[0]).toMatch(/0\D+3/);
    expect(progress).toHaveLength(4);
    expect(progress.at(-1)).toMatch(/3\D+3/);
  });

  it('puts the concrete node path and the property name in the table, not the hit', async () => {
    // A text property that lives on a descendant of the hit: the table's Path
    // must be that node, and Property its own name - not the page the query
    // matched, and not a relative label.
    const descendantContent = (url: string): BrokerOutcome => {
      const path = new URL(url).searchParams.get('path') ?? '';
      return {
        kind: 'response',
        status: 200,
        contentType: 'application/json',
        bodyText: JSON.stringify({
          success: true,
          hits: [
            {
              'jcr:path': `${path}/jcr:content/text`,
              text: '<p>Waldo lives here</p>',
            },
          ],
        }),
      };
    };
    const { host, calls } = makeHost(
      (name) => ok(name === 'aem_query' ? queryPage(['/content/site/p'], false) : tableOk),
      descendantContent,
    );
    const execute = createAemSemanticSearchExecutor(host);
    const started = payload(await execute({ terms: 'Waldo', context: 'y' }, callContext));
    // The model still reads the excerpt by its hit-relative label...
    expect(started['textResultForLlm'] as string).toContain('Waldo lives here');
    await execute({ searchId: started['searchId'] as string, matches: [1] }, callContext);
    const table = calls.find((call) => call.name === 'format_table');
    // ...while the table shows the concrete node and the bare property name.
    expect(tableData(table)['rows']).toEqual([
      {
        'jcr:path': '/content/site/p/jcr:content/text',
        property: 'text',
        citation: 'Waldo lives here',
      },
    ]);
  });
});

describe('buildContentReadUrl', () => {
  it('builds a same-origin QueryBuilder read of the hit and its descendants', () => {
    const url = new URL(buildContentReadUrl(ORIGIN, '/content/site/a b', 'Waldo good') ?? '');
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe('/bin/querybuilder.json');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      path: '/content/site/a b',
      'path.self': 'true',
      fulltext: 'Waldo good',
      'p.hits': 'full',
      'p.limit': '10',
      'p.guessTotal': 'true',
    });
    expect(url.searchParams.has('p.nodedepth')).toBe(false);
  });

  it('omits fulltext when no terms are given and refuses unusable input', () => {
    expect(buildContentReadUrl(ORIGIN, '/content/a', undefined)).not.toContain('fulltext');
    expect(buildContentReadUrl('not an origin', '/content/a', undefined)).toBeUndefined();
    expect(buildContentReadUrl(ORIGIN, '', undefined)).toBeUndefined();
  });
});

describe('extractExcerpts', () => {
  it('keeps readable text, drops system properties and paths, and puts term hits first', () => {
    const excerpts = extractExcerpts(
      '/content/p',
      [
        {
          'jcr:path': '/content/p/jcr:content',
          'jcr:title': 'Title',
          'cq:template': '/conf/x',
          'sling:resourceType': 'x/y',
          link: '/content/other',
        },
        {
          'jcr:path': '/content/p/jcr:content/text',
          text: '<p>Waldo&nbsp;is   kind</p>',
          tags: ['a', 'b'],
        },
      ],
      'waldo',
    );
    expect(excerpts).toEqual([
      { nodePath: '/content/p/jcr:content/text', name: 'text', text: 'Waldo is kind' },
      { nodePath: '/content/p/jcr:content', name: 'jcr:title', text: 'Title' },
      { nodePath: '/content/p/jcr:content/text', name: 'tags', text: 'a, b' },
    ]);
  });

  it('windows a long text around the first term', () => {
    const long = `${'x '.repeat(200)}Waldo ${'y '.repeat(200)}`;
    const [excerpt] = extractExcerpts('/c', [{ 'jcr:path': '/c', text: long }], 'Waldo');
    expect(excerpt?.text).toContain('Waldo');
    expect(excerpt?.text.startsWith('...')).toBe(true);
    expect(excerpt?.text.endsWith('...')).toBe(true);
  });
});

describe('aem_semantic_search renderer', () => {
  it("keys a call's summary on its own arguments, not on the result it echoes", () => {
    const start = renderer.describeCall({ terms: 'Waldo', context: 'Waldo is good' });
    const resumed = renderer.describeCall(
      { searchId: 's-1', matches: [1] },
      { operation: 'aem_semantic_search', terms: 'Waldo', page: 2, matchesShown: 1 },
    );

    expect(start.summary).toContain('Waldo');
    expect(resumed.summary?.trim().length).toBeGreaterThan(0);
    expect(resumed.summary).not.toBe(start.summary);
    expect(resumed.summary).not.toContain('Waldo');
    expect(resumed.parameters.length).toBeGreaterThan(0);
  });
});
