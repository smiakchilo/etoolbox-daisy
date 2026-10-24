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
import { formatTableColumnsSchema } from '../../../src/tools/format-table/formatTable';
import {
  type BrokerOutcome,
  type JsonValue,
  type AnswerRequest,
  type AnswerResult,
  type Result,
  type ToolError,
  type ToolHost,
  applySearchFilters,
  createToolError,
  describeSearchFilters,
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

type ReadResult = BrokerOutcome | Promise<BrokerOutcome>;

type AnswerResponder = (
  request: AnswerRequest,
  attempt: number,
) => AnswerResult | Promise<AnswerResult>;

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

/** An answer response that marks exactly `matches` (1-based) as true. */
const matching =
  (...matches: number[]): AnswerResponder =>
  (request) =>
    ok(
      request.items.map((item) => ({
        id: item.id,
        match: matches.includes(Number(item.id)),
      })),
    );

const allMatch = (request: AnswerRequest): AnswerResult =>
  ok(request.items.map((item) => ({ id: item.id, match: true })));

interface HostOptions {
  readonly read?: (url: string) => ReadResult;
  /** Omitted entirely means the host has no answer capability. */
  readonly answer?: AnswerResponder;
  readonly contentRoots?: readonly string[];
  readonly damRoots?: readonly string[];
}

function makeHost(responder: Responder, options: HostOptions = {}) {
  const calls: Invocation[] = [];
  const reads: string[] = [];
  const answers: AnswerRequest[] = [];
  let answerAttempts = 0;
  const host: ToolHost = {
    bridge: {
      request: async (_envelope, url) => {
        reads.push(url);
        return options.read === undefined ? contentFor(url) : await options.read(url);
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
      contentRoots: options.contentRoots ?? ['/content/site'],
      componentRoots: ['/apps'],
      damRoots: options.damRoots ?? [],
      contentPriorityPaths: [],
    }),
    configuredHosts: () => [],
    skills: NO_SKILLS,
    openPage: () => Promise.resolve({ kind: 'no_view' }),
    requestUserInput: () => Promise.reject(new Error('asks only through ask_user')),
    ...(options.answer === undefined
      ? {}
      : {
          answer: (request: AnswerRequest) => {
            answers.push(request);
            answerAttempts += 1;
            return Promise.resolve(options.answer!(request, answerAttempts));
          },
        }),
    clock: () => 1,
    idGenerator: createCountingIdGenerator('sem'),
    invokeTool: (name, args) => {
      calls.push({ name, args });
      return Promise.resolve(responder(name, args));
    },
  };
  return { host, calls, reads, answers };
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

const callNames = (calls: readonly Invocation[]): string[] => calls.map((call) => call.name);

describe('aem_semantic_search manifest', () => {
  it('declares its parts and its name', () => {
    expect(tool.name).toBe(AEM_SEMANTIC_SEARCH_TOOL_NAME);
    expect(tool.descriptor).toBe(AEM_SEMANTIC_SEARCH_TOOL_DESCRIPTOR);
    expect(tool.allowlistEntry).toBe('custom:aem_semantic_search');
    expect(tool.uses).toEqual(['aem_query', 'format_table', 'ask_user']);
  });

  it('takes only the search arguments, never a search id or verdicts', () => {
    const properties = AEM_SEMANTIC_SEARCH_TOOL_DESCRIPTOR.parameters as {
      readonly properties?: Readonly<Record<string, unknown>>;
    };
    expect(Object.keys(properties.properties ?? {})).toEqual([
      'terms',
      'context',
      'roots',
      'limit',
      'filters',
    ]);
  });
});

describe('aem_semantic_search executor', () => {
  it('runs the whole search in one call: query, read every hit, answer, show, finish', async () => {
    const { host, calls, reads, answers } = makeHost(() => ok(queryPage(paths(6), false)), {
      answer: allMatch,
    });
    const result = await createAemSemanticSearchExecutor(host)(
      { terms: 'Waldo', context: 'Waldo is good' },
      callContext,
    );

    expect(callNames(calls)).toEqual(['aem_query', 'format_table']);
    expect(calls[0]?.args).toMatchObject({
      predicates: { fulltext: 'Waldo' },
      roots: ['/content/site'],
      properties: [],
      offset: 0,
    });
    expect(reads).toHaveLength(6);
    // One model call answers the whole page, with the context as the instruction.
    expect(answers).toHaveLength(1);
    expect(answers[0]?.instruction).toBe('Waldo is good');
    expect(answers[0]?.items.map((item) => item.id)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(answers[0]?.items[0]?.text).toContain('/content/site/p0');
    expect(answers[0]?.items[0]?.text).toContain('Waldo at /content/site/p0');
    const value = payload(result);
    expect(value).toMatchObject({
      operation: 'aem_semantic_search',
      terms: 'Waldo',
      page: 1,
      candidatesRead: 6,
      matchesShown: 6,
      ended: 'exhausted',
      turnComplete: true,
    });
    // The model never receives candidates or a search id any more.
    expect(value['candidates']).toBeUndefined();
    expect(value['searchId']).toBeUndefined();
    expect(tableData(calls[1])['rows']).toHaveLength(6);
    expect(calls[1]?.args['mode']).toBe('new');
  });

  it('probes further pages, with no table until a page of matches is answered', async () => {
    let queries = 0;
    const { host, calls, answers } = makeHost(
      (name) => {
        if (name === 'aem_query') {
          queries += 1;
          // Page 2 is AEM's last.
          return ok(queryPage(paths(2, (queries - 1) * 2), queries < 2));
        }
        return ok(name === 'ask_user' ? noAnswer : tableOk);
      },
      {
        // Page 1 yields one match; page 2's first candidate yields the second.
        answer: (request) =>
          Number(request.items[0]?.text.includes('/p2')) === 1
            ? matching(1)(request, 1)
            : matching(2)(request, 1),
      },
    );
    const value = payload(
      await createAemSemanticSearchExecutor(host)(
        { terms: 'Waldo', context: 'good', limit: 2 },
        callContext,
      ),
    );

    // Two queries, two answer calls, and only then one table. Page 2 is AEM's
    // last, so the filled page needs no "Load more".
    expect(callNames(calls)).toEqual(['aem_query', 'aem_query', 'format_table']);
    expect(answers).toHaveLength(2);
    expect(value).toMatchObject({ ended: 'exhausted', matchesShown: 2, candidatesRead: 4 });
    expect(tableData(calls[2])['rows']).toEqual([
      { 'jcr:path': '/content/site/p1', property: 'text', citation: 'Waldo at /content/site/p1' },
      { 'jcr:path': '/content/site/p2', property: 'text', citation: 'Waldo at /content/site/p2' },
    ]);
    expect(calls[2]?.args['totalLine']).toBe('Total: 2');
  });

  it('keeps probing when a page matches nothing instead of painting an empty table', async () => {
    let queries = 0;
    const { host, calls, answers } = makeHost(
      (name) => {
        if (name === 'aem_query') {
          queries += 1;
          return ok(queryPage(paths(2, (queries - 1) * 2), queries < 2));
        }
        return ok(name === 'ask_user' ? noAnswer : tableOk);
      },
      {
        // Page 1 matches nothing; page 2's candidates both match.
        answer: (request) =>
          request.items[0]?.text.includes('/p2') === true
            ? matching(1, 2)(request, 1)
            : matching()(request, 1),
      },
    );
    const value = payload(
      await createAemSemanticSearchExecutor(host)(
        { terms: 'Waldo', context: 'good', limit: 2 },
        callContext,
      ),
    );

    expect(callNames(calls)).toEqual(['aem_query', 'aem_query', 'format_table']);
    expect(answers).toHaveLength(2);
    expect(value).toMatchObject({ ended: 'exhausted', matchesShown: 2 });
    // No table was painted for the zero-match first page.
    expect(calls.filter((call) => call.name === 'format_table')).toHaveLength(1);
  });

  it('shows a short final page when AEM is exhausted below the page size, and never asks', async () => {
    const { host, calls } = makeHost(() => ok(queryPage(paths(2), false)), { answer: allMatch });
    const value = payload(
      await createAemSemanticSearchExecutor(host)(
        { terms: 'Waldo', context: 'good', limit: 5 },
        callContext,
      ),
    );

    expect(callNames(calls)).toEqual(['aem_query', 'format_table']);
    expect(tableData(calls[1])['rows']).toHaveLength(2);
    expect(calls[1]?.args['totalLine']).toBe('Total: 2');
    expect(value).toMatchObject({ ended: 'exhausted', matchesShown: 2, turnComplete: true });
  });

  it('paints the empty total line only when the whole search is exhausted', async () => {
    const { host, calls } = makeHost(() => ok(queryPage(paths(2), false)), {
      answer: matching(),
    });
    const value = payload(
      await createAemSemanticSearchExecutor(host)({ terms: 'Waldo', context: 'good' }, callContext),
    );

    expect(callNames(calls)).toEqual(['aem_query', 'format_table']);
    expect(tableData(calls[1])['rows']).toEqual([]);
    expect(calls[1]?.args['totalLine']).toBe('Did not find any relevant results');
    expect(value).toMatchObject({ ended: 'exhausted', matchesShown: 0, turnComplete: true });
  });

  it('keeps a surplus of answered matches for the next click, without re-querying or re-answering', async () => {
    let queries = 0;
    const { host, calls, answers } = makeHost(
      (name, args) => {
        if (name === 'aem_query') {
          queries += 1;
          return ok(queryPage(paths(2, (queries - 1) * 2), queries < 2));
        }
        return ok(name === 'ask_user' ? clickFirstAction(args) : tableOk);
      },
      {
        answer: (request) =>
          request.items[0]?.text.includes('/p2') === true
            ? matching(1, 2)(request, 1)
            : matching(1)(request, 1),
      },
    );
    const value = payload(
      await createAemSemanticSearchExecutor(host)(
        { terms: 'Waldo', context: 'good', limit: 2 },
        callContext,
      ),
    );

    // Page 1 gives one match, page 2 gives two: 3 answered, a page of 2 shown, the
    // surplus shown on the answered click - with no further query or judgment.
    expect(queries).toBe(2);
    expect(answers).toHaveLength(2);
    const tables = calls.filter((call) => call.name === 'format_table');
    expect(tables).toHaveLength(2);
    expect(tableData(tables[0])['rows']).toHaveLength(2);
    expect(tables[0]?.args['totalLine']).toBe('Total: 2 so far');
    expect(tables[1]?.args['mode']).toBe('append');
    expect(tableData(tables[1])['rows']).toHaveLength(1);
    expect(tables[1]?.args['totalLine']).toBe('Total: 3');
    expect(value).toMatchObject({ ended: 'exhausted', matchesShown: 3, turnComplete: true });
  });

  it('stops when the Load more question is cancelled', async () => {
    const { host } = makeHost(
      (name) => {
        if (name === 'aem_query') return ok(queryPage(paths(1), 'unknown'));
        if (name === 'ask_user') return err(createToolError('CANCELLED', 'no', 'r' as never));
        return ok(tableOk);
      },
      { answer: allMatch },
    );
    const value = payload(
      await createAemSemanticSearchExecutor(host)(
        { terms: 'x', context: 'y', limit: 1 },
        callContext,
      ),
    );
    expect(value).toMatchObject({ ended: 'stopped', matchesShown: 1 });
  });

  it('retries a failed answer call, then succeeds', async () => {
    let attempts = 0;
    const { host, calls, answers } = makeHost(() => ok(queryPage(paths(1), false)), {
      answer: allMatch,
    });
    const failingHost: ToolHost = {
      ...host,
      answer: (request) => {
        attempts += 1;
        answers.push(request);
        return attempts < 3
          ? Promise.resolve(err({ message: 'unusable answer' }))
          : Promise.resolve(allMatch(request));
      },
    };
    const value = payload(
      await createAemSemanticSearchExecutor(failingHost)({ terms: 'x', context: 'y' }, callContext),
    );

    expect(attempts).toBe(3);
    expect(value).toMatchObject({ matchesShown: 1, ended: 'exhausted' });
    expect(callNames(calls)).toEqual(['aem_query', 'format_table']);
  });

  it('fails the search after three unusable answers', async () => {
    let attempts = 0;
    const { host, calls } = makeHost(() => ok(queryPage(paths(1), false)), {
      answer: () => {
        attempts += 1;
        return err({ message: 'unusable answer' });
      },
    });
    const result = await createAemSemanticSearchExecutor(host)(
      { terms: 'x', context: 'y' },
      callContext,
    );

    expect(!result.ok && result.error.code).toBe('UNEXPECTED_RESPONSE');
    // One call plus two retries.
    expect(attempts).toBe(3);
    expect(callNames(calls)).toEqual(['aem_query']);
  });

  it('does not retry a cancelled answer call', async () => {
    let attempts = 0;
    const { host } = makeHost(() => ok(queryPage(paths(1), false)), {
      answer: () => {
        attempts += 1;
        return err({ message: 'cancelled', cancelled: true });
      },
    });
    const result = await createAemSemanticSearchExecutor(host)(
      { terms: 'x', context: 'y' },
      callContext,
    );

    expect(!result.ok && result.error.code).toBe('CANCELLED');
    expect(attempts).toBe(1);
  });

  it('reports a host with no answer capability, without painting anything', async () => {
    const { host, calls } = makeHost(() => ok(queryPage(paths(1), false)));
    const result = await createAemSemanticSearchExecutor(host)(
      { terms: 'x', context: 'y' },
      callContext,
    );

    expect(!result.ok && result.error.code).toBe('AGENT_UNAVAILABLE');
    expect(callNames(calls)).toEqual(['aem_query']);
  });

  it('does not query past a source page with no hits even when AEM claims more', async () => {
    let queries = 0;
    const { host, calls } = makeHost(
      (name) => {
        if (name !== 'aem_query') return ok(tableOk);
        queries += 1;
        // Page 1 has no hits but claims more; a second page would have one.
        return ok(queries === 1 ? queryPage([], true) : queryPage(paths(1), false));
      },
      { answer: allMatch },
    );
    const value = payload(
      await createAemSemanticSearchExecutor(host)({ terms: 'x', context: 'y' }, callContext),
    );

    expect(callNames(calls)).toEqual(['aem_query', 'format_table']);
    expect(value).toMatchObject({ ended: 'exhausted', matchesShown: 0, turnComplete: true });
    expect(value['textResultForLlm'] as string).toContain('returned no hits');
  });

  it('defaults to the content roots followed by the DAM roots', async () => {
    const { host, calls } = makeHost(() => ok(queryPage(paths(2), false)), {
      answer: allMatch,
      contentRoots: ['/content/site'],
      damRoots: ['/content/dam/site'],
    });
    const value = payload(
      await createAemSemanticSearchExecutor(host)({ terms: 'Waldo', context: 'good' }, callContext),
    );

    expect(calls[0]?.args['roots']).toEqual(['/content/site', '/content/dam/site']);
    expect(value['roots']).toEqual(['/content/site', '/content/dam/site']);
  });

  it('resolves a path fragment in roots before the query, here from a content root', async () => {
    const { host, calls } = makeHost(() => ok(queryPage(paths(1), false)), {
      answer: allMatch,
      contentRoots: ['/content/site/us/en', '/content/site/de'],
    });
    const value = payload(
      await createAemSemanticSearchExecutor(host)(
        { terms: 'Waldo', context: 'good', roots: ['us/en'] },
        callContext,
      ),
    );

    expect(calls.map((call) => call.name)).toContain('aem_query');
    expect(calls.find((call) => call.name === 'aem_query')?.args['roots']).toEqual([
      '/content/site/us/en',
    ]);
    expect(value['roots']).toEqual(['/content/site/us/en']);
  });

  it('refuses a description in words as a root, without calling anything', async () => {
    const { host, calls } = makeHost(() => ok(queryPage(paths(1), false)), { answer: allMatch });
    const result = await createAemSemanticSearchExecutor(host)(
      { terms: 'Waldo', context: 'good', roots: ['the US site'] },
      callContext,
    );

    expect(!result.ok && result.error.code).toBe('INVALID_ARGUMENT');
    expect(calls).toEqual([]);
  });

  it('filters every page of a search by page property, and echoes the filter', async () => {
    const { host, calls } = makeHost(() => ok(queryPage(paths(2), false)), { answer: allMatch });
    const filters = [{ property: 'cq:lastReplicationAction', value: 'Activate' }];
    const value = payload(
      await createAemSemanticSearchExecutor(host)(
        { terms: 'Waldo', context: 'good', filters },
        callContext,
      ),
    );

    const expected = applySearchFilters({ fulltext: 'Waldo' }, filters);
    const queried = calls.filter((call) => call.name === 'aem_query');
    expect(queried).toHaveLength(1);
    expect({ ok: true, predicates: queried[0]?.args['predicates'] }).toEqual(expected);
    expect(value['filters']).toEqual(filters);
  });

  it('searches without a filter, and echoes none, when it is omitted', async () => {
    const { host, calls } = makeHost(() => ok(queryPage(paths(1), false)), { answer: allMatch });
    const value = payload(
      await createAemSemanticSearchExecutor(host)({ terms: 'Waldo', context: 'good' }, callContext),
    );

    expect(calls[0]?.args['predicates']).toEqual({ fulltext: 'Waldo' });
    expect(value).not.toHaveProperty('filters');
  });

  it('rejects the old two-phase arguments and incomplete ones', async () => {
    const { host, calls } = makeHost(() => ok(queryPage(paths(1), false)), { answer: allMatch });
    const execute = createAemSemanticSearchExecutor(host);

    for (const args of [
      {},
      { terms: 'x' },
      { context: 'y' },
      { terms: 'x', context: 'y', searchId: 's', matches: [1] },
      { terms: 'x', context: 'y', extra: 1 },
    ]) {
      const result = await execute(args, callContext);
      expect(!result.ok && result.error.code).toBe('INVALID_ARGUMENT');
    }
    expect(calls).toEqual([]);
  });

  it('honours an already-aborted signal', async () => {
    const { host, calls, answers } = makeHost(() => ok(queryPage(paths(1), false)), {
      answer: allMatch,
    });
    const controller = new AbortController();
    controller.abort();
    const result = await createAemSemanticSearchExecutor(host)(
      { terms: 'x', context: 'y' },
      { toolCallId: 'call-1' as never, signal: controller.signal },
    );

    expect(!result.ok && result.error.code).toBe('CANCELLED');
    expect(calls).toEqual([]);
    expect(answers).toEqual([]);
  });

  it('cancels the whole call when a read is cancelled', async () => {
    const { host } = makeHost(() => ok(queryPage(paths(3), true)), {
      read: () => ({ kind: 'cancelled' }),
      answer: allMatch,
    });
    const result = await createAemSemanticSearchExecutor(host)(
      { terms: 'x', context: 'y' },
      callContext,
    );
    expect(!result.ok && result.error.code).toBe('CANCELLED');
  });

  it('reports reading and testing progress with the page fill count', async () => {
    const progress: string[] = [];
    const { host } = makeHost(() => ok(queryPage(paths(3), false)), { answer: allMatch });
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

    expect(progress[0]).toContain('Page 1');
    expect(progress[0]).toContain('0/3 collected');
    expect(progress[0]).toContain('Reading 0/3');
    expect(progress.some((line) => line.includes('Reading 3/3'))).toBe(true);
    const testing = progress.find((line) => line.startsWith('Testing 3 candidate(s)'));
    expect(testing).toContain('Page 1');
    expect(testing).toContain('0/3 collected');
    // What happens next keeps the same shape, and after the page is taken the
    // count is the true remainder (0 here), not the 3 that were just shown.
    const showing = progress.find((line) => line.startsWith('Showing 3'));
    expect(showing).toContain('Page 1');
    expect(showing).toContain('0/3 collected');
  });

  it('never shows more collected than the page holds when a page overflows', async () => {
    let queries = 0;
    const progress: string[] = [];
    const { host } = makeHost(
      (name, args) => {
        if (name === 'aem_query') {
          queries += 1;
          return ok(queryPage(paths(2, (queries - 1) * 2), queries < 2));
        }
        return ok(name === 'ask_user' ? clickFirstAction(args) : tableOk);
      },
      {
        answer: (request) =>
          request.items[0]?.text.includes('/p2') === true
            ? matching(1, 2)(request, 1)
            : matching(1)(request, 1),
      },
    );
    const withProgress: ToolHost = {
      ...host,
      reportToolProgress: (_toolCallId, text) => {
        progress.push(text);
      },
    };
    await createAemSemanticSearchExecutor(withProgress)(
      { terms: 'x', context: 'y', limit: 2 },
      callContext,
    );

    // Page 1 gives one match, page 2 gives two: three collected, two shown, one
    // remains. The line after the page is taken reports the remainder (1/2),
    // never the impossible 3/2.
    const showing = progress.find((line) => line.startsWith('Showing 2'));
    expect(showing).toContain('Page 2');
    expect(showing).toContain('1/2 collected');
    expect(progress.some((line) => line.includes('3/2'))).toBe(false);
    for (const line of progress) {
      const counted = /(\d+)\/(\d+) collected/.exec(line);
      if (counted === null) continue;
      expect(Number(counted[1])).toBeLessThanOrEqual(Number(counted[2]));
    }
  });

  it('reads a page of hits in parallel', async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { host } = makeHost(() => ok(queryPage(paths(3), false)), {
      answer: allMatch,
      read: async (url) => {
        started += 1;
        // Only when all three reads are in flight can any of them finish.
        if (started === 3) release();
        await gate;
        return contentFor(url);
      },
    });
    const value = payload(
      await createAemSemanticSearchExecutor(host)(
        { terms: 'Waldo', context: 'y', limit: 3 },
        callContext,
      ),
    );

    expect(started).toBe(3);
    expect(value['matchesShown']).toBe(3);
  });

  it('falls back to the hit itself when no node contains the terms, and says so to the answer', async () => {
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
    const { host, reads, answers } = makeHost(() => ok(queryPage(paths(2), false)), {
      read,
      answer: allMatch,
    });
    await createAemSemanticSearchExecutor(host)({ terms: 'Waldo', context: 'y' }, callContext);
    expect(reads).toHaveLength(4);
    expect(answers[0]?.items[0]?.text).toContain('Waldo at /content/site/p0');
    expect(answers[0]?.items[1]?.text).toContain('content could not be read');
  });

  it('puts the concrete node path and the property name in the table, not the hit', async () => {
    // A text property that lives on a descendant of the hit: the table's Path
    // must be that node, and Property its own name.
    const descendantContent = (url: string): BrokerOutcome => {
      const path = new URL(url).searchParams.get('path') ?? '';
      return {
        kind: 'response',
        status: 200,
        contentType: 'application/json',
        bodyText: JSON.stringify({
          success: true,
          hits: [{ 'jcr:path': `${path}/jcr:content/text`, text: '<p>Waldo lives here</p>' }],
        }),
      };
    };
    const { host, calls } = makeHost(
      (name) => ok(name === 'aem_query' ? queryPage(['/content/site/p'], false) : tableOk),
      { read: descendantContent, answer: allMatch },
    );
    await createAemSemanticSearchExecutor(host)({ terms: 'Waldo', context: 'y' }, callContext);
    const table = calls.find((call) => call.name === 'format_table');
    expect(tableData(table)['rows']).toEqual([
      {
        'jcr:path': '/content/site/p/jcr:content/text',
        property: 'text',
        citation: 'Waldo lives here',
      },
    ]);
    const columns = formatTableColumnsSchema.parse(table?.args['columns']);
    const rows = tableData(table)['rows'] as readonly Record<string, unknown>[];
    expect(columns.map((column) => column.key).sort()).toEqual(Object.keys(rows[0] ?? {}).sort());
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
  it('summarises a search by its terms, and adds the page once past the first', () => {
    const start = renderer.describeCall({ terms: 'Waldo', context: 'Waldo is good' });
    const later = renderer.describeCall(
      { terms: 'Waldo', context: 'Waldo is good' },
      { operation: 'aem_semantic_search', page: 2, matchesShown: 20 },
    );

    expect(start.summary).toBe('Waldo');
    expect(later.summary).toContain('Waldo');
    expect(later.summary).toContain('2');
    expect(start.parameters.length).toBeGreaterThan(0);
  });

  it('adds a Filters row only to a filtered search', () => {
    const filters = [{ property: 'cq:template', value: '/conf/site/settings/wcm/templates/page' }];
    const plain = renderer.describeCall({ terms: 'Waldo', context: 'good' });
    const filteredCall = renderer.describeCall({ terms: 'Waldo', context: 'good', filters });

    expect(filteredCall.parameters).toHaveLength(plain.parameters.length + 1);
    expect(filteredCall.parameters.map((row) => row.value)).toContain(
      describeSearchFilters(filters),
    );
  });
});
