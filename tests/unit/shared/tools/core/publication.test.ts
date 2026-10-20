import { describe, expect, it } from 'vitest';
import {
  type Publication,
  PUBLICATION_ANCESTOR_DEPTH,
  PUBLICATION_STATES,
  ancestorPublicationPredicates,
  applyPublicationFilter,
  buildQueryUrl,
  contentPublicationPredicates,
  describePublication,
  isComponentSearchPredicates,
  publicationSchema,
} from '../../../../../src/shared';
import { aemQueryArgsSchema } from '../../../../../src/tools/aem-query/aemQuery';

const REPLICATION = 'cq:lastReplicationAction';

/** The property paths a publication group tests, in order. */
function propertyPaths(predicates: Readonly<Record<string, string>>): string[] {
  return Object.entries(predicates)
    .filter(([key]) => /_property$/.test(key))
    .map(([, value]) => value);
}

/** The keys of a predicate map that set `p.not` / `p.or` on some group. */
function flagged(predicates: Readonly<Record<string, string>>, flag: 'p.not' | 'p.or'): string[] {
  return Object.keys(predicates).filter((key) => key.endsWith(`.${flag}`));
}

function filtered(
  predicates: Readonly<Record<string, string>>,
  publication: Publication,
): Readonly<Record<string, string>> {
  const result = applyPublicationFilter(predicates, publication);
  if (!result.ok) throw new Error(`expected the filter to apply, got: ${result.message}`);
  return result.predicates;
}

describe('publication schema and billet reading', () => {
  it('accepts exactly the two states', () => {
    for (const state of PUBLICATION_STATES) expect(publicationSchema.parse(state)).toBe(state);
    expect(publicationSchema.safeParse('live').success).toBe(false);
  });

  it('reads each state distinctly and nothing for an absent or unknown value', () => {
    const published = describePublication('published');
    const unpublished = describePublication('unpublished');
    expect(published).toBeTypeOf('string');
    expect(unpublished).toBeTypeOf('string');
    expect(published).not.toBe(unpublished);
    expect(describePublication(undefined)).toBeUndefined();
    expect(describePublication('live')).toBeUndefined();
  });
});

describe('publication predicate groups', () => {
  it("tests the content node's replication action for a page or asset", () => {
    const published = contentPublicationPredicates('published');
    expect(propertyPaths(published)).toEqual([`jcr:content/${REPLICATION}`]);
    expect(Object.values(published)).toContain('Activate');
    expect(flagged(published, 'p.not')).toEqual([]);
  });

  it('climbs one ancestor more per entry, up to the ancestor depth, ORed', () => {
    const published = ancestorPublicationPredicates('published');
    const paths = propertyPaths(published);
    expect(paths).toHaveLength(PUBLICATION_ANCESTOR_DEPTH);
    paths.forEach((path, index) => {
      expect(path).toBe(`${'../'.repeat(index + 1)}${REPLICATION}`);
    });
    expect(flagged(published, 'p.or')).toHaveLength(1);
    expect(flagged(published, 'p.not')).toEqual([]);
  });

  it('negates the very same group for "unpublished", so the two are exact complements', () => {
    for (const build of [contentPublicationPredicates, ancestorPublicationPredicates]) {
      const published = build('published');
      const unpublished = build('unpublished');
      const negation = flagged(unpublished, 'p.not');
      expect(negation).toHaveLength(1);
      const withoutNegation = Object.fromEntries(
        Object.entries(unpublished).filter(([key]) => key !== negation[0]),
      );
      expect(withoutNegation).toEqual(published);
    }
  });
});

describe('applyPublicationFilter', () => {
  it('returns the predicates unchanged when no publication is asked for', () => {
    const predicates = { type: 'nt:base', property: 'x' };
    expect(applyPublicationFilter(predicates, undefined)).toEqual({ ok: true, predicates });
  });

  it('adds the ancestor group to a component search, keeping the query itself', () => {
    const predicates = {
      type: 'nt:unstructured',
      property: 'sling:resourceType',
      'property.1_value': 'site/components/text',
    };
    expect(filtered(predicates, 'published')).toEqual({
      ...predicates,
      ...ancestorPublicationPredicates('published'),
    });
  });

  it('adds the content group to a page or an asset search', () => {
    for (const type of ['cq:Page', 'dam:Asset']) {
      const predicates = { type, fulltext: 'waldo' };
      expect(filtered(predicates, 'unpublished')).toEqual({
        ...predicates,
        ...contentPublicationPredicates('unpublished'),
      });
    }
  });

  it('types a plain full-text search to pages and assets before the content group', () => {
    const predicates = { fulltext: 'waldo', path: '/content/site' };
    const result = filtered(predicates, 'published');
    expect(result).toMatchObject({ ...predicates, ...contentPublicationPredicates('published') });
    const types = Object.entries(result)
      .filter(([key]) => /_type$/.test(key))
      .map(([, value]) => value);
    expect(types).toEqual(['cq:Page', 'dam:Asset']);
    expect(flagged(result, 'p.or')).toHaveLength(1);
  });

  it('refuses a shape it cannot filter exactly, rather than dropping the filter', () => {
    for (const predicates of [
      { type: 'nt:unstructured', fulltext: 'waldo' },
      { fulltext: 'waldo', nodename: '*-draft' },
      { property: 'jcr:title', 'property.value': 'x' },
    ]) {
      expect(applyPublicationFilter(predicates, 'published').ok).toBe(false);
    }
  });

  it("refuses a map that already uses the filter's own group prefixes", () => {
    const published = filtered({ fulltext: 'waldo' }, 'published');
    const groupKeys = Object.keys(published).filter((key) => key !== 'fulltext');
    for (const key of groupKeys) {
      const predicates = { type: 'cq:Page', [key]: 'x' };
      expect(applyPublicationFilter(predicates, 'published').ok).toBe(false);
    }
  });

  it('produces maps that aem_query accepts and forwards to QueryBuilder intact', () => {
    for (const predicates of [
      { fulltext: 'waldo' },
      { type: 'cq:Page' },
      { type: 'nt:unstructured', property: 'sling:resourceType', 'property.value': 'a/b' },
    ]) {
      for (const publication of PUBLICATION_STATES) {
        const map = filtered(predicates, publication);
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

describe('isComponentSearchPredicates', () => {
  it('recognises a sling:resourceType property match at any group level', () => {
    expect(isComponentSearchPredicates({ property: 'sling:resourceType' })).toBe(true);
    expect(isComponentSearchPredicates({ '1_property': 'sling:resourceType' })).toBe(true);
    expect(isComponentSearchPredicates({ 'group.2_property': 'sling:resourceType' })).toBe(true);
    expect(isComponentSearchPredicates({ property: 'jcr:content/cq:template' })).toBe(false);
    expect(isComponentSearchPredicates({ 'property.value': 'sling:resourceType' })).toBe(false);
  });
});
