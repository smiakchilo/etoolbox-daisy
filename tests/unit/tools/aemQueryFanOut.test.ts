import { describe, expect, it } from 'vitest';
import { createAemQueryExecutor, executeAemQuery } from '../../../src/tools/aem-query/aemQuery';
import {
  type BrokerOutcome,
  type CurrentAemToolContext,
  newChatId,
  newServerId,
  newTurnId,
} from '../../../src/shared';
import { aemQueryEnvelope as envelope } from '../../support/aemQueryEnvelope';
import { createCountingIdGenerator } from '../../support/testIds';

const ORIGIN = 'https://author.example';

function queryBody(hits: readonly string[], total: number, more: boolean): string {
  return JSON.stringify({
    success: true,
    hits: hits.map((path) => ({ 'jcr:path': path })),
    total,
    more,
  });
}

/** A bridge that answers per `path` predicate and records every URL it was asked. */
function responder(byRoot: Readonly<Record<string, string>>): {
  readonly fetch: (url: string) => Promise<BrokerOutcome>;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const fetch = (url: string): Promise<BrokerOutcome> => {
    calls.push(url);
    const root = new URL(url).searchParams.get('path') ?? '';
    const body = byRoot[root] ?? queryBody([], 0, false);
    return Promise.resolve({
      kind: 'response',
      status: 200,
      contentType: 'application/json',
      bodyText: body,
    });
  };
  return { fetch, calls };
}

function deps(fetch: (url: string) => Promise<BrokerOutcome>): {
  readonly origin: string;
  readonly fetchThroughBridge: (url: string) => Promise<BrokerOutcome>;
  readonly now: () => number;
} {
  return { origin: ORIGIN, fetchThroughBridge: fetch, now: () => 1_000 };
}

describe('executeAemQuery root fan-out', () => {
  it('runs one query per root and merges the rows, reporting the effective roots', async () => {
    const { fetch, calls } = responder({
      '/content/a': queryBody(['/content/a/1'], 1, false),
      '/content/b': queryBody(['/content/b/1', '/content/b/2'], 2, true),
    });

    const result = await executeAemQuery(
      envelope({ predicates: { type: 'cq:Page' }, roots: ['/content/a', '/content/b'] }),
      deps(fetch),
    );

    expect(calls).toHaveLength(2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roots).toEqual(['/content/a', '/content/b']);
    expect(result.rows).toEqual([
      { 'jcr:path': '/content/a/1' },
      { 'jcr:path': '/content/b/1' },
      { 'jcr:path': '/content/b/2' },
    ]);
    expect(result.pagination.hasMore).toBe(true);
    // root a is exact (1), root b is a lower bound (2+) -> the sum is a lower bound.
    expect(result.pagination.total).toEqual({ accuracy: 'atLeast', value: 3 });
  });

  it('collapses a root nested inside another before querying', async () => {
    const { fetch, calls } = responder({ '/content/a': queryBody(['/content/a/1'], 1, false) });

    const result = await executeAemQuery(
      envelope({ predicates: {}, roots: ['/content/a/b', '/content/a'] }),
      deps(fetch),
    );

    expect(calls).toHaveLength(1);
    expect(new URL(calls[0] ?? '').searchParams.get('path')).toBe('/content/a');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.roots).toEqual(['/content/a']);
  });

  it('applies offset and limit to each root (lockstep)', async () => {
    const { fetch, calls } = responder({
      '/content/a': queryBody(['/content/a/1'], 10, true),
      '/content/b': queryBody(['/content/b/1'], 10, true),
    });

    await executeAemQuery(
      envelope({ predicates: {}, roots: ['/content/a', '/content/b'], offset: 5, limit: 7 }),
      deps(fetch),
    );

    for (const url of calls) {
      const params = new URL(url).searchParams;
      expect(params.get('p.offset')).toBe('5');
      expect(params.get('p.limit')).toBe('7');
    }
  });

  it('de-duplicates a path returned by more than one root', async () => {
    const { fetch } = responder({
      '/content/a': queryBody(['/content/shared/1'], 1, false),
      '/content/b': queryBody(['/content/shared/1'], 1, false),
    });

    const result = await executeAemQuery(
      envelope({ predicates: {}, roots: ['/content/a', '/content/b'] }),
      deps(fetch),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows).toEqual([{ 'jcr:path': '/content/shared/1' }]);
  });

  it('rejects combining roots with a path predicate, without touching the bridge', async () => {
    const { fetch, calls } = responder({});

    const result = await executeAemQuery(
      envelope({ predicates: { path: '/content/a' }, roots: ['/content/a'] }),
      deps(fetch),
    );

    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
    }
  });

  it('runs a single query with no roots reporting, when roots are absent', async () => {
    const { fetch, calls } = responder({ '/content/a': queryBody(['/content/a/1'], 1, false) });

    const result = await executeAemQuery(
      envelope({ predicates: { path: '/content/a' } }),
      deps(fetch),
    );

    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.roots).toBeUndefined();
  });
});

describe('aem_query executor root validation', () => {
  function context(ids: ReturnType<typeof createCountingIdGenerator>): CurrentAemToolContext {
    return {
      origin: ORIGIN,
      serverId: newServerId(ids),
      serverRevision: 1,
      navigationEpoch: 0,
      chatId: newChatId(ids),
      turnId: newTurnId(ids),
    };
  }

  function executor(): ReturnType<typeof createAemQueryExecutor> {
    const ids = createCountingIdGenerator('q');
    return createAemQueryExecutor({
      execute: (request, deps) =>
        executeAemQuery(request, {
          origin: deps.origin,
          fetchThroughBridge: deps.fetchThroughBridge,
          now: deps.now,
        }),
      runtimeDeps: {
        fetchThroughBridge: () => Promise.resolve({ kind: 'cancelled' as const }),
        now: () => 1,
      },
      currentContext: () => context(ids),
      clock: () => 1,
      idGenerator: ids,
    });
  }

  it('rejects a root that is not a JCR path at the arguments boundary', async () => {
    const result = await executor()(
      { predicates: {}, roots: ['not-a-path'] },
      { toolCallId: 'call-1' as never, signal: undefined },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_ARGUMENT');
  });

  it('rejects an empty roots list at the arguments boundary', async () => {
    const result = await executor()(
      { predicates: {}, roots: [] },
      { toolCallId: 'call-1' as never, signal: undefined },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_ARGUMENT');
  });
});
