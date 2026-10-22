import { z } from 'zod';

/**
 * Page-property filters for the search composites: keep only results whose
 * page (or asset) carries a given property value.
 *
 * **One model-facing shape, applied by the search's own shape.** A filter names
 * a property **relative to the item's content node** - `cq:template`, not
 * `jcr:content/cq:template` - and the application turns it into the predicates
 * that shape needs:
 *
 * - a page or an asset (`type=cq:Page` / `type=dam:Asset`): its own
 *   `jcr:content/<property>`;
 * - a component instance (`sling:resourceType`): an OR over ancestor content
 *   nodes (`../<property>`, `../../<property>`, ...), because QueryBuilder has
 *   no joins. The ancestor chain of a component contains exactly one
 *   `jcr:content` - its owning page's - so for a property only a page content
 *   node carries (`cq:template`, `cq:lastReplicationAction`) the OR is exact;
 * - a plain full-text search (`fulltext`, optionally `path`): typed to pages and
 *   assets, then the content-node condition.
 *
 * **Operators.** `equals` (default), `like` and `exists` use QueryBuilder's
 * `property` predicate; the date operators (`after`, `onOrAfter`, `before`,
 * `onOrBefore`) use `daterange` and the numeric ones (`above`, `atLeast`,
 * `below`, `atMost`) use `rangeproperty`. A range takes one value per filter, so
 * a between is two filters, one per bound.
 *
 * **Boolean shape.** Filters are ANDed; filters sharing a `group` label are
 * ORed instead, which is how several templates (or the relative and absolute
 * spelling of one resource type) stay one condition. `negate` is the complement
 * of the whole filter - the same condition with `p.not` - and never combines
 * with `group`, whose OR would make a per-filter negation unnecessary and its
 * meaning ambiguous.
 *
 * The injected predicates use reserved, high numeric group prefixes: QueryBuilder
 * silently ignores a non-numeric prefix (`filter_group`), and a low number could
 * collide with the model's own groups. A predicate map that already uses one of
 * these reserved prefixes is refused rather than overwritten.
 */

export const SEARCH_FILTER_OPERATORS = [
  'equals',
  'like',
  'exists',
  'after',
  'onOrAfter',
  'before',
  'onOrBefore',
  'above',
  'atLeast',
  'below',
  'atMost',
] as const;
export type SearchFilterOperator = (typeof SEARCH_FILTER_OPERATORS)[number];

/** How many filters one call may carry; each adds a whole condition per shape. */
export const MAX_SEARCH_FILTERS = 4;

/**
 * How many ancestor levels a component instance's filter climbs to find its
 * page's content node. The deepest component observed live sat 13 levels below
 * it, so 15 leaves headroom while keeping each OR group small; an instance
 * nested deeper than this is not reached by the filter.
 */
export const FILTER_ANCESTOR_DEPTH = 15;

/** The page and asset types a full-text search is narrowed to before filtering. */
const PUBLISHABLE_TYPES = ['cq:Page', 'dam:Asset'] as const;

/** The group that types a full-text search to pages and assets. */
const TYPE_GROUP = '9001_group';

/** The first group a filter owns; the last is `FILTER_GROUP_BASE + MAX_SEARCH_FILTERS - 1`. */
const FILTER_GROUP_BASE = 9002;

/** Every group prefix this module owns; a model predicate using one is refused. */
const RESERVED_PREFIXES = [
  TYPE_GROUP,
  ...Array.from(
    { length: MAX_SEARCH_FILTERS },
    (_, index) => `${String(FILTER_GROUP_BASE + index)}_group`,
  ),
] as const;

/** Keys a plain full-text predicate map may carry besides `fulltext`. */
const FULLTEXT_SHAPE_KEYS = new Set(['fulltext', 'path']);

/** A `property` predicate key: `property`, `1_property`, `group.1_property`, ... */
const PROPERTY_PREDICATE_KEY = /(?:^|[._])property$/;

type Predicates = Readonly<Record<string, string>>;

/** How a filter's values are compared; `equals` is the default. */
const OPERATOR_TEXT: Readonly<Record<Exclude<SearchFilterOperator, 'equals'>, string>> = {
  like: 'like',
  exists: 'exists',
  after: 'after',
  onOrAfter: 'on or after',
  before: 'before',
  onOrBefore: 'on or before',
  above: 'above',
  atLeast: 'at least',
  below: 'below',
  atMost: 'at most',
};

/** A property path this module can place safely, or a message naming the problem. */
function normalizeFilterProperty(property: string): string | undefined {
  const trimmed = property.trim();
  if (trimmed.startsWith('/')) return undefined;
  // Tolerate the shape a raw predicate would carry; the model is not asked to
  // remember where the content node is.
  const relative = trimmed.startsWith('jcr:content/')
    ? trimmed.slice('jcr:content/'.length)
    : trimmed;
  const segments = relative.split('/');
  if (
    relative === '' ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  if (segments.some((segment) => segment.includes('*') || segment.includes('['))) return undefined;
  return relative;
}

export const searchFilterSchema = z
  .object({
    property: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe(
        "The property to check, relative to the item's content node: `cq:template`, not " +
          '`jcr:content/cq:template`. A nested path is allowed (`metadata/dc:format` for an ' +
          'asset).',
      ),
    operator: z
      .enum(SEARCH_FILTER_OPERATORS)
      .optional()
      .describe(
        'How to compare. Omitted means `equals`. `like` uses % wildcards; `exists` needs no ' +
          'value; `after`/`onOrAfter`/`before`/`onOrBefore` compare a DATE; ' +
          '`above`/`atLeast`/`below`/`atMost` compare a number.',
      ),
    value: z
      .string()
      .max(2000)
      .optional()
      .describe('The value to compare with. Required for every operator except `exists`.'),
    negate: z
      .boolean()
      .optional()
      .describe('Keep only the results that do NOT satisfy this filter.'),
    group: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .optional()
      .describe(
        'Filters sharing a group label are ORed; every other filter is ANDed. Use it for a ' +
          'set of alternatives, such as several templates.',
      ),
  })
  .strict()
  .superRefine((filter, ctx) => {
    const operator = filter.operator ?? 'equals';
    if (operator === 'exists') {
      if (filter.value !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: '`exists` takes no `value`',
          path: ['value'],
        });
      }
    } else if (filter.value === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `\`${operator}\` needs a \`value\``,
        path: ['value'],
      });
    }
    if (filter.negate === true && filter.group !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'a grouped filter cannot be negated',
        path: ['negate'],
      });
    }
    if (normalizeFilterProperty(filter.property) === undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          '`property` must be a plain relative path (no leading slash, no `.`/`..` segment, ' +
          'no wildcard)',
        path: ['property'],
      });
    }
  });

export type SearchFilter = z.infer<typeof searchFilterSchema>;

export const searchFiltersSchema = z
  .array(searchFilterSchema)
  .min(1)
  .max(MAX_SEARCH_FILTERS)
  .describe(
    'Optional page-property filters, at most four. Each keeps only results whose page carries ' +
      'the property value; a component search applies them to the page that owns the component. ' +
      'Filters are ANDed unless they share a `group`, where they are ORed.',
  );

/**
 * Whether the predicates match on a component's `sling:resourceType` - i.e. the
 * hits are component instances rather than pages or assets.
 */
export function isComponentSearchPredicates(predicates: Predicates): boolean {
  return Object.entries(predicates).some(
    ([key, value]) => PROPERTY_PREDICATE_KEY.test(key) && value === 'sling:resourceType',
  );
}

/** The shape a filter can be applied to, or `undefined` when there is none. */
type SearchShape = 'component' | 'content' | 'fulltext';

function resolveShape(predicates: Predicates): SearchShape | undefined {
  if (isComponentSearchPredicates(predicates)) return 'component';
  const type = predicates['type'];
  if (type !== undefined && (PUBLISHABLE_TYPES as readonly string[]).includes(type)) {
    return 'content';
  }
  const keys = Object.keys(predicates);
  if (keys.includes('fulltext') && keys.every((key) => FULLTEXT_SHAPE_KEYS.has(key))) {
    return 'fulltext';
  }
  return undefined;
}

export type SearchFilterResult =
  | { readonly ok: true; readonly predicates: Predicates }
  | { readonly ok: false; readonly message: string };

/** One filter's condition, as QueryBuilder predicate entries under a group. */
function conditionPredicates(
  groupPrefix: string,
  index: number,
  propertyPath: string,
  filter: SearchFilter,
): Record<string, string> {
  const operator = filter.operator ?? 'equals';
  const key = (suffix: string): string => `${groupPrefix}.${String(index)}_${suffix}`;
  const value = filter.value ?? '';

  switch (operator) {
    case 'exists':
      return { [key('property')]: propertyPath, [key('property.operation')]: 'exists' };
    case 'like':
      return {
        [key('property')]: propertyPath,
        [key('property.operation')]: 'like',
        [key('property.value')]: value,
      };
    case 'after':
    case 'onOrAfter':
      return {
        [key('daterange.property')]: propertyPath,
        [key('daterange.lowerBound')]: value,
        [key('daterange.lowerOperation')]: operator === 'after' ? '>' : '>=',
      };
    case 'before':
    case 'onOrBefore':
      return {
        [key('daterange.property')]: propertyPath,
        [key('daterange.upperBound')]: value,
        [key('daterange.upperOperation')]: operator === 'before' ? '<' : '<=',
      };
    case 'above':
    case 'atLeast':
      return {
        [key('rangeproperty.property')]: propertyPath,
        [key('rangeproperty.lowerBound')]: value,
        [key('rangeproperty.lowerOperation')]: operator === 'above' ? '>' : '>=',
      };
    case 'below':
    case 'atMost':
      return {
        [key('rangeproperty.property')]: propertyPath,
        [key('rangeproperty.upperBound')]: value,
        [key('rangeproperty.upperOperation')]: operator === 'below' ? '<' : '<=',
      };
    case 'equals':
      return { [key('property')]: propertyPath, [key('property.value')]: value };
  }
}

/** The property path a filter tests for one shape at one ancestor depth. */
function propertyPathFor(shape: SearchShape, property: string, depth: number | undefined): string {
  if (shape !== 'component') return `jcr:content/${property}`;
  const climb = '../'.repeat(depth ?? 1);
  return `${climb}${property}`;
}

/** How many property paths one filter produces for a shape. */
function depthCount(shape: SearchShape): number {
  return shape === 'component' ? FILTER_ANCESTOR_DEPTH : 1;
}

interface PlannedGroup {
  readonly filters: SearchFilter[];
  readonly negate: boolean;
}

/** Groups the filters: an ungrouped filter is its own group, a label is one OR group. */
function planGroups(filters: readonly SearchFilter[]): PlannedGroup[] {
  const byLabel = new Map<string, PlannedGroup>();
  const groups: PlannedGroup[] = [];
  for (const filter of filters) {
    if (filter.group === undefined) {
      groups.push({ filters: [filter], negate: filter.negate === true });
      continue;
    }
    const existing = byLabel.get(filter.group);
    if (existing !== undefined) {
      existing.filters.push(filter);
      continue;
    }
    const group: PlannedGroup = { filters: [filter], negate: false };
    byLabel.set(filter.group, group);
    groups.push(group);
  }
  return groups;
}

/**
 * Adds page-property filters to a search's predicates, by the search's shape.
 *
 * - a component search (`sling:resourceType`) - an OR over ancestor content
 *   nodes per filter;
 * - `type=cq:Page` or `type=dam:Asset` - the item's own content node;
 * - a plain full-text search (`fulltext`, optionally `path`) - typed to pages
 *   and assets, then the content node.
 *
 * Any other shape is refused with a message naming the supported ones: a
 * filter the application cannot apply exactly must not be dropped silently.
 * With no filters the predicates are returned unchanged.
 */
export function applySearchFilters(
  predicates: Predicates,
  filters: readonly SearchFilter[] | undefined,
): SearchFilterResult {
  if (filters === undefined || filters.length === 0) return { ok: true, predicates };
  // The composites parse their arguments, but this function is also called with
  // a directly built array; a filter is never applied half-understood.
  const parsed = searchFiltersSchema.safeParse(filters);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'Invalid search filter',
    };
  }
  const properties = new Map<SearchFilter, string>();
  for (const filter of parsed.data) {
    const property = normalizeFilterProperty(filter.property);
    if (property === undefined) {
      return {
        ok: false,
        message: `'${filter.property}' is not a valid filter property`,
      };
    }
    properties.set(filter, property);
  }
  const shape = resolveShape(predicates);
  if (shape === undefined) {
    return {
      ok: false,
      message:
        '`filters` applies to a full-text search, to predicates with type=cq:Page or ' +
        'type=dam:Asset, or to a component search by sling:resourceType; these predicates are ' +
        'none of those',
    };
  }
  const reserved = Object.keys(predicates).find((key) =>
    RESERVED_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}.`)),
  );
  if (reserved !== undefined) {
    return {
      ok: false,
      message:
        `'${reserved}' is reserved for the application's filters; ` +
        'number your own groups below 9000',
    };
  }

  const added: Record<string, string> = {};
  if (shape === 'fulltext') {
    added[`${TYPE_GROUP}.p.or`] = 'true';
    PUBLISHABLE_TYPES.forEach((type, index) => {
      added[`${TYPE_GROUP}.${String(index + 1)}_type`] = type;
    });
  }

  planGroups(parsed.data).forEach((group, groupIndex) => {
    const groupPrefix = `${String(FILTER_GROUP_BASE + groupIndex)}_group`;
    let index = 0;
    for (const filter of group.filters) {
      const property = properties.get(filter);
      if (property === undefined) continue; // every filter was resolved above
      for (let depth = 1; depth <= depthCount(shape); depth += 1) {
        index += 1;
        const propertyPath = propertyPathFor(
          shape,
          property,
          shape === 'component' ? depth : undefined,
        );
        Object.assign(added, conditionPredicates(groupPrefix, index, propertyPath, filter));
      }
    }
    if (index > 1) added[`${groupPrefix}.p.or`] = 'true';
    if (group.negate) added[`${groupPrefix}.p.not`] = 'true';
  });

  return { ok: true, predicates: { ...predicates, ...added } };
}

/** One filter as a readable clause: `cq:template=/conf/...`, `not (cq:template=...)`. */
function describeFilter(filter: SearchFilter): string {
  const operator = filter.operator ?? 'equals';
  const value = filter.value ?? '';
  const body =
    operator === 'equals'
      ? `${filter.property}=${value}`
      : operator === 'exists'
        ? `${filter.property} exists`
        : `${filter.property} ${OPERATOR_TEXT[operator]} ${value}`;
  return filter.negate === true ? `not (${body})` : body;
}

/** The filters as one readable line: AND clauses joined by `;`, OR groups in parentheses. */
export function describeSearchFilters(
  filters: readonly SearchFilter[] | undefined,
): string | undefined {
  if (filters === undefined || filters.length === 0) return undefined;
  return planGroups(filters)
    .map((group) => {
      const first = group.filters[0];
      if (first === undefined) return '';
      return group.filters.length === 1
        ? describeFilter(first)
        : `(${group.filters.map(describeFilter).join(' or ')})`;
    })
    .filter((clause) => clause !== '')
    .join('; ');
}

/** {@link describeSearchFilters} for a raw argument/result value, tolerating anything else. */
export function describeFiltersValue(value: unknown): string | undefined {
  const parsed = z.array(searchFilterSchema).safeParse(value);
  return parsed.success ? describeSearchFilters(parsed.data) : undefined;
}
