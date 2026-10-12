import { z } from 'zod';
import {
  type AemResponseOutcome,
  type AemToolExecutor,
  type BrokerOutcome,
  type CurrentAemToolContext,
  type HasMore,
  type IdGenerator,
  type JsonObject,
  type JsonValue,
  type PrioritySegment,
  type PropertySelection,
  type RequestId,
  type RequiredAction,
  type Result,
  type ToolDescriptor,
  type ToolErrorCode,
  type ToolOutcome,
  brokerErrorKey,
  classifyAemResponse,
  createToolExecutor,
  effectiveRoots,
  envelopeCommonShape,
  err,
  hasMoreSchema,
  jcrPathSchema,
  jsonValueSchema,
  ok,
  originSchema,
  parseOrigin,
  planPrioritySegments,
  propertiesSelectionSchema,
  propertySelectionSchema,
  renderHasMore,
  renderSelection,
  requestIdSchema,
} from '../../shared';

/**
 * The `aem_query` tool, self-contained.
 *
 * Mirrors `./aemGetJson.ts`'s shape: argument schema and predicates validation,
 * model descriptor, success result and model rendering, URL building, the
 * QueryBuilder `success:false` reading that only this tool needs, the error
 * wording, and the executor - all in this file. Shared, tool-agnostic pieces
 * come from their own modules; the transport is injected.
 *
 * The endpoint is a module constant, never a parameter: there is no code path
 * by which `/bin/querybuilder.json` can be something else, and no predicate can
 * reach the wire as structure the agent chose.
 */

// ---------------------------------------------------------------------------
// Predicates validation
// ---------------------------------------------------------------------------

export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 200;
export const MIN_QUERY_LIMIT = 1;

/**
 * The most roots one fan-out call may expand to. Each root is a separate AEM
 * request through the concurrency-1 bridge, so this bounds a single tool call's
 * cost; a host with more roots is simply scoped by the first ones, and the
 * effective roots are reported back.
 */
export const MAX_QUERY_ROOTS = 8;

/**
 * `p.limit=-1` (unbounded) must be impossible to express - `min(1)` alone
 * already makes that true, but rejecting is the point: a request for -1 fails
 * validation outright rather than being clamped to some in-range number the
 * agent never asked for.
 */
export const queryLimitSchema = z
  .number()
  .int('limit must be an integer')
  .min(MIN_QUERY_LIMIT, `limit must be at least ${String(MIN_QUERY_LIMIT)}`)
  .max(MAX_QUERY_LIMIT, `limit must be at most ${String(MAX_QUERY_LIMIT)}`)
  .default(DEFAULT_QUERY_LIMIT);

export const queryOffsetSchema = z
  .number()
  .int('offset must be an integer')
  .nonnegative('offset must not be negative')
  .default(0);

const PREDICATE_KEY_MAX_LENGTH = 200;
const PREDICATE_VALUE_MAX_LENGTH = 2000;

/**
 * QueryBuilder's own output-control parameters (section 6: "Disallow
 * `p.limit=-1` ... and uncontrolled recursive node output"). Unprefixed,
 * top-level keys only - `group.p.or`, `1_group.p.or`, and `group.1_property`
 * name ordinary scoped predicates and are unaffected.
 */
const RESERVED_QUERYBUILDER_OUTPUT_KEYS = [
  'p.limit',
  'p.offset',
  'p.guessTotal',
  'p.hits',
  'p.nodedepth',
  'p.excerpt',
  'p.facets',
] as const;

const UNSAFE_PREDICATE_KEYS = ['constructor', 'prototype'] as const;

/**
 * `__proto__` is not an ordinary key: assigned via the object-literal path it
 * sets the prototype instead of creating an own property, and even when it
 * exists as a real own-enumerable property (as `JSON.parse` produces), plain
 * object reconstruction - including zod's own `record` output - silently drops
 * it. That silent drop is exactly the "silently changing the requested
 * operation" section 6 forbids, so it needs its own explicit check against the
 * raw candidate before any reconstruction can eat it.
 */
const PROTO_POLLUTION_KEY = '__proto__';

const predicateKeySchema = z
  .string()
  .min(1)
  .max(PREDICATE_KEY_MAX_LENGTH)
  .superRefine((key, ctx) => {
    if (
      RESERVED_QUERYBUILDER_OUTPUT_KEYS.includes(
        key as (typeof RESERVED_QUERYBUILDER_OUTPUT_KEYS)[number],
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          `'${key}' is a QueryBuilder output-control parameter, not a search predicate; ` +
          "use the dedicated 'limit'/'offset'/'properties' fields instead",
      });
      return;
    }
    if (UNSAFE_PREDICATE_KEYS.includes(key as (typeof UNSAFE_PREDICATE_KEYS)[number])) {
      ctx.addIssue({ code: 'custom', message: `'${key}' is not a valid predicate key` });
    }
  });
const predicateValueSchema = z.string().max(PREDICATE_VALUE_MAX_LENGTH);

/**
 * Deliberately not restricted to a predicate-name allowlist (section 6: "Do not
 * restrict QueryBuilder predicates to a predefined list"). What *is* rejected -
 * reserved output-control keys and prototype-pollution keys - is rejected here,
 * in the one validator the handler and transport boundary both use.
 *
 * Wrapped in `z.preprocess` rather than a `superRefine` on the record itself:
 * by the time a refinement on `z.record(...)` runs, the record's own base
 * parsing has already constructed its output object by assignment, which
 * silently drops a `__proto__` key before any refinement could see it.
 */
export const queryPredicatesSchema = z.preprocess(
  (raw, ctx) => {
    if (
      raw !== null &&
      typeof raw === 'object' &&
      Object.prototype.hasOwnProperty.call(raw, PROTO_POLLUTION_KEY)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `'${PROTO_POLLUTION_KEY}' is not a valid predicate key`,
      });
      return z.NEVER;
    }
    return raw;
  },
  z.record(predicateKeySchema, predicateValueSchema),
);

// ---------------------------------------------------------------------------
// Arguments, descriptor, request envelope
// ---------------------------------------------------------------------------

export const aemQueryArgsSchema = z
  .object({
    predicates: queryPredicatesSchema,
    offset: queryOffsetSchema,
    limit: queryLimitSchema,
    properties: propertiesSelectionSchema.optional(),
    /**
     * Optional explicit roots to fan a single query out across, one query per
     * root, with the results merged. The model reads the current host's roots
     * from the current-page context block and passes them here; nested or
     * duplicate roots are collapsed, and a `path` predicate may not be combined
     * with `roots` (they would disagree about the scope).
     */
    roots: z.array(jcrPathSchema).min(1).max(MAX_QUERY_ROOTS).optional(),
  })
  .strict();

export type AemQueryArgs = z.infer<typeof aemQueryArgsSchema>;

export const AEM_QUERY_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: 'aem_query',
  description:
    'Runs an AEM QueryBuilder search from an arbitrary map of QueryBuilder ' +
    'predicate keys and values in `predicates`, including customer-installed ' +
    'predicates - there is no fixed predicate list. Results are paginated: ' +
    `\`limit\` defaults to ${String(DEFAULT_QUERY_LIMIT)} and may be at most ` +
    `${String(MAX_QUERY_LIMIT)} per call; \`offset\` defaults to 0. Fetch further ` +
    'results with additional calls at a higher `offset`, never by requesting a ' +
    "larger `limit`. Do not put QueryBuilder's own output-control parameters " +
    '(`p.limit`, `p.offset`, `p.guessTotal`, `p.hits`, `p.nodedepth`, `p.excerpt`, ' +
    '`p.facets`) in `predicates` - they are rejected; use the dedicated `limit`/' +
    '`offset`/`properties` fields instead. Every value in `predicates` must be a ' +
    'string: `limit` and `offset` are top-level siblings of `predicates`, never ' +
    'keys inside it. `properties` optionally restricts which ' +
    'result fields are returned. Alternatively, pass `roots` (a list of JCR paths - ' +
    "typically this host's content roots from the current-page context block) to run the same " +
    'query once per root and merge the rows; `limit` and `offset` then apply to each root, and ' +
    'the effective roots are reported back. Do not combine `roots` with a `path` predicate. ' +
    'When the host configures priority paths and the search scope contains them, the ' +
    'application returns rows from those paths first, in the configured order, then the rest ' +
    'of the scope; `offset` and `limit` then address the whole ordered result as one list ' +
    '(also across several `roots`). ' +
    'This tool returns data only and renders no table: to show search results to the user, ' +
    "call 'aem_query_format_ask' with the same `predicates` instead.",
  parameters: z.toJSONSchema(aemQueryArgsSchema, { io: 'input' }),
};

/** The key `sdkAgentService.ts`'s `toolHandlers` registers this executor under. */
export const AEM_QUERY_TOOL_NAME: string = AEM_QUERY_TOOL_DESCRIPTOR.name;

/** The `aem_query` counterpart of `AEM_GET_JSON_ALLOWLIST_ENTRY`. */
export const AEM_QUERY_ALLOWLIST_ENTRY = 'custom:aem_query';

export const aemQueryRequestSchema = z
  .object({
    operation: z.literal('aem_query'),
    ...envelopeCommonShape,
    args: aemQueryArgsSchema,
  })
  .strict();

export type AemQueryRequest = z.infer<typeof aemQueryRequestSchema>;

// ---------------------------------------------------------------------------
// Success result and model rendering
// ---------------------------------------------------------------------------

/**
 * The total number of matches, together with how much that number can be
 * trusted. Modelled as a discriminated union rather than a `total: number`
 * beside a separate `totalIsEstimate: boolean`, because those two fields can
 * disagree. `"estimated"` is the normal case: the application always sends
 * `p.guessTotal=true`, so QueryBuilder is explicitly permitted to stop counting
 * early.
 */
export const totalMatchesSchema = z.discriminatedUnion('accuracy', [
  z.object({ accuracy: z.literal('exact'), value: z.number().int().nonnegative() }).strict(),
  z.object({ accuracy: z.literal('estimated'), value: z.number().int().nonnegative() }).strict(),
  z.object({ accuracy: z.literal('unknown') }).strict(),
]);

export type TotalMatches = z.infer<typeof totalMatchesSchema>;

export const paginationMetadataSchema = z
  .object({
    offset: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(200),
    returned: z.number().int().nonnegative(),
    hasMore: hasMoreSchema,
    total: totalMatchesSchema,
  })
  .strict();

export type PaginationMetadata = z.infer<typeof paginationMetadataSchema>;

export const aemQuerySuccessSchema = z
  .object({
    ok: z.literal(true),
    operation: z.literal('aem_query'),
    requestId: requestIdSchema,
    sourceOrigin: originSchema,
    serverRevision: z.number().int().nonnegative(),
    predicates: z.record(z.string(), z.string()),
    /**
     * Present only for a root fan-out: the effective roots actually queried,
     * in order, with nested/duplicate roots collapsed. Omitted for a single
     * query, which is always bracketed by its own `path` predicate.
     */
    roots: z.array(z.string()).optional(),
    /**
     * Present only when the host's priority paths ordered this result: the
     * priority paths that applied to the scope, in the order they were read
     * (everything else follows them). Omitted when no priority applied.
     */
    priorityPaths: z.array(z.string()).optional(),
    fetchedAt: z.number().int().nonnegative(),
    rows: z.array(jsonValueSchema),
    selection: propertySelectionSchema,
    pagination: paginationMetadataSchema,
  })
  .strict();

export type AemQuerySuccess = z.infer<typeof aemQuerySuccessSchema>;

/** What `executeAemQuery` resolves: this tool's success shape, or the shared error arm. */
export type AemQueryResult = ToolOutcome<AemQuerySuccess>;

/**
 * Renders the total alongside its accuracy in the same breath, never the bare
 * number. A model told "42 matches" after being handed 50 rows will report that
 * as a complete count; told "approximately 42", it has what it needs to qualify
 * the answer.
 */
function renderTotal(total: TotalMatches): string {
  switch (total.accuracy) {
    case 'exact':
      return `${String(total.value)} match(es) in total`;
    case 'estimated':
      return `approximately ${String(total.value)} match(es) in total (estimated, not an exact count)`;
    case 'unknown':
      return 'the total number of matches is unknown';
  }
}

export function renderQuerySuccess(result: AemQuerySuccess): string {
  const { pagination } = result;
  const prioritized = result.priorityPaths !== undefined && result.priorityPaths.length > 0;
  const lines = [
    `AEM query against ${result.sourceOrigin} (revision ${String(result.serverRevision)}, ` +
      `fetched at ${String(result.fetchedAt)})`,
    `Returned ${String(pagination.returned)} row(s) at offset ${String(pagination.offset)} ` +
      `with limit ${String(pagination.limit)}${
        result.roots !== undefined && !prioritized ? ' per root' : ''
      }; ` +
      `${renderHasMore(pagination.hasMore)}; ${renderTotal(pagination.total)}`,
  ];
  if (result.roots !== undefined && result.roots.length > 0) {
    lines.push(
      prioritized
        ? `Scoped to roots: ${result.roots.join(', ')} (read root by root)`
        : `Scoped to roots: ${result.roots.join(', ')} (one query per root, merged)`,
    );
  }
  if (result.priorityPaths !== undefined && prioritized) {
    lines.push(
      `Ordered by priority paths: ${result.priorityPaths.join(', ')}, then the rest of the scope`,
    );
  }
  lines.push(
    `Selection: ${renderSelection(result.selection)}`,
    `Rows: ${JSON.stringify(result.rows)}`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// QueryBuilder request URL
// ---------------------------------------------------------------------------

const QUERYBUILDER_ENDPOINT_PATH = '/bin/querybuilder.json';

const APPLICATION_OWNED_PARAMETERS = [
  'p.limit',
  'p.offset',
  'p.hits',
  'p.properties',
  'p.nodedepth',
  'p.guessTotal',
  'p.facets',
] as const;

const DEFAULT_PROJECTION = ['jcr:path', 'jcr:primaryType', 'jcr:title'] as const;
const PATH_PROPERTY = 'jcr:path';

export type BuildQueryUrlError =
  | { readonly kind: 'invalid_origin' }
  | { readonly kind: 'reserved_parameter'; readonly parameter: string }
  | { readonly kind: 'unencodable_predicate' }
  | { readonly kind: 'query_not_preserved' };

export interface BuildQueryUrlOptions {
  readonly origin: string;
  readonly predicates: Readonly<Record<string, string>>;
  readonly offset: number;
  readonly limit: number;
  readonly properties?: readonly string[] | undefined;
}

export interface BuiltQueryUrl {
  readonly url: string;
  readonly projectedProperties: readonly string[];
}

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
 * Composes the QueryBuilder request URL. Serialization goes through
 * `URLSearchParams` rather than string concatenation, so a predicate value
 * containing `&`, `=`, `#`, or a newline cannot introduce a parameter,
 * terminate the query, or start a fragment. The composed URL is re-parsed and
 * every application-owned parameter required to appear exactly once with
 * exactly the intended value.
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
      // Nothing inspects a key's shape, so dotted and numeric group syntax
      // round-trips unchanged by construction.
      params.append(key, value);
    }
    params.append('p.offset', String(options.offset));
    params.append('p.limit', String(options.limit));
    params.append('p.hits', 'selective');
    params.append('p.properties', projectedProperties.join(' '));
    params.append('p.nodedepth', '0');
    params.append('p.guessTotal', 'true');
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

// ---------------------------------------------------------------------------
// QueryBuilder response envelope
// ---------------------------------------------------------------------------

export type QueryEnvelopeOutcome =
  | { readonly kind: 'ok'; readonly value: QueryEnvelope }
  | { readonly kind: 'query_rejected' }
  | { readonly kind: 'malformed_envelope' };

export interface QueryEnvelope {
  readonly hits: readonly JsonValue[];
  /** `"unknown"` when QueryBuilder sent no `more` flag - never defaulted to `false`. */
  readonly hasMore: HasMore;
  readonly total: TotalMatches;
}

function readNonNegativeInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Decides how much the reported total can be trusted. The single provable
 * exception to `"estimated"`: when the server says there are no further results
 * (`more: false`) and the rows on this page account for the whole reported
 * total, the count has been enumerated end to end.
 */
function classifyTotal(
  reportedTotal: number | undefined,
  hasMore: HasMore,
  offset: number,
  returned: number,
): TotalMatches {
  if (reportedTotal === undefined) {
    return { accuracy: 'unknown' };
  }
  if (hasMore === false && offset + returned === reportedTotal) {
    return { accuracy: 'exact', value: reportedTotal };
  }
  return { accuracy: 'estimated', value: reportedTotal };
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

  const more = body['more'];
  const hasMore: HasMore = typeof more === 'boolean' ? more : 'unknown';
  const total = classifyTotal(
    readNonNegativeInteger(body['total']),
    hasMore,
    input.offset,
    hits.length,
  );

  return { kind: 'ok', value: { hits, hasMore, total } };
}

// ---------------------------------------------------------------------------
// Success projection
// ---------------------------------------------------------------------------

export interface ProjectQueryResultInput {
  readonly envelope: QueryEnvelope;
  readonly args: AemQueryArgs;
  readonly projectedProperties: readonly string[];
  readonly requestId: RequestId;
  readonly sourceOrigin: string;
  readonly serverRevision: number;
  readonly fetchedAt: number;
  /** The effective roots actually queried, for a root fan-out; omitted otherwise. */
  readonly roots?: readonly string[] | undefined;
  /** The priority paths that ordered the result, in read order; omitted otherwise. */
  readonly priorityPaths?: readonly string[] | undefined;
}

/**
 * Projects a validated QueryBuilder envelope into the `aem_query` success
 * result. Rows pass through as QueryBuilder returned them: the projection was
 * already applied at the request by `p.hits=selective` + `p.properties`, so
 * re-filtering would be a second, divergent definition of the same selection.
 */
export function projectQueryResult(input: ProjectQueryResultInput): AemQuerySuccess {
  const rows = [...input.envelope.hits];

  // Always `"selected"`, never `"all"`: this tool cannot return every property
  // of a hit, because the request pinned `p.hits=selective` and `p.nodedepth=0`.
  const selection: PropertySelection = {
    kind: 'selected',
    properties: [...input.projectedProperties],
  };

  const pagination: PaginationMetadata = {
    offset: input.args.offset,
    limit: input.args.limit,
    returned: rows.length,
    hasMore: input.envelope.hasMore,
    total: input.envelope.total,
  };

  return {
    ok: true,
    operation: 'aem_query',
    requestId: input.requestId,
    sourceOrigin: input.sourceOrigin,
    serverRevision: input.serverRevision,
    predicates: { ...input.args.predicates },
    ...(input.roots !== undefined ? { roots: [...input.roots] } : {}),
    ...(input.priorityPaths !== undefined ? { priorityPaths: [...input.priorityPaths] } : {}),
    fetchedAt: input.fetchedAt,
    rows,
    selection,
    pagination,
  };
}

// ---------------------------------------------------------------------------
// Handler: error taxonomy and HTTP -> result
// ---------------------------------------------------------------------------

const ERROR_MESSAGES = {
  invalid_origin: 'The current server address could not be used to build a request',
  reserved_parameter: 'A QueryBuilder output-control parameter was supplied as a search predicate',
  unencodable_predicate: 'A predicate contains characters that cannot be encoded in a URL',
  query_not_preserved: 'The query URL could not be built safely for those predicates',
  cross_origin: 'The request was refused because it would have left the current server',
  redirect_blocked:
    'AEM redirected the request away from the server, which usually means the session has expired',
  redirected:
    'AEM redirected the request away from the server, which usually means the session has expired',
  no_view: 'The AEM browser pane is not available, so no request could be made',
  bridge_unavailable:
    'The AEM browser pane is present but its request bridge is not available, so no request ' +
    'could be made. This is an application problem, not an AEM one',
  network_error: 'The request to AEM could not be completed',
  cancelled: 'The request was cancelled',
  timeout: 'AEM did not respond before the request deadline',
  stale_server_revision: 'The server configuration changed while the request was in flight',
  stale_navigation_epoch: 'The browser left the page this request was made for',
  unauthorized: 'AEM did not accept the current session. Sign in again in the browser pane',
  forbidden: 'The current AEM account is not permitted to run that query',
  not_found: 'AEM reports that the QueryBuilder endpoint does not exist on this instance',
  bad_request: 'AEM rejected the query as malformed',
  multiple_choices: 'AEM refused to return that result because it has too many nodes to traverse',
  url_too_long:
    'The query URL was too long for AEM to accept. Send fewer or shorter predicates; ' +
    'the query cannot be retried by another method',
  server_error: 'AEM returned a server error',
  unexpected_status: 'AEM returned an unexpected status for that query',
  not_json_content_type: 'AEM returned a response that was not JSON',
  html_login_page: 'AEM returned a sign-in page instead of data. Sign in again in the browser pane',
  html_error_page:
    'AEM returned an HTML page instead of query results. Check that the browser pane is still ' +
    'signed in, then narrow the query',
  empty_response:
    'AEM returned an empty response instead of query results - it most likely stopped the query ' +
    'because it would traverse too many nodes. Add an indexable predicate such as "type" or ' +
    '"fulltext", or narrow the path/roots',
  invalid_json: 'AEM returned a response that could not be parsed as JSON',
  unexpected_json_shape: 'AEM returned JSON that was not a QueryBuilder result object',
  /**
   * The message this tool exists for. It says the query was *rejected*, never
   * that it matched nothing - an agent told "no results" stops looking, while
   * an agent told the server refused the query fixes the predicate.
   */
  query_rejected:
    'AEM rejected the query. One of the predicates was not accepted by this instance - ' +
    'check the predicate names and values. This is not an empty result',
  malformed_envelope: 'AEM returned a QueryBuilder response without a usable result set',
  roots_and_path_conflict:
    "A query cannot combine 'roots' with a 'path' predicate - use one or the other",
  roots_not_usable: "'roots' named no usable JCR path",
} as const;

type ErrorMessageKey = keyof typeof ERROR_MESSAGES;

interface ErrorMapping {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly requiredAction: RequiredAction;
}

const ERROR_MAPPINGS: Readonly<Record<ErrorMessageKey, ErrorMapping>> = {
  invalid_origin: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'select_server' },
  reserved_parameter: { code: 'INVALID_ARGUMENT', retryable: false, requiredAction: 'none' },
  unencodable_predicate: { code: 'INVALID_ARGUMENT', retryable: false, requiredAction: 'none' },
  query_not_preserved: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'none' },
  cross_origin: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'none' },
  redirect_blocked: {
    code: 'REDIRECT_BLOCKED',
    retryable: false,
    requiredAction: 'sign_in_to_aem',
  },
  redirected: { code: 'REDIRECT_BLOCKED', retryable: false, requiredAction: 'sign_in_to_aem' },
  no_view: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'select_server' },
  bridge_unavailable: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'none' },
  network_error: { code: 'NETWORK_ERROR', retryable: true, requiredAction: 'none' },
  cancelled: { code: 'CANCELLED', retryable: true, requiredAction: 'none' },
  timeout: { code: 'TIMEOUT', retryable: true, requiredAction: 'none' },
  stale_server_revision: { code: 'STALE_CONTEXT', retryable: true, requiredAction: 'none' },
  stale_navigation_epoch: { code: 'STALE_CONTEXT', retryable: true, requiredAction: 'none' },
  unauthorized: { code: 'AUTH_REQUIRED', retryable: false, requiredAction: 'sign_in_to_aem' },
  forbidden: { code: 'NOT_AUTHORIZED', retryable: false, requiredAction: 'none' },
  not_found: { code: 'NOT_FOUND', retryable: false, requiredAction: 'none' },
  bad_request: { code: 'INVALID_ARGUMENT', retryable: false, requiredAction: 'none' },
  multiple_choices: {
    code: 'RESULT_TOO_LARGE_FOR_MODEL',
    retryable: false,
    requiredAction: 'reduce_result_size',
  },
  // Not retryable, and no user action: only a smaller query can succeed.
  // Retrying unchanged - or reaching for POST - is precisely what step 08
  // forbids, so nothing here suggests either.
  url_too_long: { code: 'INVALID_ARGUMENT', retryable: false, requiredAction: 'none' },
  server_error: { code: 'UNEXPECTED_RESPONSE', retryable: true, requiredAction: 'none' },
  unexpected_status: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  not_json_content_type: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  html_login_page: { code: 'AUTH_REQUIRED', retryable: false, requiredAction: 'sign_in_to_aem' },
  html_error_page: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  empty_response: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  invalid_json: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  unexpected_json_shape: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  // A server-side rejection, per step 08. Not retryable: the identical query
  // will be rejected identically until the agent changes a predicate.
  query_rejected: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  malformed_envelope: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  roots_and_path_conflict: {
    code: 'INVALID_ARGUMENT',
    retryable: false,
    requiredAction: 'none',
  },
  roots_not_usable: { code: 'INVALID_ARGUMENT', retryable: false, requiredAction: 'none' },
};

function toolError(key: ErrorMessageKey, requestId: RequestId): AemQueryResult {
  const mapping = ERROR_MAPPINGS[key];
  return {
    ok: false,
    error: {
      code: mapping.code,
      message: ERROR_MESSAGES[key],
      requestId,
      retryable: mapping.retryable,
      requiredAction: mapping.requiredAction,
    },
  };
}

export interface AemQueryDeps {
  readonly origin: string;
  readonly fetchThroughBridge: (url: string) => Promise<BrokerOutcome>;
  readonly now: () => number;
  /**
   * Optional diagnostics sink, called once per HTTP response with the
   * classification this tool reached (see `ToolHost.recordResponseClassification`).
   * Never affects the result.
   */
  readonly onClassified?: (requestId: RequestId, kind: AemResponseOutcome['kind']) => void;
  /**
   * The host's content priority paths, in written order, read by the executor
   * from the application's environment facts when the tool runs. Never taken
   * from the model. When one applies to the query scope the result is read in
   * priority order (see {@link executePrioritizedQuery}).
   */
  readonly priorityPaths?: readonly string[] | undefined;
}

interface SingleQueryOutcome {
  readonly envelope: QueryEnvelope;
  readonly projectedProperties: readonly string[];
}

type SingleQueryResult =
  | { readonly ok: true; readonly value: SingleQueryOutcome }
  | { readonly ok: false; readonly key: ErrorMessageKey };

/**
 * One QueryBuilder round trip for one set of predicates. Shared by the plain
 * query and each root of a fan-out, so the two paths cannot interpret a
 * response differently. A rejected query, a malformed envelope, a bad HTTP
 * status and every bridge outcome all collapse to an `ErrorMessageKey`, mapped
 * to a `ToolError` by the caller.
 */
async function runSingleQuery(
  deps: AemQueryDeps,
  requestId: RequestId,
  predicates: Readonly<Record<string, string>>,
  offset: number,
  limit: number,
  properties: readonly string[] | undefined,
): Promise<SingleQueryResult> {
  const built = buildQueryUrl({ origin: deps.origin, predicates, offset, limit, properties });
  if (!built.ok) return { ok: false, key: built.error.kind };

  const brokerOutcome = await deps.fetchThroughBridge(built.value.url);
  if (brokerOutcome.kind !== 'response') {
    return { ok: false, key: brokerErrorKey(brokerOutcome) };
  }

  const classified = classifyAemResponse({
    status: brokerOutcome.status,
    contentType: brokerOutcome.contentType,
    bodyText: brokerOutcome.bodyText,
  });
  deps.onClassified?.(requestId, classified.kind);
  if (classified.kind !== 'ok') return { ok: false, key: classified.kind };

  // The stage `aem_get_json` has no equivalent of: only this call can tell a
  // rejected query from an empty one (QueryBuilder reports rejection as 200).
  const envelopeOutcome = readQueryEnvelope({ body: classified.value, offset });
  if (envelopeOutcome.kind !== 'ok') return { ok: false, key: envelopeOutcome.kind };

  return {
    ok: true,
    value: {
      envelope: envelopeOutcome.value,
      projectedProperties: built.value.projectedProperties,
    },
  };
}

function readHitPath(hit: JsonValue): string | undefined {
  if (typeof hit !== 'object' || hit === null || Array.isArray(hit)) return undefined;
  const path = (hit as Readonly<Record<string, JsonValue>>)[PATH_PROPERTY];
  return typeof path === 'string' ? path : undefined;
}

/** `true` when any root has more; `unknown` only when none says `true` but one says `unknown`. */
function mergeHasMore(values: readonly HasMore[]): HasMore {
  if (values.some((value) => value === true)) return true;
  if (values.some((value) => value === 'unknown')) return 'unknown';
  return false;
}

/**
 * Sums per-root totals. Only exact when every root enumerated its results, so a
 * fan-out never upgrades an estimate to a fact. Safe to sum because the roots
 * handed here are already non-interleaving (see `effectiveRoots`), so no node is
 * counted twice.
 */
function mergeTotals(values: readonly TotalMatches[]): TotalMatches {
  let sum = 0;
  let anyKnown = false;
  let allExact = true;
  for (const total of values) {
    if (total.accuracy === 'unknown') {
      allExact = false;
      continue;
    }
    sum += total.value;
    anyKnown = true;
    if (total.accuracy !== 'exact') allExact = false;
  }
  if (!anyKnown) return { accuracy: 'unknown' };
  return allExact ? { accuracy: 'exact', value: sum } : { accuracy: 'estimated', value: sum };
}

/**
 * Merges one envelope per root into a single envelope: rows are concatenated in
 * root order, with a second copy of the same `jcr:path` dropped defensively
 * (the roots are already non-interleaving, so in practice each path appears
 * once). `limit`/`offset` remain per-root - they were applied to each query.
 */
function mergeQueryEnvelopes(envelopes: readonly QueryEnvelope[]): QueryEnvelope {
  const hits: JsonValue[] = [];
  const seenPaths = new Set<string>();
  for (const envelope of envelopes) {
    for (const hit of envelope.hits) {
      const path = readHitPath(hit);
      if (path !== undefined) {
        if (seenPaths.has(path)) continue;
        seenPaths.add(path);
      }
      hits.push(hit);
    }
  }
  return {
    hits,
    hasMore: mergeHasMore(envelopes.map((envelope) => envelope.hasMore)),
    total: mergeTotals(envelopes.map((envelope) => envelope.total)),
  };
}

/**
 * The roots a priority ordering would apply to, or `undefined` when the query
 * is not scoped in a way the application can reorder: the explicit `roots`
 * (already collapsed), or a plain `path` predicate. A `path` carrying
 * `path.flat`/`path.exact`/`path.self` sub-keys is left alone.
 */
function resolvePriorityScope(
  args: AemQueryArgs,
  roots: readonly string[] | undefined,
): readonly string[] | undefined {
  if (roots !== undefined) return roots;
  const path = args.predicates['path'];
  if (path === undefined) return undefined;
  if (Object.keys(args.predicates).some((key) => key.startsWith('path.'))) return undefined;
  const scope = effectiveRoots([path]);
  return scope.length > 0 ? scope : undefined;
}

/**
 * The smallest `N_group` name the model's own predicates do not already use, so
 * the application's exclusion group can never merge with, or overwrite, one of
 * the model's.
 */
function pickExclusionGroupName(predicates: Readonly<Record<string, string>>): string {
  const keys = Object.keys(predicates);
  for (let index = 1; ; index += 1) {
    const name = `${String(index)}_group`;
    if (!keys.some((key) => key === name || key.startsWith(`${name}.`))) return name;
  }
}

/** The model's predicates narrowed to one segment: its path, minus the excluded paths. */
function segmentPredicates(
  predicates: Readonly<Record<string, string>>,
  segment: PrioritySegment,
  groupName: string,
): Record<string, string> {
  const scoped: Record<string, string> = { ...predicates, path: segment.path };
  if (segment.exclude.length === 0) return scoped;
  scoped[`${groupName}.p.not`] = 'true';
  scoped[`${groupName}.p.or`] = 'true';
  segment.exclude.forEach((path, index) => {
    scoped[`${groupName}.${String(index + 1)}_path`] = path;
  });
  return scoped;
}

/**
 * Reads one page - `[offset, offset + limit)` of the *whole ordered result* -
 * out of disjoint segments, so the caller keeps paging with `offset += limit`
 * and never sees where one segment ends and the next begins. The mapping is
 * stateless: each call re-walks the segments in order, querying a segment at
 * the offset still to be skipped and for the rows still needed. A segment that
 * returns fewer rows than asked with `more === false` is exhausted; its size
 * is subtracted from the offset and the walk moves on. Once the page is full
 * every remaining segment gets a one-row probe, only to learn whether anything
 * follows and how many rows there are.
 *
 * When the end of a segment cannot be established the walk stops and reports
 * `hasMore: 'unknown'` - an offset is never guessed.
 */
async function executePrioritizedQuery(
  envelope: AemQueryRequest,
  deps: AemQueryDeps,
  segments: readonly PrioritySegment[],
  priorityPaths: readonly string[],
  roots: readonly string[] | undefined,
): Promise<AemQueryResult> {
  const { args, requestId } = envelope;
  const groupName = pickExclusionGroupName(args.predicates);

  const hits: JsonValue[] = [];
  const totals: TotalMatches[] = [];
  const hasMores: HasMore[] = [];
  let projectedProperties: readonly string[] = DEFAULT_PROJECTION;
  let remainingOffset = args.offset;
  let need = args.limit;

  const respond = (page: QueryEnvelope): AemQueryResult =>
    projectQueryResult({
      envelope: page,
      args,
      projectedProperties,
      requestId,
      sourceOrigin: deps.origin,
      serverRevision: envelope.serverRevision,
      fetchedAt: deps.now(),
      ...(roots !== undefined ? { roots } : {}),
      priorityPaths,
    });

  for (const segment of segments) {
    const predicates = segmentPredicates(args.predicates, segment, groupName);

    if (need === 0) {
      const probe = await runSingleQuery(deps, requestId, predicates, 0, 1, args.properties);
      if (!probe.ok) return toolError(probe.key, requestId);
      const found = probe.value.envelope;
      if (found.hits.length > 0) {
        // The probe's own total is a one-row guess; counting it would inflate the
        // total past what was read ("22+" after a 20-row page). It only makes the
        // total a lower bound.
        totals.push({ accuracy: 'estimated', value: 0 });
        hasMores.push(true);
      } else {
        totals.push(found.total);
        hasMores.push(found.hasMore === false ? false : 'unknown');
      }
      continue;
    }

    const asked = need;
    const single = await runSingleQuery(
      deps,
      requestId,
      predicates,
      remainingOffset,
      asked,
      args.properties,
    );
    if (!single.ok) return toolError(single.key, requestId);
    projectedProperties = single.value.projectedProperties;
    const found = single.value.envelope;
    hits.push(...found.hits);
    need -= found.hits.length;

    if (found.hits.length === asked) {
      totals.push(found.total);
      hasMores.push(found.hasMore);
      continue;
    }

    // Fewer rows than asked: only `more === false` proves the segment is over.
    const size =
      found.hasMore !== false
        ? undefined
        : found.hits.length > 0
          ? remainingOffset + found.hits.length
          : found.total.accuracy === 'unknown' || found.total.value > remainingOffset
            ? undefined
            : found.total.value;
    if (size === undefined) {
      return respond({ hits, hasMore: 'unknown', total: { accuracy: 'unknown' } });
    }
    totals.push({ accuracy: 'exact', value: size });
    hasMores.push(false);
    remainingOffset = Math.max(0, remainingOffset - size);
  }

  return respond({ hits, hasMore: mergeHasMore(hasMores), total: mergeTotals(totals) });
}

export async function executeAemQuery(
  envelope: AemQueryRequest,
  deps: AemQueryDeps,
): Promise<AemQueryResult> {
  const args = envelope.args;
  const priorities = deps.priorityPaths ?? [];

  let roots: readonly string[] | undefined;
  if (args.roots !== undefined) {
    if (Object.prototype.hasOwnProperty.call(args.predicates, 'path')) {
      return toolError('roots_and_path_conflict', envelope.requestId);
    }
    roots = effectiveRoots(args.roots);
    if (roots.length === 0) {
      return toolError('roots_not_usable', envelope.requestId);
    }
  }

  if (priorities.length > 0) {
    const scope = resolvePriorityScope(args, roots);
    const segments = scope === undefined ? undefined : planPrioritySegments(scope, priorities);
    if (scope !== undefined && segments !== undefined) {
      const applicable = segments.slice(0, segments.length - scope.length).map((s) => s.path);
      return executePrioritizedQuery(envelope, deps, segments, applicable, roots);
    }
  }

  if (roots === undefined) {
    const single = await runSingleQuery(
      deps,
      envelope.requestId,
      args.predicates,
      args.offset,
      args.limit,
      args.properties,
    );
    if (!single.ok) return toolError(single.key, envelope.requestId);
    return projectQueryResult({
      envelope: single.value.envelope,
      args,
      projectedProperties: single.value.projectedProperties,
      requestId: envelope.requestId,
      sourceOrigin: deps.origin,
      serverRevision: envelope.serverRevision,
      fetchedAt: deps.now(),
    });
  }

  const envelopes: QueryEnvelope[] = [];
  let projectedProperties: readonly string[] = DEFAULT_PROJECTION;
  for (const root of roots) {
    const single = await runSingleQuery(
      deps,
      envelope.requestId,
      { ...args.predicates, path: root },
      args.offset,
      args.limit,
      args.properties,
    );
    if (!single.ok) return toolError(single.key, envelope.requestId);
    envelopes.push(single.value.envelope);
    projectedProperties = single.value.projectedProperties;
  }

  return projectQueryResult({
    envelope: mergeQueryEnvelopes(envelopes),
    args,
    projectedProperties,
    requestId: envelope.requestId,
    sourceOrigin: deps.origin,
    serverRevision: envelope.serverRevision,
    fetchedAt: deps.now(),
    roots,
  });
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export type AemQueryRequestEnvelope = AemQueryRequest;

export interface AemQueryExecutorConfig<TRuntimeDeps extends Record<string, unknown>> {
  readonly execute: (
    envelope: AemQueryRequest,
    deps: { readonly origin: string } & TRuntimeDeps,
  ) => Promise<AemQueryResult>;
  readonly runtimeDeps: TRuntimeDeps;
  readonly currentContext: () => CurrentAemToolContext;
  readonly clock: () => number;
  readonly idGenerator: IdGenerator;
}

/**
 * Builds the `AemToolExecutor` the SDK adapter registers for `aem_query`.
 * Structurally identical to `aem_get_json`'s, via the shared
 * `createToolExecutor`, with one addition: a `toPayload` that keeps the
 * structured result (`rows`, `pagination`, `selection`) alongside the rendered
 * text. The transcript's table now comes from `format_table`, but this tool
 * still contributes its own structured payload so a caller that wants the rows
 * - the model hand-off, or a diagnostic - does not have to re-parse the text.
 */
export function createAemQueryExecutor<TRuntimeDeps extends Record<string, unknown>>(
  config: AemQueryExecutorConfig<TRuntimeDeps>,
): AemToolExecutor {
  return createToolExecutor({
    operation: 'aem_query',
    argsSchema: aemQueryArgsSchema,
    requestSchema: aemQueryRequestSchema,
    render: renderQuerySuccess,
    // The payload is the whole success shape (rows/pagination/selection), plus
    // the two fields every payload carries: `textResultForLlm` (the model's
    // rendering) and `resultType`. `roots` is re-added only when present: under
    // `exactOptionalPropertyTypes` an optional property is omitted, never set
    // to `undefined`, and `JsonValue` has no `undefined`.
    toPayload: (result): JsonValue => {
      const { roots, priorityPaths, ...rest } = result;
      return {
        ...rest,
        ...(roots !== undefined ? { roots: [...roots] } : {}),
        ...(priorityPaths !== undefined ? { priorityPaths: [...priorityPaths] } : {}),
        textResultForLlm: renderQuerySuccess(result),
        resultType: 'success',
      };
    },
    failureFallbackMessage: 'AEM query failed',
    ...config,
  });
}
