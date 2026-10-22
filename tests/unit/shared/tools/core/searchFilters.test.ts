import { describe, expect, it } from 'vitest';
import {
  type SearchFilter,
  FILTER_ANCESTOR_DEPTH,
  MAX_SEARCH_FILTERS,
  applySearchFilters,
  buildQueryUrl,
  describeFiltersValue,
  describeSearchFilters,
  isComponentSearchPredicates,
  searchFilterSchema,
  searchFiltersSchema,
} from '../../../../../src/shared';
import { aemQueryArgsSchema } from '../../../../../src/tools/aem-query/aemQuery';

function filtered(
  predicates: Readonly<Record<string, string>>,
  filters: readonly SearchFilter[],
): Readonly<Record<string, string>> {
  const result = applySearchFilters(predicates, filters);
  if (!result.ok) throw new Error(`expected the filters to apply, got: ${result.message}`);
  return result.predicates;
}

/** The property paths a predicate map tests, in order. */
function propertyPaths(predicates: Readonly<Record<string, string>>): string[] {
  return Object.entries(predicates)
    .filter(([key]) => /_property$/.test(key))
    .map(([, value]) => value);
}

/** The keys of a predicate map that set `p.not` / `p.or` on some group. */
function flagged(predicates: Readonly<Record<string, string>>, flag: 'p.not' | 'p.or'): string[] {
  return Object.keys(predicates).filter((key) => key.endsWith(`.${flag}`));
}

const TEMPLATE = '/conf/site/settings/wcm/templates/page';
const PAGE = { type: 'cq:Page' };
const COMPONENT = { type: 'nt:unstructured', property: 'sling:resourceType' };
const REPLICATION = 'cq:lastReplicationAction';

describe('search filter schema', () => {
  it('accepts a minimal equals filter and leaves its operator implicit', () => {
    const parsed = searchFilterSchema.parse({ property: 'cq:template', value: TEMPLATE });
    expect(parsed.operator).toBeUndefined();
    expect(parsed.value).toBe(TEMPLATE);
  });

  it('requires a value for every operator except exists', () => {
    expect(searchFilterSchema.safeParse({ property: 'x' }).success).toBe(false);
    expect(searchFilterSchema.safeParse({ property: 'x', operator: 'like' }).success).toBe(false);
    expect(searchFilterSchema.safeParse({ property: 'x', operator: 'after' }).success).toBe(false);
    expect(searchFilterSchema.safeParse({ property: 'x', operator: 'exists' }).success).toBe(true);
    expect(
      searchFilterSchema.safeParse({ property: 'x', operator: 'exists', value: 'true' }).success,
    ).toBe(false);
  });

  it('refuses a negated filter that shares a group', () => {
    expect(
      searchFilterSchema.safeParse({ property: 'x', value: 'y', negate: true, group: 'g' }).success,
    ).toBe(false);
  });

  it('refuses a property that is not a plain relative path', () => {
    for (const property of ['/content/x', 'a/../b', 'a//b', 'a/./b', 'a/*']) {
      expect(searchFilterSchema.safeParse({ property, value: 'x' }).success).toBe(false);
    }
  });

  it('caps the number of filters', () => {
    const filter = { property: 'x', value: 'y' };
    expect(
      searchFiltersSchema.safeParse(Array.from({ length: MAX_SEARCH_FILTERS }, () => filter))
        .success,
    ).toBe(true);
    expect(
      searchFiltersSchema.safeParse(Array.from({ length: MAX_SEARCH_FILTERS + 1 }, () => filter))
        .success,
    ).toBe(false);
  });
});

describe('applying filters by search shape', () => {
  it('returns the predicates unchanged when no filter is given', () => {
    const predicates = { type: 'nt:base', property: 'x' };
    expect(applySearchFilters(predicates, undefined)).toEqual({ ok: true, predicates });
    expect(applySearchFilters(predicates, [])).toEqual({ ok: true, predicates });
  });

  it("tests a page's own content node for a page or an asset search", () => {
    for (const type of ['cq:Page', 'dam:Asset']) {
      const map = filtered({ type }, [{ property: 'cq:template', value: TEMPLATE }]);
      expect(map).toMatchObject({
        [`9002_group.1_property`]: 'jcr:content/cq:template',
        [`9002_group.1_property.value`]: TEMPLATE,
      });
      expect(flagged(map, 'p.or')).toEqual([]);
    }
  });

  it('accepts a content-node-relative property in either spelling', () => {
    const spelled = filtered(PAGE, [{ property: 'jcr:content/cq:template', value: TEMPLATE }]);
    const plain = filtered(PAGE, [{ property: 'cq:template', value: TEMPLATE }]);
    expect(spelled).toEqual(plain);
  });

  it('climbs one ancestor per entry up to the ancestor depth, ORed, for a component search', () => {
    const map = filtered(COMPONENT, [{ property: 'cq:template', value: TEMPLATE }]);
    const paths = propertyPaths(map);
    expect(paths).toHaveLength(FILTER_ANCESTOR_DEPTH);
    paths.forEach((path, index) => {
      expect(path).toBe(`${'../'.repeat(index + 1)}cq:template`);
    });
    expect(flagged(map, 'p.or')).toHaveLength(1);
    expect(flagged(map, 'p.not')).toEqual([]);
  });

  it('types a plain full-text search to pages and assets before the filter', () => {
    const map = filtered({ fulltext: 'waldo', path: '/content/site' }, [
      { property: 'cq:template', value: TEMPLATE },
    ]);
    const types = Object.entries(map)
      .filter(([key]) => /_type$/.test(key))
      .map(([, value]) => value);
    expect(types).toEqual(['cq:Page', 'dam:Asset']);
    expect(map[`9002_group.1_property`]).toBe('jcr:content/cq:template');
    expect(flagged(map, 'p.or')).toHaveLength(1);
  });

  it('negates the very same group, so a filter and its complement are exact complements', () => {
    for (const predicates of [PAGE, COMPONENT]) {
      const positive = filtered(predicates, [{ property: REPLICATION, value: 'Activate' }]);
      const negative = filtered(predicates, [
        { property: REPLICATION, value: 'Activate', negate: true },
      ]);
      const negation = flagged(negative, 'p.not');
      expect(negation).toHaveLength(1);
      const withoutNegation = Object.fromEntries(
        Object.entries(negative).filter(([key]) => key !== negation[0]),
      );
      expect(withoutNegation).toEqual(positive);
    }
  });

  it('uses the property predicate for like and existence', () => {
    const like = filtered(PAGE, [{ property: 'jcr:title', operator: 'like', value: '%waldo%' }]);
    expect(like).toMatchObject({
      [`9002_group.1_property`]: 'jcr:content/jcr:title',
      [`9002_group.1_property.operation`]: 'like',
      [`9002_group.1_property.value`]: '%waldo%',
    });
    const exists = filtered(PAGE, [{ property: 'cq:template', operator: 'exists' }]);
    expect(exists).toMatchObject({
      [`9002_group.1_property`]: 'jcr:content/cq:template',
      [`9002_group.1_property.operation`]: 'exists',
    });
    expect(Object.keys(exists)).not.toContain('9002_group.1_property.value');
  });

  it('maps date operators to daterange and number operators to rangeproperty', () => {
    const after = filtered(PAGE, [
      { property: 'cq:lastModified', operator: 'after', value: '2026-01-01' },
    ]);
    expect(after).toMatchObject({
      [`9002_group.1_daterange.property`]: 'jcr:content/cq:lastModified',
      [`9002_group.1_daterange.lowerBound`]: '2026-01-01',
      [`9002_group.1_daterange.lowerOperation`]: '>',
    });
    const atMost = filtered(PAGE, [
      { property: 'cq:lastModified', operator: 'atMost', value: '10' },
    ]);
    expect(atMost).toMatchObject({
      [`9002_group.1_rangeproperty.property`]: 'jcr:content/cq:lastModified',
      [`9002_group.1_rangeproperty.upperBound`]: '10',
      [`9002_group.1_rangeproperty.upperOperation`]: '<=',
    });
  });

  it('ANDs ungrouped filters and ORs filters sharing a group', () => {
    const map = filtered(PAGE, [
      { property: 'cq:template', value: TEMPLATE },
      { group: 'templates', property: 'cq:template', value: '/conf/site/templates/other' },
      { group: 'templates', property: 'cq:template', value: '/conf/site/templates/third' },
    ]);
    expect(Object.keys(map).filter((key) => key.startsWith('9002_group.'))).toHaveLength(2);
    expect(Object.keys(map).filter((key) => key.startsWith('9003_group.'))).toHaveLength(5);
    expect(flagged(map, 'p.or')).toEqual(['9003_group.p.or']);
  });

  it("refuses a map that already uses one of the filter's own group prefixes", () => {
    for (const key of ['9001_group.p.or', '9002_group.1_property', '9005_group.p.or']) {
      const result = applySearchFilters({ type: 'cq:Page', [key]: 'x' }, [
        { property: 'cq:template', value: TEMPLATE },
      ]);
      expect(result.ok).toBe(false);
    }
  });

  it('refuses a shape it cannot filter exactly, rather than dropping the filter', () => {
    for (const predicates of [
      { type: 'nt:unstructured', fulltext: 'waldo' },
      { fulltext: 'waldo', nodename: '*-draft' },
      { property: 'jcr:title', 'property.value': 'x' },
    ]) {
      expect(
        applySearchFilters(predicates, [{ property: 'cq:template', value: TEMPLATE }]).ok,
      ).toBe(false);
    }
  });

  it('produces maps that aem_query accepts and forwards to QueryBuilder intact', () => {
    const filterSets: readonly SearchFilter[][] = [
      [{ property: 'cq:template', value: TEMPLATE }],
      [{ property: 'cq:lastModified', operator: 'after', value: '2026-01-01' }],
      [{ property: 'cq:lastReplicationAction', value: 'Activate', negate: true }],
    ];
    for (const predicates of [{ fulltext: 'waldo' }, PAGE, COMPONENT]) {
      for (const filters of filterSets) {
        const map = filtered(predicates, filters);
        const args = aemQueryArgsSchema.parse({ predicates: map });
        const built = buildQueryUrl({
          origin: 'https://author.example',
          predicates: args.predicates,
          offset: args.offset,
          limit: args.limit,
          properties: args.properties,
        });
        if (!built.ok) throw new Error(`expected a built URL, got ${built.error.kind}`);
        const url = new URL(built.value.url);
        for (const [key, value] of Object.entries(map)) {
          expect(url.searchParams.get(key)).toBe(value);
        }
      }
    }
  });
});

describe('describing filters', () => {
  it('renders an equality, a negation, an operator and an OR group', () => {
    expect(describeSearchFilters([{ property: 'cq:template', value: TEMPLATE }])).toBe(
      `cq:template=${TEMPLATE}`,
    );
    expect(
      describeSearchFilters([{ property: REPLICATION, value: 'Activate', negate: true }]),
    ).toBe('not (cq:lastReplicationAction=Activate)');
    expect(
      describeSearchFilters([
        { property: 'cq:lastModified', operator: 'after', value: '2026-01-01' },
      ]),
    ).toBe('cq:lastModified after 2026-01-01');
    expect(
      describeSearchFilters([
        { group: 'templates', property: 'cq:template', value: 'A' },
        { group: 'templates', property: 'cq:template', value: 'B' },
      ]),
    ).toBe('(cq:template=A or cq:template=B)');
  });

  it('reads a raw value only when it is a set of valid filters', () => {
    const filters = [{ property: 'cq:template', value: TEMPLATE }];
    expect(describeFiltersValue(filters)).toBe(`cq:template=${TEMPLATE}`);
    expect(describeFiltersValue(undefined)).toBeUndefined();
    expect(describeFiltersValue({ property: 'x' })).toBeUndefined();
    expect(describeFiltersValue([{ property: 'x' }])).toBeUndefined();
  });
});

describe('isComponentSearchPredicates', () => {
  it('recognises a sling:resourceType property match at any group level', () => {
    expect(isComponentSearchPredicates({ property: 'sling:resourceType' })).toBe(true);
    expect(isComponentSearchPredicates({ '1_property': 'sling:resourceType' })).toBe(true);
    expect(isComponentSearchPredicates({ 'group.2_property': 'sling:resourceType' })).toBe(true);
    expect(isComponentSearchPredicates({ property: 'jcr:content/cq:template' })).toBe(false);
    expect(isComponentSearchPredicates({ 'property.value': 'sling:resourceType' })).toBe(false);
  });
});
