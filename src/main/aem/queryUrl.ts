import { err, ok, type Result } from '../../shared/result';
import { parseOrigin } from '../../shared/contracts/origin';

/**
 * Builds the canonical same-origin QueryBuilder URL for an `aem_query` call
 * (implementation-plan.md step 08). This is the `aem_query` sibling of
 * `resourceUrl.ts`, and it holds the same line: the agent supplies predicates
 * and nothing else that can reach the wire as structure. It never accepts an
 * endpoint, a host, a scheme, a path, or a query string from tool arguments.
 *
 * The endpoint is a module constant rather than a parameter, and that is the
 * whole point. A default parameter would be equally correct on every call
 * site that exists today and would silently stop being correct the moment
 * some future caller threaded an argument through it. There is no code path
 * here - not even an internal one - by which `/bin/querybuilder.json` can be
 * something else.
 */

/** The only endpoint this module will ever address. Deliberately not a parameter. */
const QUERYBUILDER_ENDPOINT_PATH = '/bin/querybuilder.json';

/**
 * The output-control parameters the application owns outright
 * (implementation-plan.md step 08: "Reserve top-level output parameters
 * `p.limit`, `p.offset`, `p.hits`, `p.properties`, `p.nodedepth`,
 * `p.guessTotal`, and `p.facets` for the application").
 *
 * `queryPredicatesSchema` already rejects most of these as predicate keys, so
 * a predicate map that reached here should never collide with one. "Should
 * never" is why the collision check below exists anyway: the two lists are
 * maintained in different files for different reasons - that one is about
 * what an agent is allowed to *say*, this one is about what this module
 * actually *writes* - and the day they drift apart, a predicate silently
 * overriding `p.limit` is precisely the "silently changing the requested
 * operation" failure section 6 forbids. The check turns that drift into a
 * loud error instead of a paging bug nobody can see.
 */
const APPLICATION_OWNED_PARAMETERS = [
  'p.limit',
  'p.offset',
  'p.hits',
  'p.properties',
  'p.nodedepth',
  'p.guessTotal',
  'p.facets',
] as const;

/**
 * The compact identifying fields returned when the agent requests no
 * projection of its own (step 08: "Omitting a user projection means compact
 * identifying fields, not the entire subtree").
 *
 * `jcr:path` is what makes a row actionable - it is the argument of the
 * follow-up `aem_get_json` call - so it is always present, including when the
 * agent *does* supply a projection. Without it a hit can be counted but not
 * visited, which makes the search-then-read workflow impossible.
 */
const DEFAULT_PROJECTION = ['jcr:path', 'jcr:primaryType', 'jcr:title'] as const;

/** The row-identifying property forced into every projection. */
const PATH_PROPERTY = 'jcr:path';

export type BuildQueryUrlError =
  | { readonly kind: 'invalid_origin' }
  /**
   * A predicate key collided with one of {@link APPLICATION_OWNED_PARAMETERS}.
   * Reported rather than dropped or overwritten: the agent asked for something
   * the application will not do, and saying so is what lets it correct the
   * call instead of silently receiving a different page than it requested.
   */
  | { readonly kind: 'reserved_parameter'; readonly parameter: string }
  /** A predicate key or value could not be percent-encoded (a lone UTF-16 surrogate). */
  | { readonly kind: 'unencodable_predicate' }
  /**
   * The same "validate one string, request another" defence `resourceUrl.ts`
   * applies: after composing the URL it is re-parsed, and every part that was
   * meant to be fixed is checked against what `URL` actually reports back. If
   * the origin, the endpoint path, or any application-owned parameter is not
   * exactly what this module intended, the URL is refused rather than sent.
   */
  | { readonly kind: 'query_not_preserved' };

export interface BuildQueryUrlOptions {
  /** A previously-validated server origin (see `parseOrigin`), never a full page URL. */
  readonly origin: string;
  /** The agent-supplied predicate map, already validated by `queryPredicatesSchema`. */
  readonly predicates: Readonly<Record<string, string>>;
  /** Already defaulted and range-checked by `queryOffsetSchema`. */
  readonly offset: number;
  /** Already defaulted and range-checked by `queryLimitSchema` (1..200). */
  readonly limit: number;
  /** The agent's property projection, or `undefined` for {@link DEFAULT_PROJECTION}. */
  readonly properties?: readonly string[] | undefined;
}

export interface BuiltQueryUrl {
  readonly url: string;
  /**
   * The property list actually sent as `p.properties`, which is what the
   * result's `selection` must report. Returned rather than recomputed by the
   * projection step, so the two cannot disagree about what was requested.
   */
  readonly projectedProperties: readonly string[];
}

/**
 * Resolves the projection, always including {@link PATH_PROPERTY} exactly
 * once and preserving the agent's own ordering for everything else.
 */
function resolveProjection(requested: readonly string[] | undefined): readonly string[] {
  if (requested === undefined) {
    return [...DEFAULT_PROJECTION];
  }
  const resolved = [PATH_PROPERTY];
  for (const name of requested) {
    if (!resolved.includes(name)) {
      resolved.push(name);
    }
  }
  return resolved;
}

/**
 * Composes the QueryBuilder request URL.
 *
 * Serialization goes through `URLSearchParams` rather than string
 * concatenation (step 08: "Serialize URLs through standard APIs. Duplicate/
 * invalid parameters must not change the HTTP target"). That matters for more
 * than encoding: a predicate value containing `&`, `=`, `#`, or a newline is
 * escaped by the standard serializer, so it cannot introduce a second
 * parameter, terminate the query, or start a fragment. A hand-rolled join
 * would have to get every one of those right, forever.
 *
 * The reserved parameters are appended *after* the predicates, so even in the
 * impossible case where a colliding predicate slipped past both the schema
 * and the explicit check below, the application's value would be the one
 * QueryBuilder reads last. That is a backstop, not the mechanism - the
 * mechanism is the outright rejection above it.
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

  const projectedProperties = resolveProjection(options.properties);

  const params = new URLSearchParams();
  try {
    for (const [key, value] of Object.entries(options.predicates)) {
      // Ordinary scoped predicates - `group.p.or`, `1_group.p.or`,
      // `group.1_property`, `daterange.lowerBound` - are just keys here.
      // Nothing in this loop inspects a key's shape, so dotted and numeric
      // group syntax round-trips unchanged by construction rather than by a
      // rule that could fail to anticipate a spelling.
      params.append(key, value);
    }
    params.append('p.offset', String(options.offset));
    params.append('p.limit', String(options.limit));
    // `selective` + an explicit property list is what keeps a hit compact.
    // `full` would dump each matched node, and combined with `p.nodedepth`
    // that is exactly the "uncontrolled recursive node output" step 08 bans.
    params.append('p.hits', 'selective');
    // QueryBuilder's `p.properties` is a space-separated list, not a repeated
    // parameter and not comma-separated. `URLSearchParams` encodes the spaces.
    params.append('p.properties', projectedProperties.join(' '));
    // Pinned to 0 explicitly rather than left to QueryBuilder's default, for
    // the same reason `resourceUrl.ts` always writes its depth selector: the
    // request states its own non-recursive intent instead of depending on a
    // server-side default this application does not control.
    params.append('p.nodedepth', '0');
    params.append('p.guessTotal', 'true');
    // Explicitly off. Facets make QueryBuilder walk the whole result set to
    // build buckets nothing in this application consumes.
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

  // Re-read the application-owned parameters back off the parsed URL and
  // require each to appear exactly once with exactly the intended value. This
  // is what actually proves "duplicate/invalid parameters must not change the
  // HTTP target": a predicate that managed to contribute a second `p.limit`
  // would show up here as two values and be refused, whatever route it took.
  const parsed = url.searchParams;
  const expected: ReadonlyArray<readonly [string, string]> = [
    ['p.offset', String(options.offset)],
    ['p.limit', String(options.limit)],
    ['p.hits', 'selective'],
    ['p.properties', projectedProperties.join(' ')],
    ['p.nodedepth', '0'],
    ['p.guessTotal', 'true'],
    ['p.facets', 'false'],
  ];
  for (const [name, value] of expected) {
    const values = parsed.getAll(name);
    if (values.length !== 1 || values[0] !== value) {
      return err({ kind: 'query_not_preserved' });
    }
  }

  return ok({ url: url.toString(), projectedProperties });
}
