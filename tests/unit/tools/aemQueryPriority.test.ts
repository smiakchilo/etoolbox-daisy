import { describe, expect, it } from 'vitest';
import { executeAemQuery } from '../../../src/tools/aem-query/aemQuery';
import { type BrokerOutcome, type ToolHost } from '../../../src/shared';
import { tool } from '../../../src/tools/aem-query/tool';
import { aemQueryEnvelope as envelope } from '../../support/aemQueryEnvelope';
import { createCountingIdGenerator } from '../../support/testIds';

const ORIGIN = 'https://author.example';

const inside = (node: string, root: string): boolean =>
  node === root || node.startsWith(`${root}/`);

/**
 * A repository that answers the QueryBuilder parameters the application sends:
 * `path`, an `excludepaths` regex, `p.offset` and `p.limit`. Hits come back in
 * path order, like a real traversal; `total` is exact.
 */
function repository(nodes: readonly string[]): {
  readonly fetch: (url: string) => Promise<BrokerOutcome>;
  readonly urls: URL[];
} {
  const sorted = [...nodes].sort();
  const urls: URL[] = [];
  const fetch = (raw: string): Promise<BrokerOutcome> => {
    const url = new URL(raw);
    urls.push(url);
    const params = url.searchParams;
    const root = params.get('path') ?? '/';
    const exclusion = params.get('excludepaths');
    const excluded = exclusion === null ? undefined : new RegExp(exclusion);
    const matching = sorted.filter(
      (node) => inside(node, root) && !(excluded?.test(node) ?? false),
    );
    const offset = Number(params.get('p.offset') ?? '0');
    const limit = Number(params.get('p.limit') ?? '10');
    const page = matching.slice(offset, offset + limit);
    return Promise.resolve({
      kind: 'response',
      status: 200,
      contentType: 'application/json',
      bodyText: JSON.stringify({
        success: true,
        hits: page.map((path) => ({ 'jcr:path': path })),
        total: matching.length,
        more: offset + page.length < matching.length,
      }),
    });
  };
  return { fetch, urls };
}

function deps(
  fetch: (url: string) => Promise<BrokerOutcome>,
  priorityPaths?: readonly string[],
): Parameters<typeof executeAemQuery>[1] {
  return { origin: ORIGIN, fetchThroughBridge: fetch, now: () => 1_000, priorityPaths };
}

const NODES = [
  '/content/a/blueprint/1',
  '/content/a/blueprint/2',
  '/content/a/language/en/1',
  '/content/a/language/en/2',
  '/content/a/language/en/deep/1',
  '/content/a/language/fr/1',
  '/content/a/other/1',
  '/content/a/other/2',
  '/content/a/other/3',
  '/content/b/1',
  '/content/b/2',
];
const PRIORITIES = ['/content/a/blueprint', '/content/a/language/en'];

/** The ordered result computed independently: priorities in order, then the rest. */
function expectedOrder(nodes: readonly string[], priorities: readonly string[]): string[] {
  const sorted = [...nodes].sort();
  const first = priorities.flatMap((priority) => sorted.filter((node) => inside(node, priority)));
  return [...first, ...sorted.filter((node) => !first.includes(node))];
}

async function readAll(
  args: Record<string, unknown>,
  limit: number,
  fetch: (url: string) => Promise<BrokerOutcome>,
  priorities: readonly string[],
): Promise<{ paths: string[]; lastHasMore: unknown; pages: number }> {
  const paths: string[] = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    const result = await executeAemQuery(
      envelope({ ...args, offset, limit }),
      deps(fetch, priorities),
    );
    if (!result.ok) throw new Error(`query failed: ${result.error.code}`);
    pages += 1;
    paths.push(...result.rows.map((row) => String((row as Record<string, unknown>)['jcr:path'])));
    if (result.pagination.hasMore !== true || pages > 100) {
      return { paths, lastHasMore: result.pagination.hasMore, pages };
    }
    offset += limit;
  }
}

describe('aem_query tool priority wiring', () => {
  function toolHost(
    facts: ToolHost['environmentFacts'],
    fetch: (url: string) => Promise<BrokerOutcome>,
  ): ToolHost {
    return {
      bridge: { request: (_envelope, url) => fetch(url) },
      currentContext: () => ({
        origin: ORIGIN,
        serverId: 'srv' as never,
        serverRevision: 1,
        navigationEpoch: 1,
        chatId: 'chat' as never,
        turnId: 'turn' as never,
      }),
      environmentFacts: facts,
      configuredHosts: () => [],
      openPage: () => Promise.resolve({ kind: 'no_view' }),
      requestUserInput: () => Promise.reject(new Error('not used')),
      clock: () => 1,
      idGenerator: createCountingIdGenerator('tw'),
      invokeTool: () => Promise.reject(new Error('not used')),
    };
  }

  const run = (host: ToolHost) =>
    tool.createExecutor(host)(
      { predicates: {}, roots: ['/content/a'], limit: 50 },
      { toolCallId: 'call-1' as never, signal: undefined },
    );

  it("orders by the host's priority paths read from the environment facts at run time", async () => {
    const { fetch } = repository(NODES);
    const result = await run(
      toolHost(
        () => ({
          origin: ORIGIN,
          contentRoots: ['/content/a'],
          componentRoots: ['/apps'],
          damRoots: ['/content/dam'],
          contentPriorityPaths: PRIORITIES,
        }),
        fetch,
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.value as Record<string, unknown>;
    expect(payload['priorityPaths']).toEqual(PRIORITIES);
    expect((payload['rows'] as Array<Record<string, string>>)[0]?.['jcr:path']).toBe(
      '/content/a/blueprint/1',
    );
  });

  it('runs the ordinary query when the pane is on no configured host', async () => {
    const { fetch, urls } = repository(NODES);
    const result = await run(toolHost(() => undefined, fetch));
    expect(result.ok).toBe(true);
    expect(urls).toHaveLength(1);
  });
});

describe('executeAemQuery priority paths', () => {
  it.each([1, 2, 3, 4, 5, 7, 100])(
    'pages through the ordered result with no seam, gap or duplicate (limit %i)',
    async (limit) => {
      const { fetch } = repository(NODES);
      const { paths, lastHasMore } = await readAll(
        { predicates: { type: 'cq:Page' }, roots: ['/content/a', '/content/b'] },
        limit,
        fetch,
        PRIORITIES,
      );
      expect(paths).toEqual(expectedOrder(NODES, PRIORITIES));
      expect(lastHasMore).toBe(false);
    },
  );

  it('keeps a single root ordered and reports the priority paths that applied', async () => {
    const { fetch } = repository(NODES);
    const result = await executeAemQuery(
      envelope({ predicates: {}, roots: ['/content/a'], limit: 4 }),
      deps(fetch, [...PRIORITIES, '/content/b']),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.priorityPaths).toEqual(PRIORITIES);
    expect(result.rows.map((row) => (row as Record<string, unknown>)['jcr:path'])).toEqual([
      '/content/a/blueprint/1',
      '/content/a/blueprint/2',
      '/content/a/language/en/1',
      '/content/a/language/en/2',
    ]);
    expect(result.pagination.hasMore).toBe(true);
  });

  it('knows a page that ends exactly at the end of the result has no more', async () => {
    const { fetch } = repository(NODES);
    const result = await executeAemQuery(
      envelope({ predicates: {}, roots: ['/content/a', '/content/b'], limit: NODES.length }),
      deps(fetch, PRIORITIES),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(NODES.length);
    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.total).toEqual({ accuracy: 'exact', value: NODES.length });
  });

  it('does not add the one-row probes of later segments to the total', async () => {
    const { fetch } = repository(NODES);
    // A guessTotal-style server: the total is only what the request itself reached.
    const guessing = async (raw: string): Promise<BrokerOutcome> => {
      const outcome = await fetch(raw);
      if (outcome.kind !== 'response') return outcome;
      const body = JSON.parse(outcome.bodyText) as { hits: unknown[] };
      const offset = Number(new URL(raw).searchParams.get('p.offset') ?? '0');
      return {
        ...outcome,
        bodyText: JSON.stringify({ ...body, total: offset + body.hits.length }),
      };
    };
    const result = await executeAemQuery(
      envelope({ predicates: {}, roots: ['/content/a'], limit: 2 }),
      deps(guessing, PRIORITIES),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(2);
    expect(result.pagination.hasMore).toBe(true);
    expect(result.pagination.total).toEqual({ accuracy: 'atLeast', value: 2 });
  });

  it('excludes the priority paths from the rest of the scope with excludepaths', async () => {
    const { fetch, urls } = repository(NODES);
    await executeAemQuery(
      envelope({ predicates: {}, roots: ['/content/a'], limit: 50 }),
      deps(fetch, PRIORITIES),
    );
    const remainder = urls.find((url) => url.searchParams.has('excludepaths'));
    expect(remainder?.searchParams.get('path')).toBe('/content/a');
    expect(remainder?.searchParams.get('excludepaths')).toBe(
      '^(/content/a/blueprint|/content/a/language/en)/.*$',
    );
  });

  it("keeps the model's own excludepaths alongside the priority exclusion", async () => {
    const { fetch, urls } = repository(NODES);
    await executeAemQuery(
      envelope({
        predicates: { excludepaths: '^/content/a/other/.*$' },
        roots: ['/content/a'],
        limit: 50,
      }),
      deps(fetch, PRIORITIES),
    );
    const remainder = urls.find((url) => url.searchParams.get('path') === '/content/a');
    expect(remainder).toBeDefined();
    expect(remainder?.searchParams.get('excludepaths')).toBe(
      '(?:^/content/a/other/.*$)|(?:^(/content/a/blueprint|/content/a/language/en)/.*$)',
    );
  });

  it('orders a plain path predicate too', async () => {
    const { fetch } = repository(NODES);
    const result = await executeAemQuery(
      envelope({ predicates: { path: '/content/a' }, limit: 3 }),
      deps(fetch, PRIORITIES),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roots).toBeUndefined();
    expect(result.priorityPaths).toEqual(PRIORITIES);
    expect(result.rows.map((row) => (row as Record<string, unknown>)['jcr:path'])).toEqual([
      '/content/a/blueprint/1',
      '/content/a/blueprint/2',
      '/content/a/language/en/1',
    ]);
  });

  it('leaves a query alone when no priority path lies strictly inside its scope', async () => {
    const { fetch, urls } = repository(NODES);
    const result = await executeAemQuery(
      envelope({ predicates: {}, roots: ['/content/b'], limit: 5 }),
      deps(fetch, PRIORITIES),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.priorityPaths).toBeUndefined();
    expect(urls).toHaveLength(1);
    expect(urls[0]?.searchParams.has('excludepaths')).toBe(false);
  });

  it.each([
    ['no priority paths', []],
    ['an undefined priority list', undefined],
  ] as const)('is unchanged with %s', async (_name, priorities) => {
    const { fetch, urls } = repository(NODES);
    const result = await executeAemQuery(
      envelope({ predicates: {}, roots: ['/content/a'], limit: 5 }),
      deps(fetch, priorities),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.priorityPaths).toBeUndefined();
    expect(urls).toHaveLength(1);
  });

  it('does not reorder a path predicate that carries path sub-keys', async () => {
    const { fetch, urls } = repository(NODES);
    const result = await executeAemQuery(
      envelope({ predicates: { path: '/content/a', 'path.flat': 'true' }, limit: 5 }),
      deps(fetch, PRIORITIES),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.priorityPaths).toBeUndefined();
    expect(urls).toHaveLength(1);
  });

  it('degrades to an unknown continuation rather than guessing an offset', async () => {
    const calls: string[] = [];
    const fetch = (raw: string): Promise<BrokerOutcome> => {
      calls.push(raw);
      // Fewer rows than asked, yet `more` claims there are others: contradictory.
      return Promise.resolve({
        kind: 'response',
        status: 200,
        contentType: 'application/json',
        bodyText: JSON.stringify({
          success: true,
          hits: [{ 'jcr:path': '/content/a/blueprint/1' }],
          total: 9,
          more: true,
        }),
      });
    };
    const result = await executeAemQuery(
      envelope({ predicates: {}, roots: ['/content/a'], limit: 5 }),
      deps(fetch, PRIORITIES),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.pagination.hasMore).toBe('unknown');
    expect(result.pagination.total).toEqual({ accuracy: 'unknown' });
    expect(calls).toHaveLength(1);
  });

  it('still rejects roots combined with a path predicate', async () => {
    const { fetch } = repository(NODES);
    const result = await executeAemQuery(
      envelope({ predicates: { path: '/content/a' }, roots: ['/content/a'] }),
      deps(fetch, PRIORITIES),
    );
    expect(result.ok).toBe(false);
  });
});
