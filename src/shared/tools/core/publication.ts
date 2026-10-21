import { z } from 'zod';

/**
 * Publication filtering for the search composites: "only published" or "only
 * not published" content, as QueryBuilder predicates.
 *
 * **Published** means the last replication action recorded on the content node
 * is `Activate` (`jcr:content/cq:lastReplicationAction`); **not published** is
 * its exact complement - deactivated, or never published at all (the property
 * is absent). Both are verified live on AEM 6.5 - see
 * `docs/compatibility.md` §11.7.
 *
 * QueryBuilder has no joins. A page or asset carries the property on its own
 * `jcr:content`, so a relative property path reaches it. A component instance
 * lives *under* its page's `jcr:content`, at an unknown depth, so the filter is
 * an OR over the ancestors (`..`, `../..`, ...) up to
 * {@link PUBLICATION_ANCESTOR_DEPTH}; only the page content node carries the
 * property, so the first ancestor that has it decides.
 *
 * The injected predicates use reserved, high numeric group prefixes:
 * QueryBuilder silently ignores a non-numeric prefix (`publication_group`), and a
 * low number could collide with the model's own groups. A predicate map that
 * already uses a reserved prefix is refused rather than overwritten.
 */

/** Which publication state a search keeps; omitted means any state. */
export const PUBLICATION_STATES = ['published', 'unpublished'] as const;
export type Publication = (typeof PUBLICATION_STATES)[number];

export const publicationSchema = z
  .enum(PUBLICATION_STATES)
  .describe(
    'Optional. "published" keeps only published (activated) content, "unpublished" only content ' +
      'that is not published (deactivated or never published). Omit it to search content in ' +
      'any state.',
  );

/** A billet's reading of a `publication` argument; `undefined` when it is absent or unknown. */
export function describePublication(value: unknown): string | undefined {
  if (value === 'published') return 'Published';
  if (value === 'unpublished') return 'Not published';
  return undefined;
}

/**
 * How many ancestor levels a component instance's publication filter climbs to
 * find its page's content node. The deepest component observed live sat 13
 * levels below it, so 15 leaves headroom while keeping the OR group small; an
 * instance nested deeper than this is not reached by the filter, so it reads as
 * not published.
 */
export const PUBLICATION_ANCESTOR_DEPTH = 15;

/** The replication property, relative to a page's or asset's content node. */
const REPLICATION_ACTION_PROPERTY = 'cq:lastReplicationAction';
const PUBLISHED_ACTION = 'Activate';

/** The group that types a full-text search to pages and assets. */
const TYPE_GROUP = '9001_group';
/** The group that carries the publication condition. */
const STATE_GROUP = '9002_group';
const RESERVED_PREFIXES = [TYPE_GROUP, STATE_GROUP] as const;

/** The content types a publication filter applies to directly. */
const PUBLISHABLE_TYPES = ['cq:Page', 'dam:Asset'] as const;

/** Keys a plain full-text predicate map may carry besides `fulltext`. */
const FULLTEXT_SHAPE_KEYS = new Set(['fulltext', 'path']);

/** A `property` predicate key: `property`, `1_property`, `group.1_property`, ... */
const PROPERTY_PREDICATE_KEY = /(?:^|[._])property$/;

type Predicates = Readonly<Record<string, string>>;

/**
 * Whether the predicates match on a component's `sling:resourceType` - i.e. the
 * hits are component instances rather than pages or assets.
 */
export function isComponentSearchPredicates(predicates: Predicates): boolean {
  return Object.entries(predicates).some(
    ([key, value]) => PROPERTY_PREDICATE_KEY.test(key) && value === 'sling:resourceType',
  );
}

/** The publication condition as one group; `p.not` turns it into its complement. */
function stateGroup(publication: Publication, propertyPaths: readonly string[]): Predicates {
  const group: Record<string, string> = {};
  if (propertyPaths.length > 1) group[`${STATE_GROUP}.p.or`] = 'true';
  if (publication === 'unpublished') group[`${STATE_GROUP}.p.not`] = 'true';
  propertyPaths.forEach((propertyPath, index) => {
    const key = `${STATE_GROUP}.${String(index + 1)}_property`;
    group[key] = propertyPath;
    group[`${key}.value`] = PUBLISHED_ACTION;
  });
  return group;
}

/** The condition for a page or asset: its own content node's replication action. */
export function contentPublicationPredicates(publication: Publication): Predicates {
  return stateGroup(publication, [`jcr:content/${REPLICATION_ACTION_PROPERTY}`]);
}

/** The condition for a component instance: an ancestor's (its page content node's) action. */
export function ancestorPublicationPredicates(publication: Publication): Predicates {
  const paths = Array.from(
    { length: PUBLICATION_ANCESTOR_DEPTH },
    (_, index) =>
      `${Array.from({ length: index + 1 }, () => '..').join('/')}/${REPLICATION_ACTION_PROPERTY}`,
  );
  return stateGroup(publication, paths);
}

/** Types a full-text search to the content a publication state applies to. */
function pageOrAssetTypePredicates(): Predicates {
  const group: Record<string, string> = { [`${TYPE_GROUP}.p.or`]: 'true' };
  PUBLISHABLE_TYPES.forEach((type, index) => {
    group[`${TYPE_GROUP}.${String(index + 1)}_type`] = type;
  });
  return group;
}

function isPublishableType(predicates: Predicates): boolean {
  const type = predicates['type'];
  return type !== undefined && (PUBLISHABLE_TYPES as readonly string[]).includes(type);
}

function isFulltextShape(predicates: Predicates): boolean {
  const keys = Object.keys(predicates);
  return keys.includes('fulltext') && keys.every((key) => FULLTEXT_SHAPE_KEYS.has(key));
}

export type PublicationFilterResult =
  | { readonly ok: true; readonly predicates: Predicates }
  | { readonly ok: false; readonly message: string };

/**
 * Adds a publication condition to a search's predicates, by the search's shape:
 *
 * - a component search (`sling:resourceType`) - the ancestor condition;
 * - `type=cq:Page` or `type=dam:Asset` - the content condition;
 * - a plain full-text search (`fulltext`, optionally `path`) - typed to pages
 *   and assets, then the content condition.
 *
 * Any other shape is refused with a message naming the supported ones: a
 * filter the application cannot apply exactly must not be dropped silently.
 * With no `publication` the predicates are returned unchanged.
 */
export function applyPublicationFilter(
  predicates: Predicates,
  publication: Publication | undefined,
): PublicationFilterResult {
  if (publication === undefined) return { ok: true, predicates };
  const reserved = Object.keys(predicates).find((key) =>
    RESERVED_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}.`)),
  );
  if (reserved !== undefined) {
    return {
      ok: false,
      message:
        `'${reserved}' is reserved for the publication filter; ` +
        'number your own groups below 9000',
    };
  }
  if (isComponentSearchPredicates(predicates)) {
    return {
      ok: true,
      predicates: { ...predicates, ...ancestorPublicationPredicates(publication) },
    };
  }
  if (isPublishableType(predicates)) {
    return {
      ok: true,
      predicates: { ...predicates, ...contentPublicationPredicates(publication) },
    };
  }
  if (isFulltextShape(predicates)) {
    return {
      ok: true,
      predicates: {
        ...predicates,
        ...pageOrAssetTypePredicates(),
        ...contentPublicationPredicates(publication),
      },
    };
  }
  return {
    ok: false,
    message:
      '`publication` applies to a full-text search, to predicates with type=cq:Page or ' +
      'type=dam:Asset, or to a component search by sling:resourceType; these predicates are ' +
      'none of those',
  };
}
