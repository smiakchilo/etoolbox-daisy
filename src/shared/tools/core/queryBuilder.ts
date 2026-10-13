import { z } from 'zod';
import { parseOrigin } from '../../contracts';
import type { JsonValue } from '../../contracts';
import { type Result, err, ok } from '../../result';
import { TOTAL_GUESS_CAP } from './search';
import type { HasMore } from './resultCommon';
import type { JsonObject } from './responseValidation';

/**
 * AEM QueryBuilder URL building and response reading, shared by the tools that
 * speak to `/bin/querybuilder.json`.
 *
 * Moved out of `aem-query` because two callers need it: the `aem_query` tool
 * (page requests) and the `aem_query_format_ask` composite (its background
 * "honest count"). Nothing here names a tool; the builder is told which of the
 * two **modes** it is building, and the reader classifies a body the same way
 * for both.
 */

// ---------------------------------------------------------------------------
// Request URL
// ---------------------------------------------------------------------------

const QUERYBUILDER_ENDPOINT_PATH = '/bin/querybuilder.json';

/** QueryBuilder's own output-control parameters, which no predicate may shadow. */
const APPLICATION_OWNED_PARAMETERS = [
  'p.limit',
  'p.offset',
  'p.hits',
  'p.properties',
  'p.nodedepth',
  'p.guessTotal',
  'p.facets',
] as const;

/** The properties a page request returns when the caller selects none. */
export const DEFAULT_PROJECTION = ['jcr:path', 'jcr:primaryType', 'jcr:title'] as const;

/** The property every row is identified by; hoisted to the first table column. */
export const PATH_PROPERTY = 'jcr:path';

/** The count request's fixed shape (see `../accurate-search-total.md` section 3.2). */
const QUERY_COUNT_OFFSET = 0;
const QUERY_COUNT_LIMIT = 1;
const QUERY_COUNT_PROPERTIES = [PATH_PROPERTY] as const;

export type BuildQueryUrlError =
  | { readonly kind: 'invalid_origin' }
  | { readonly kind: 'reserved_parameter'; readonly parameter: string }
  | { readonly kind: 'unencodable_predicate' }
  | { readonly kind: 'query_not_preserved' };

/**
 * A **page** request: one page of results, sent with a numeric
 * `p.guessTotal` so QueryBuilder caps how far it counts.
 */
export interface BuildPageQueryUrlOptions {
  readonly mode?: 'page';
  readonly origin: string;
  readonly predicates: Readonly<Record<string, string>>;
  readonly offset: number;
  readonly limit: number;
  readonly properties?: readonly string[] | undefined;
}

/**
 * A **count** request: no paging, no `p.guessTotal`, `p.limit=1`,
 * `p.properties=jcr:path` - the cheapest request whose `total` is the honest,
 * fully access-checked count.
 */
export interface BuildCountQueryUrlOptions {
  readonly mode: 'count';
  readonly origin: string;
  readonly predicates: Readonly<Record<string, string>>;
}

export type BuildQueryUrlOptions = BuildPageQueryUrlOptions | BuildCountQueryUrlOptions;

export interface BuiltQueryUrl {
  readonly url: string;
  readonly projectedProperties: readonly string[];
}

function resolveProjection(
  requested: readonly string[] | undefined,
  fallback: readonly string[],
): readonly string[] {
  if (requested === undefined) return fallback;
  const resolved = [PATH_PROPERTY];
  for (const name of requested) {
    if (!resolved.includes(name)) {
      resolved.push(name);
    }
  }
  return resolved;
}

/**
 * Composes the QueryBuilder request URL. Serialization goes through
 * `URLSearchParams` rather than string concatenation, so a predicate value
 * containing `&`, `=`, `#`, or a newline cannot introduce a parameter,
 * terminate the query, or start a fragment. The composed URL is re-parsed and
 * every application-owned parameter required to appear exactly once with
 * exactly the intended value (or, for `p.guessTotal` in count mode, to be
 * absent).
 */
export function buildQueryUrl(
  options: BuildQueryUrlOptions,
): Result<BuiltQueryUrl, BuildQueryUrlError> {
  const originResult = parseOrigin(options.origin);
  if (!originResult.ok) {
    return err({ kind: 'invalid_origin' });
  }

  for (const reserved of APPLICATION_OWNED_PARAMETERS) {
    if (Object.prototype.hasOwnProperty.call(options.predicates, reserved)) {
      return err({ kind: 'reserved_parameter', parameter: reserved });
    }
  }

  const isCount = options.mode === 'count';
  const offset = isCount ? QUERY_COUNT_OFFSET : options.offset;
  const limit = isCount ? QUERY_COUNT_LIMIT : options.limit;
  const projectedProperties = isCount
    ? [...QUERY_COUNT_PROPERTIES]
    : resolveProjection(options.properties, [...DEFAULT_PROJECTION]);

  const params = new URLSearchParams();
  try {
    for (const [key, value] of Object.entries(options.predicates)) {
      // Ordinary scoped predicates - `group.p.or`, `1_group.p.or`,
      // `group.1_property`, `daterange.lowerBound` - are just keys here.
      // Nothing inspects a key's shape, so dotted and numeric group syntax
      // round-trips unchanged by construction.
      params.append(key, value);
    }
    params.append('p.offset', String(offset));
    params.append('p.limit', String(limit));
    params.append('p.hits', 'selective');
    params.append('p.properties', projectedProperties.join(' '));
    params.append('p.nodedepth', '0');
    if (!isCount) {
      params.append('p.guessTotal', String(TOTAL_GUESS_CAP));
    }
    params.append('p.facets', 'false');
  } catch {
    return err({ kind: 'unencodable_predicate' });
  }

  const search = params.toString();
  const candidate = `${originResult.origin}${QUERYBUILDER_ENDPOINT_PATH}?${search}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return err({ kind: 'query_not_preserved' });
  }

  if (
    url.origin !== originResult.origin ||
    url.pathname !== QUERYBUILDER_ENDPOINT_PATH ||
    url.hash !== ''
  ) {
    return err({ kind: 'query_not_preserved' });
  }

  const parsed = url.searchParams;
  const expected: ReadonlyArray<readonly [string, string]> = [
    ['p.offset', String(offset)],
    ['p.limit', String(limit)],
    ['p.hits', 'selective'],
    ['p.properties', projectedProperties.join(' ')],
    ['p.nodedepth', '0'],
    ['p.facets', 'false'],
    ...(isCount ? [] : ([['p.guessTotal', String(TOTAL_GUESS_CAP)]] as const)),
  ];
  for (const [name, value] of expected) {
    const values = parsed.getAll(name);
    if (values.length !== 1 || values[0] !== value) {
      return err({ kind: 'query_not_preserved' });
    }
  }
  // A count request must not carry `p.guessTotal` at all - its whole point is
  // the un-guessed total.
  if (isCount && parsed.getAll('p.guessTotal').length !== 0) {
    return err({ kind: 'query_not_preserved' });
  }

  return ok({ url: url.toString(), projectedProperties });
}

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

/**
 * The total number of matches, together with how much that number can be
 * trusted. Modelled as a discriminated union rather than a `total: number`
 * beside a separate `totalIsEstimate: boolean`, because those two fields can
 * disagree.
 *
 * `"atLeast"` (not `"estimated"`) is the honest name: with a numeric
 * `p.guessTotal` the reported figure is a **lower bound** - the true count is
 * at least this, possibly more - not an estimate that could be either side.
 */
export const totalMatchesSchema = z.discriminatedUnion('accuracy', [
  z.object({ accuracy: z.literal('exact'), value: z.number().int().nonnegative() }).strict(),
  z.object({ accuracy: z.literal('atLeast'), value: z.number().int().nonnegative() }).strict(),
  z.object({ accuracy: z.literal('unknown') }).strict(),
]);

export type TotalMatches = z.infer<typeof totalMatchesSchema>;

export type QueryEnvelopeOutcome =
  | { readonly kind: 'ok'; readonly value: QueryEnvelope }
  | { readonly kind: 'query_rejected' }
  | { readonly kind: 'malformed_envelope' };

export interface QueryEnvelope {
  readonly hits: readonly JsonValue[];
  /** Whether further pages of *matches* exist - derived, never the raw `more` flag (see {@link classifyEnvelope}). */
  readonly hasMore: HasMore;
  readonly total: TotalMatches;
}

function readNonNegativeInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Reads the two independent facts a QueryBuilder body carries and derives the
 * page-level ones from them.
 *
 * With a numeric `p.guessTotal` (see docs/compatibility.md's QueryBuilder
 * facts), `more` means **"more matches exist than `total`"**, not "there is a
 * page after this one". So:
 *
 * - `more: false` with a total - QueryBuilder enumerated everything it was
 *   allowed to (`total < cap`) or the result set ended exactly at the cap:
 *   the total is `exact`, and a further page exists exactly when this page
 *   did not account for it (`offset + returned < total`).
 * - `more: true` - the real count exceeds `total` (the cap): the total is
 *   `atLeast`, and further pages exist.
 * - `more` absent - nothing can be proved: `atLeast`, and page existence is
 *   `unknown`.
 * - no total at all - `unknown`, with the raw `more` (when boolean) deciding
 *   whether a page exists.
 *
 * The old code copied `more` straight into `hasMore` and only called a total
 * `exact` when the page accounted for it - which a numeric cap breaks: a
 * 43-match result reported `total: 43, more: false` on page 1, and the
 * old rule would have hidden "Load more" for pages 2 and 3.
 */
function classifyEnvelope(
  reportedTotal: number | undefined,
  more: JsonValue | undefined,
  offset: number,
  returned: number,
): { readonly hasMore: HasMore; readonly total: TotalMatches } {
  if (reportedTotal === undefined) {
    return {
      hasMore: typeof more === 'boolean' ? more : 'unknown',
      total: { accuracy: 'unknown' },
    };
  }
  if (more === true) {
    return { hasMore: true, total: { accuracy: 'atLeast', value: reportedTotal } };
  }
  if (more === false) {
    return {
      hasMore: offset + returned < reportedTotal,
      total: { accuracy: 'exact', value: reportedTotal },
    };
  }
  return { hasMore: 'unknown', total: { accuracy: 'atLeast', value: reportedTotal } };
}

export interface ReadQueryEnvelopeInput {
  readonly body: JsonObject;
  readonly offset: number;
}

/**
 * Reads a QueryBuilder body into a {@link QueryEnvelope}, or names why it is
 * not usable.
 *
 * This module exists because QueryBuilder does not use HTTP to report query
 * failures: a rejected predicate comes back as HTTP 200 with well-formed JSON
 * whose `success` field is `false` and whose `hits` array is absent or empty.
 * `success` is required to be the literal boolean `true`; a missing flag is
 * treated as a rejection, not an optimistic success.
 */
export function readQueryEnvelope(input: ReadQueryEnvelopeInput): QueryEnvelopeOutcome {
  const { body } = input;

  if (body['success'] !== true) {
    return { kind: 'query_rejected' };
  }

  const hits = body['hits'];
  if (!Array.isArray(hits)) {
    return { kind: 'malformed_envelope' };
  }

  const { hasMore, total } = classifyEnvelope(
    readNonNegativeInteger(body['total']),
    body['more'],
    input.offset,
    hits.length,
  );

  return { kind: 'ok', value: { hits, hasMore, total } };
}

/**
 * The honest count a **count** request returned: its integer `total`, or
 * `undefined` when the body does not prove one.
 *
 * A count is only trustworthy when the server accepted the query
 * (`success: true`), reported a whole number, and did not say the real count
 * exceeds it (`more !== true`). Anything else - a rejection, a malformed body,
 * a capped total - is `undefined`, so the caller keeps its fallback rather
 * than showing an unproved number.
 */
export function readCountTotal(body: JsonObject): number | undefined {
  if (body['success'] !== true) return undefined;
  if (body['more'] === true) return undefined;
  return readNonNegativeInteger(body['total']);
}
