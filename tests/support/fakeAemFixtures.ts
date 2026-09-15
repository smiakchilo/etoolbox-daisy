import type { JsonValue } from '../../src/shared/contracts/agentEvents';

/**
 * A tiny in-memory JCR-like repository standing in for a real AEM instance
 * (implementation-plan.md step 03 success criterion: contracts "do not
 * depend on real AEM"). No network, no filesystem - the fake browser/preload
 * side (`fakeBrowserSide.ts`) reads only from this module.
 */
export interface FixtureNode {
  readonly path: string;
  readonly properties: Readonly<Record<string, JsonValue>>;
  /** Immediate child node names only - this fixture never models descendants. */
  readonly children: readonly string[];
}

export interface FixtureQueryRow {
  readonly path: string;
  readonly properties: Readonly<Record<string, JsonValue>>;
}

const NODES: readonly FixtureNode[] = [
  {
    path: '/content/site',
    properties: { 'jcr:primaryType': 'cq:Page', 'jcr:title': 'Home' },
    children: ['jcr:content', 'en', 'fr'],
  },
  {
    path: '/content/site/jcr:content',
    properties: {
      'jcr:primaryType': 'cq:PageContent',
      'jcr:title': 'Home',
      'sling:resourceType': 'site/components/homepage',
    },
    children: [],
  },
  {
    path: '/content/site/en',
    properties: { 'jcr:primaryType': 'cq:Page', 'jcr:title': 'English Home' },
    children: ['jcr:content'],
  },
  {
    path: '/content/site/fr',
    properties: { 'jcr:primaryType': 'cq:Page', 'jcr:title': 'Accueil' },
    children: ['jcr:content'],
  },
  {
    path: '/content/dam/report.pdf',
    properties: { 'jcr:primaryType': 'dam:Asset' },
    children: ['jcr:content'],
  },
];

const QUERY_ROWS: readonly FixtureQueryRow[] = [
  { path: '/content/site', properties: { 'jcr:primaryType': 'cq:Page', 'jcr:title': 'Home' } },
  {
    path: '/content/site/en',
    properties: { 'jcr:primaryType': 'cq:Page', 'jcr:title': 'English Home' },
  },
  {
    path: '/content/site/fr',
    properties: { 'jcr:primaryType': 'cq:Page', 'jcr:title': 'Accueil' },
  },
  {
    path: '/content/dam/report.pdf',
    properties: { 'jcr:primaryType': 'dam:Asset', 'jcr:title': 'Quarterly Report' },
  },
];

export class FixtureRepository {
  findNode(path: string): FixtureNode | undefined {
    return NODES.find((node) => node.path === path);
  }

  /**
   * Filters the fixed row set by a handful of predicate keys, standing in for
   * AEM QueryBuilder's own predicate evaluation. Deliberately not the same
   * validated shape as `queryPredicatesSchema` - the schema already governs
   * which *keys* are legal; this is just enough matching logic to produce
   * an honest, non-trivial result set (including a genuinely empty one).
   *
   * `estimateOnly` is a fixture-only convenience key (an ordinary,
   * non-reserved customer predicate as far as the validator is concerned) so
   * a test can force `hasMore: "unknown"` without a real AEM
   * `p.guessTotal` estimator behind it.
   */
  runQuery(predicates: Readonly<Record<string, string>>): {
    readonly rows: readonly FixtureQueryRow[];
    readonly forceUnknownHasMore: boolean;
  } {
    let matched = QUERY_ROWS;
    const pathPrefix = predicates.path;
    if (pathPrefix !== undefined) {
      matched = matched.filter((row) => row.path.startsWith(pathPrefix));
    }
    const type = predicates.type;
    if (type !== undefined) {
      matched = matched.filter((row) => row.properties['jcr:primaryType'] === type);
    }
    const fulltext = predicates.fulltext;
    if (fulltext !== undefined) {
      matched = matched.filter((row) => {
        const title = row.properties['jcr:title'];
        return typeof title === 'string' && title.toLowerCase().includes(fulltext.toLowerCase());
      });
    }
    return { rows: matched, forceUnknownHasMore: predicates.estimateOnly === 'true' };
  }
}
