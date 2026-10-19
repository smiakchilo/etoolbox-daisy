import { describe, expect, it } from 'vitest';
import { buildQueryUrl, SEARCH_PAGE_SIZE } from '../../../../../src/shared';
import { aemQueryArgsSchema } from '../../../../../src/tools/aem-query/aemQuery';

const ORIGIN = 'https://author.example';

function build(
  predicates: Record<string, string>,
  extra: { offset?: number; limit?: number; properties?: readonly string[] } = {},
) {
  // Parsed through the real args schema rather than hand-built, so these
  // tests exercise exactly the values production would receive - including
  // the schema's own defaulting of `offset`/`limit`.
  const args = aemQueryArgsSchema.parse({ predicates, ...extra });
  return buildQueryUrl({
    origin: ORIGIN,
    predicates: args.predicates,
    offset: args.offset,
    limit: args.limit,
    properties: args.properties,
  });
}

function buildCount(predicates: Record<string, string>) {
  return buildQueryUrl({ mode: 'count', origin: ORIGIN, predicates });
}

function urlOf(result: ReturnType<typeof build>): URL {
  if (!result.ok) throw new Error(`expected a built URL, got ${result.error.kind}`);
  return new URL(result.value.url);
}

describe('buildQueryUrl - the endpoint is not negotiable', () => {
  it('always addresses /bin/querybuilder.json on the selected origin', () => {
    const url = urlOf(build({ path: '/content/site' }));
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe('/bin/querybuilder.json');
  });

  it('cannot be redirected to another path or host by a predicate', () => {
    // Every one of these is an ordinary predicate as far as the schema is
    // concerned; none of them may influence the request target.
    const url = urlOf(
      build({
        path: '/content/site',
        endpoint: '/bin/evil.json',
        url: 'https://attacker.example/bin/querybuilder.json',
        host: 'attacker.example',
      }),
    );
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe('/bin/querybuilder.json');
    // Still forwarded as predicates - rejecting them would be the predicate
    // allowlist section 6 forbids - just with no structural power.
    expect(url.searchParams.get('endpoint')).toBe('/bin/evil.json');
  });

  it('rejects an origin that is not a valid server origin', () => {
    const result = buildQueryUrl({
      origin: 'not-an-origin',
      predicates: {},
      offset: 0,
      limit: 50,
      properties: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_origin');
  });
});

describe('buildQueryUrl - customer predicates are forwarded, not filtered', () => {
  it('forwards an unknown customer predicate unchanged rather than blocking it', () => {
    const url = urlOf(
      build({
        path: '/content/site',
        acmeCustomEvaluator: 'enabled',
        'acmeCustomEvaluator.threshold': '42',
      }),
    );
    expect(url.searchParams.get('acmeCustomEvaluator')).toBe('enabled');
    expect(url.searchParams.get('acmeCustomEvaluator.threshold')).toBe('42');
  });

  it('preserves nested AND/OR group keys, including dotted and numeric forms', () => {
    const url = urlOf(
      build({
        path: '/content/site',
        'group.p.or': 'true',
        'group.1_property': 'jcr:content/cq:template',
        'group.1_property.value': '/conf/site/templates/article',
        'group.2_group.p.not': 'true',
        'group.2_group.1_property': 'jcr:content/hidden',
        '1_group.p.or': 'false',
      }),
    );
    expect(url.searchParams.get('group.p.or')).toBe('true');
    expect(url.searchParams.get('group.1_property')).toBe('jcr:content/cq:template');
    expect(url.searchParams.get('group.2_group.p.not')).toBe('true');
    expect(url.searchParams.get('group.2_group.1_property')).toBe('jcr:content/hidden');
    expect(url.searchParams.get('1_group.p.or')).toBe('false');
  });

  it('accepts group.p.or even though p.or-style names resemble reserved keys', () => {
    const result = build({ 'group.p.or': 'true' });
    expect(result.ok).toBe(true);
  });
});

describe('buildQueryUrl - application-owned output parameters', () => {
  it.each([
    'p.limit',
    'p.offset',
    'p.hits',
    'p.properties',
    'p.nodedepth',
    'p.guessTotal',
    'p.facets',
  ])('refuses to let a predicate named %s reach the wire', (reserved) => {
    // Bypasses the args schema deliberately: `queryPredicatesSchema` already
    // rejects most of these, so going through it would test that schema again
    // instead of this module's own independent guard. The guard exists for the
    // day the two lists drift apart.
    const result = buildQueryUrl({
      origin: ORIGIN,
      predicates: { path: '/content/site', [reserved]: '999' },
      offset: 0,
      limit: 50,
      properties: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('reserved_parameter');
      if (result.error.kind === 'reserved_parameter') {
        expect(result.error.parameter).toBe(reserved);
      }
    }
  });

  it('sends the capped numeric guessTotal, disables facets, and pins nodedepth to 0', () => {
    const url = urlOf(build({ path: '/content/site' }));
    expect(url.searchParams.get('p.guessTotal')).toBe('100');
    expect(url.searchParams.get('p.facets')).toBe('false');
    expect(url.searchParams.get('p.nodedepth')).toBe('0');
    expect(url.searchParams.get('p.hits')).toBe('selective');
  });

  it('emits each application-owned parameter exactly once', () => {
    const url = urlOf(build({ path: '/content/site', 'p.limit ': '9' }));
    expect(url.searchParams.getAll('p.limit')).toEqual([String(SEARCH_PAGE_SIZE)]);
    expect(url.searchParams.getAll('p.offset')).toEqual(['0']);
  });
});

describe('buildQueryUrl - count mode', () => {
  it('sends no guessTotal, offset 0, limit 1 and only jcr:path', () => {
    const result = buildCount({ path: '/content/site', type: 'cq:Page' });
    const url = urlOf(result);
    expect(url.searchParams.getAll('p.guessTotal')).toEqual([]);
    expect(url.searchParams.get('p.offset')).toBe('0');
    expect(url.searchParams.get('p.limit')).toBe('1');
    expect(url.searchParams.get('p.properties')).toBe('jcr:path');
    expect(url.searchParams.get('p.hits')).toBe('selective');
    expect(url.searchParams.get('p.nodedepth')).toBe('0');
    expect(url.searchParams.get('p.facets')).toBe('false');
    // The predicates themselves are untouched.
    expect(url.searchParams.get('path')).toBe('/content/site');
    expect(url.searchParams.get('type')).toBe('cq:Page');
    if (result.ok) expect(result.value.projectedProperties).toEqual(['jcr:path']);
  });

  it('still refuses a predicate that names an application-owned parameter', () => {
    const result = buildQueryUrl({
      mode: 'count',
      origin: ORIGIN,
      predicates: { 'p.guessTotal': '1' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('reserved_parameter');
  });
});

describe('buildQueryUrl - projection', () => {
  it('requests compact identifying fields when no projection is given', () => {
    const url = urlOf(build({ path: '/content/site' }));
    expect(url.searchParams.get('p.properties')).toBe('jcr:path jcr:primaryType jcr:title');
  });

  it("requests exactly the agent's properties, plus the path that makes a row actionable", () => {
    const result = build({ path: '/content/site' }, { properties: ['jcr:title', 'cq:template'] });
    const url = urlOf(result);
    expect(url.searchParams.get('p.properties')).toBe('jcr:path jcr:title cq:template');
    if (result.ok) {
      expect(result.value.projectedProperties).toEqual(['jcr:path', 'jcr:title', 'cq:template']);
    }
  });

  it('does not duplicate jcr:path when the agent asked for it explicitly', () => {
    const url = urlOf(build({ path: '/content/site' }, { properties: ['jcr:path', 'jcr:title'] }));
    expect(url.searchParams.get('p.properties')).toBe('jcr:path jcr:title');
  });
});

describe('buildQueryUrl - pagination parameters', () => {
  it('applies the one search page size and offset 0', () => {
    const url = urlOf(build({ path: '/content/site' }));
    expect(url.searchParams.get('p.limit')).toBe(String(SEARCH_PAGE_SIZE));
    expect(url.searchParams.get('p.offset')).toBe('0');
  });

  it('accepts the maximum limit of 200', () => {
    const url = urlOf(build({ path: '/content/site' }, { limit: 200 }));
    expect(url.searchParams.get('p.limit')).toBe('200');
  });

  it('accepts the minimum limit of 1', () => {
    const url = urlOf(build({ path: '/content/site' }, { limit: 1 }));
    expect(url.searchParams.get('p.limit')).toBe('1');
  });

  it('sends the requested offset', () => {
    const url = urlOf(build({ path: '/content/site' }, { offset: 150, limit: 25 }));
    expect(url.searchParams.get('p.offset')).toBe('150');
    expect(url.searchParams.get('p.limit')).toBe('25');
  });

  it.each([201, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2])(
    'rejects a limit of %s before a request can be built',
    (limit) => {
      expect(aemQueryArgsSchema.safeParse({ predicates: {}, limit }).success).toBe(false);
    },
  );

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an offset of %s before a request can be built',
    (offset) => {
      expect(aemQueryArgsSchema.safeParse({ predicates: {}, offset }).success).toBe(false);
    },
  );

  it('accepts an offset of 0 as a legitimate first page', () => {
    expect(aemQueryArgsSchema.safeParse({ predicates: {}, offset: 0 }).success).toBe(true);
  });
});

describe('buildQueryUrl - encoding', () => {
  it('carries Unicode predicate values through without corruption', () => {
    const url = urlOf(build({ path: '/content/site', fulltext: 'Weiße Röcke 日本語 café' }));
    expect(url.searchParams.get('fulltext')).toBe('Weiße Röcke 日本語 café');
    // Present on the wire only in escaped form - the raw characters never
    // appear literally in the serialized query string.
    expect(url.search).not.toContain('日本語');
  });

  it('carries Unicode predicate keys through without corruption', () => {
    // noinspection JSNonASCIINames
    const url = urlOf(build({ path: '/content/site', 'property.value_日本': 'x' }));
    expect(url.searchParams.get('property.value_日本')).toBe('x');
  });

  it('escapes a value that would otherwise introduce a second parameter', () => {
    const url = urlOf(build({ path: '/content/site', fulltext: 'a&p.limit=999&b=c' }));
    expect(url.searchParams.get('fulltext')).toBe('a&p.limit=999&b=c');
    // The injected p.limit did not become a real parameter.
    expect(url.searchParams.getAll('p.limit')).toEqual([String(SEARCH_PAGE_SIZE)]);
    expect(url.searchParams.get('b')).toBeNull();
  });

  it('escapes a value that would otherwise start a fragment or a new path', () => {
    const url = urlOf(build({ path: '/content/site', nodename: 'a#b?c/../d' }));
    expect(url.searchParams.get('nodename')).toBe('a#b?c/../d');
    expect(url.hash).toBe('');
    expect(url.pathname).toBe('/bin/querybuilder.json');
  });

  it.each([
    ['percent', '100%'],
    ['plus', 'a+b'],
    ['equals', 'a=b'],
    ['space', 'two words'],
    ['newline', 'line1\nline2'],
    ['quote', 'say "hi"'],
    ['backslash', 'a\\b'],
  ])('round-trips a %s in a predicate value', (_label, value) => {
    const url = urlOf(build({ path: '/content/site', fulltext: value }));
    expect(url.searchParams.get('fulltext')).toBe(value);
  });

  it('reports an unencodable predicate rather than throwing', () => {
    // A lone high surrogate: valid in a JS string, not encodable as UTF-8.
    const result = buildQueryUrl({
      origin: ORIGIN,
      predicates: { fulltext: '\uD800' },
      offset: 0,
      limit: 50,
      properties: undefined,
    });
    // `URLSearchParams` replaces a lone surrogate rather than throwing, so
    // this must not fail - it must produce a URL that still addresses the
    // right endpoint. Asserting the outcome either way is the point: what is
    // forbidden is an unhandled exception at the tool boundary.
    if (result.ok) {
      expect(new URL(result.value.url).pathname).toBe('/bin/querybuilder.json');
    } else {
      expect(result.error.kind).toBe('unencodable_predicate');
    }
  });
});
