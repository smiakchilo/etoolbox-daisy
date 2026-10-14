import { describe, expect, it } from 'vitest';
import {
  type EnvironmentFacts,
  type JsonValue,
  type Result,
  type ToolError,
  type ToolHost,
  MAX_SEARCH_ROOTS,
  classifyScopeEntry,
  createToolError,
  err,
  ok,
  pathEndsWithSegments,
  queryRootsSchema,
  resolveSearchScope,
  searchRootsSchema,
} from '../../../../src/shared';
import { createCountingIdGenerator } from '../../../support/testIds';

describe('classifyScopeEntry', () => {
  it.each([
    ['/content/hpe/country/us/en', { kind: 'path', path: '/content/hpe/country/us/en' }],
    ['  /content/hpe  ', { kind: 'path', path: '/content/hpe' }],
    ['us/en', { kind: 'fragment', segments: ['us', 'en'] }],
    ['us/en/', { kind: 'fragment', segments: ['us', 'en'] }],
    ['en', { kind: 'fragment', segments: ['en'] }],
    ['jcr:content/x', { kind: 'fragment', segments: ['jcr:content', 'x'] }],
    ['über/straße', { kind: 'fragment', segments: ['über', 'straße'] }],
  ])('reads %j as %j', (raw, expected) => {
    expect(classifyScopeEntry(raw)).toEqual(expected);
  });

  it.each([
    ['the US site'],
    ['us en'],
    [''],
    ['   '],
    ['us//en'],
    ['../us'],
    ['us/./en'],
    ['us/*'],
    ['us?/en'],
    ['a'.repeat(201)],
    ['/content/foo.json'],
  ])('rejects %j as neither a path nor a fragment', (raw) => {
    const entry = classifyScopeEntry(raw);
    expect(entry.kind).toBe('invalid');
    if (entry.kind === 'invalid') {
      expect(entry.message).toContain('is not a JCR path or a path fragment');
      expect(entry.message).toContain('ask_user');
    }
  });

  it('truncates a long value in its message', () => {
    const entry = classifyScopeEntry('x y'.repeat(100));
    expect(entry.kind === 'invalid' && entry.message.length < 400).toBe(true);
  });
});

describe('searchRootsSchema and queryRootsSchema', () => {
  it('accepts full paths and fragments for a composite search, up to the shared maximum', () => {
    expect(searchRootsSchema.safeParse(['/content/a', 'us/en']).success).toBe(true);
    const tooMany = Array.from(
      { length: MAX_SEARCH_ROOTS + 1 },
      (_, i) => `/content/r${String(i)}`,
    );
    expect(searchRootsSchema.safeParse(tooMany.slice(0, MAX_SEARCH_ROOTS)).success).toBe(true);
    expect(searchRootsSchema.safeParse(tooMany).success).toBe(false);
  });

  it('rejects a description in words with the corrective message', () => {
    const parsed = searchRootsSchema.safeParse(['the US site']);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('is not a JCR path or a path fragment');
  });

  it('keeps the shared maximum at ten', () => {
    expect(MAX_SEARCH_ROOTS).toBe(10);
  });

  it('gives aem_query the same maximum but full paths only', () => {
    expect(queryRootsSchema.safeParse(['/content/a']).success).toBe(true);
    expect(queryRootsSchema.safeParse(['us/en']).success).toBe(false);
    const tooMany = Array.from(
      { length: MAX_SEARCH_ROOTS + 1 },
      (_, i) => `/content/r${String(i)}`,
    );
    expect(queryRootsSchema.safeParse(tooMany).success).toBe(false);
  });
});

describe('pathEndsWithSegments', () => {
  it.each([
    ['/content/hpe/country/us/en', ['us', 'en'], true],
    ['/content/hpe/country/us/en', ['en'], true],
    ['/content/hpe/country/us/en', ['country', 'us', 'en'], true],
    ['/content/hpe', ['content', 'hpe'], true],
    ['/content/hpe/country/us/en', ['us'], false],
    ['/content/hpe/ben', ['en'], false],
    ['/content/hpe/xus/en', ['us', 'en'], false],
    ['/en', ['us', 'en'], false],
    ['/content/en', [], false],
  ])('%s with %j -> %s', (path, segments, expected) => {
    expect(pathEndsWithSegments(path, segments)).toBe(expected);
  });
});

describe('resolveSearchScope', () => {
  interface Call {
    readonly name: string;
    readonly args: Readonly<Record<string, JsonValue>>;
  }

  const FACTS: EnvironmentFacts = {
    origin: 'https://aem.example',
    contentRoots: ['/content/hpe'],
    componentRoots: ['/apps/hpeweb'],
    damRoots: ['/content/dam'],
    contentPriorityPaths: ['/content/hpe/base/blueprint', '/content/hpe/country/us/en'],
  };

  const ids = createCountingIdGenerator('scope');

  function lookupPage(paths: readonly string[], hasMore: boolean | 'unknown' = false): JsonValue {
    return {
      ok: true,
      operation: 'aem_query',
      rows: paths.map((path) => ({ 'jcr:path': path })),
      pagination: { offset: 0, limit: 200, returned: paths.length, hasMore, total: null },
    };
  }

  function setup(
    responder: (call: Call) => Result<JsonValue, ToolError>,
    facts: EnvironmentFacts | null = FACTS,
  ) {
    const calls: Call[] = [];
    const host = {
      environmentFacts: () => facts ?? undefined,
      idGenerator: ids,
      invokeTool: (name: string, args: Readonly<Record<string, JsonValue>>) => {
        const call = { name, args };
        calls.push(call);
        return Promise.resolve(responder(call));
      },
    } as unknown as ToolHost;
    const resolve = (roots: readonly string[]) =>
      resolveSearchScope({
        host,
        context: { toolCallId: 'call-1' as never, signal: undefined },
        roots,
      });
    return { calls, resolve };
  }

  const unexpected = (call: Call): Result<JsonValue, ToolError> => {
    throw new Error(`unexpected call to ${call.name}`);
  };

  const cancelled = (): Result<JsonValue, ToolError> =>
    err(createToolError('CANCELLED', 'dismissed', 'request-1' as never));

  it('passes a full path through as written, with no calls', async () => {
    const { calls, resolve } = setup(unexpected);
    expect(await resolve(['/content/other/site'])).toEqual(ok(['/content/other/site']));
    expect(calls).toEqual([]);
  });

  it('uses the one priority path that ends with the fragment, with no calls', async () => {
    const { calls, resolve } = setup(unexpected);
    expect(await resolve(['us/en'])).toEqual(ok(['/content/hpe/country/us/en']));
    expect(calls).toEqual([]);
  });

  it('prefers a priority match over any other branch, without looking further', async () => {
    const { calls, resolve } = setup(unexpected, {
      ...FACTS,
      contentRoots: ['/content/hpe', '/content/other/us/en'],
    });
    expect(await resolve(['us/en'])).toEqual(ok(['/content/hpe/country/us/en']));
    expect(calls).toEqual([]);
  });

  it('asks which one when several priority paths end with the fragment', async () => {
    const { calls, resolve } = setup(
      () => ok({ selections: ['/content/b/us/en'], freeform: null }),
      { ...FACTS, contentPriorityPaths: ['/content/a/us/en', '/content/b/us/en'] },
    );
    expect(await resolve(['us/en'])).toEqual(ok(['/content/b/us/en']));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('ask_user');
    expect(calls[0]?.args).toEqual({
      question: 'Which branch does "us/en" mean?',
      options: ['/content/a/us/en', '/content/b/us/en'],
      freeInput: true,
    });
  });

  it('falls back to a content root that ends with the fragment', async () => {
    const { calls, resolve } = setup(unexpected, {
      ...FACTS,
      contentPriorityPaths: [],
      contentRoots: ['/content/hpe', '/content/brand/us/en'],
    });
    expect(await resolve(['us/en'])).toEqual(ok(['/content/brand/us/en']));
    expect(calls).toEqual([]);
  });

  it('looks pages up when configuration has no match, and uses one proved match', async () => {
    const { calls, resolve } = setup(
      () => ok(lookupPage(['/content/hpe/it/us/en', '/content/hpe/x/de/en'])),
      {
        ...FACTS,
        contentPriorityPaths: [],
      },
    );
    expect(await resolve(['us/en'])).toEqual(ok(['/content/hpe/it/us/en']));
    expect(calls).toEqual([
      {
        name: 'aem_query',
        args: {
          predicates: { type: 'cq:Page', nodename: 'en' },
          roots: ['/content/hpe'],
          properties: [],
          limit: 200,
        },
      },
    ]);
  });

  it('looks up under /content when the host is unknown', async () => {
    const { calls, resolve } = setup(() => ok(lookupPage(['/content/site/us/en'])), null);
    expect(await resolve(['us/en'])).toEqual(ok(['/content/site/us/en']));
    expect(calls[0]?.args['roots']).toEqual(['/content']);
  });

  it('asks when the lookup finds several pages', async () => {
    const { calls, resolve } = setup(
      (call) =>
        call.name === 'aem_query'
          ? ok(lookupPage(['/content/b/us/en', '/content/a/us/en']))
          : ok({ selections: ['/content/a/us/en'], freeform: null }),
      { ...FACTS, contentPriorityPaths: [] },
    );
    expect(await resolve(['us/en'])).toEqual(ok(['/content/a/us/en']));
    expect(calls[1]?.args['options']).toEqual(['/content/a/us/en', '/content/b/us/en']);
  });

  it('does not trust a single match when the lookup could not see every page', async () => {
    const { calls, resolve } = setup(
      (call) =>
        call.name === 'aem_query'
          ? ok(lookupPage(['/content/a/us/en'], true))
          : ok({ selections: ['/content/a/us/en'], freeform: null }),
      { ...FACTS, contentPriorityPaths: [] },
    );
    expect(await resolve(['us/en'])).toEqual(ok(['/content/a/us/en']));
    expect(calls.map((call) => call.name)).toEqual(['aem_query', 'ask_user']);
  });

  it('asks for a path, with no options, when nothing matches', async () => {
    const { calls, resolve } = setup(
      (call) =>
        call.name === 'aem_query'
          ? ok(lookupPage([]))
          : ok({ selections: [], freeform: '/content/typed/us/en' }),
      { ...FACTS, contentPriorityPaths: [] },
    );
    expect(await resolve(['xx/yy'])).toEqual(ok(['/content/typed/us/en']));
    expect(calls[1]).toEqual({
      name: 'ask_user',
      args: {
        question: 'I could not find a branch matching "xx/yy". Which path should I search?',
        freeInput: true,
      },
    });
  });

  it('treats a failed lookup as finding nothing, and asks', async () => {
    const { calls, resolve } = setup(
      (call) =>
        call.name === 'aem_query'
          ? err(createToolError('UNEXPECTED_RESPONSE', 'boom', 'r' as never))
          : ok({ selections: [], freeform: '/content/typed' }),
      { ...FACTS, contentPriorityPaths: [] },
    );
    expect(await resolve(['us/en'])).toEqual(ok(['/content/typed']));
    expect(calls.map((call) => call.name)).toEqual(['aem_query', 'ask_user']);
  });

  it('treats an unreadable lookup result as finding nothing', async () => {
    const { resolve } = setup(
      (call) =>
        call.name === 'aem_query' ? ok({ nonsense: true }) : ok({ selections: [], freeform: '/c' }),
      { ...FACTS, contentPriorityPaths: [] },
    );
    expect(await resolve(['us/en'])).toEqual(ok(['/c']));
  });

  it('propagates a cancelled lookup without asking', async () => {
    const { calls, resolve } = setup(cancelled, { ...FACTS, contentPriorityPaths: [] });
    const result = await resolve(['us/en']);
    expect(result.ok || result.error.code).toBe('CANCELLED');
    expect(calls.map((call) => call.name)).toEqual(['aem_query']);
  });

  it('propagates a dismissed question', async () => {
    const { resolve } = setup(
      (call) => (call.name === 'aem_query' ? ok(lookupPage([])) : cancelled()),
      { ...FACTS, contentPriorityPaths: [] },
    );
    const result = await resolve(['us/en']);
    expect(result.ok || result.error.code).toBe('CANCELLED');
  });

  it('refuses a typed answer that is not a full path, and says nothing was searched', async () => {
    const { resolve } = setup(
      (call) =>
        call.name === 'aem_query' ? ok(lookupPage([])) : ok({ selections: [], freeform: 'us/en2' }),
      { ...FACTS, contentPriorityPaths: [] },
    );
    const result = await resolve(['us/en']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
      expect(result.error.message).toContain('must start with "/"');
    }
  });

  it('refuses an answer that selects something that was not offered', async () => {
    const { resolve } = setup(() => ok({ selections: ['/content/other'], freeform: null }), {
      ...FACTS,
      contentPriorityPaths: ['/content/a/us/en', '/content/b/us/en'],
    });
    const result = await resolve(['us/en']);
    expect(result.ok || result.error.code).toBe('CANCELLED');
  });

  it('rejects a description in words before any call', async () => {
    const { calls, resolve } = setup(unexpected);
    const result = await resolve(['the US site']);
    expect(result.ok || result.error.code).toBe('INVALID_ARGUMENT');
    expect(calls).toEqual([]);
  });

  it('keeps the order of a mixed list, resolving each fragment in turn', async () => {
    const { resolve } = setup(unexpected);
    expect(await resolve(['/content/first', 'us/en', '/content/last'])).toEqual(
      ok(['/content/first', '/content/hpe/country/us/en', '/content/last']),
    );
  });

  it('asks at most 20 candidates and drops options that exceed the option length', async () => {
    const many = Array.from(
      { length: 30 },
      (_, i) => `/content/s${String(i).padStart(2, '0')}/us/en`,
    );
    const { calls, resolve } = setup(() => ok({ selections: [many[0] ?? ''], freeform: null }), {
      ...FACTS,
      contentPriorityPaths: [...many, `/content/${'x'.repeat(220)}/us/en`],
    });
    await resolve(['us/en']);
    const options = calls[0]?.args['options'];
    expect(options).toHaveLength(20);
  });
});
