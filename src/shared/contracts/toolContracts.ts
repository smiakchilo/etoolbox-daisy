import { z } from 'zod';
import { chatIdSchema, requestIdSchema, serverIdSchema, turnIdSchema } from './ids';
import type { ChatId, RequestId, ServerId, TurnId } from './ids';
import { err, ok, type Result } from '../result';

/**
 * Agent-facing tool contracts (implementation-plan.md step 03,
 * requirements-decisions.md section 6).
 *
 * Everything in this file that is reachable from `args` is, per section 2,
 * untrusted input from a model: it must be validated the same way whether it
 * arrived from a well-behaved client or an adversarial one. Everything that is
 * *not* part of `args` - which server, which chat, which deadline - is added
 * by the main process and is exactly the set of fields the agent is not
 * allowed to influence, so the two are kept in separate schemas rather than
 * one object the agent could theoretically populate in full.
 */

export const TOOL_OPERATIONS = ['aem_get_json', 'aem_query'] as const;
export type ToolOperation = (typeof TOOL_OPERATIONS)[number];

const aemGetJsonOperationSchema = z.literal('aem_get_json');
const aemQueryOperationSchema = z.literal('aem_query');

// ---------------------------------------------------------------------------
// JCR/Sling path validation
// ---------------------------------------------------------------------------

/**
 * Bounds a path to something a JCR repository would plausibly contain. Not a
 * security boundary by itself - it exists so a pathological input cannot turn
 * later string scanning/logging into unbounded work.
 */
const JCR_PATH_MAX_LENGTH = 1000;

export const JCR_PATH_REJECTION_REASONS = [
  'empty',
  'too_long',
  'malformed_percent_encoding',
  'contains_double_percent_encoding',
  'contains_control_character',
  'protocol_relative',
  'not_absolute',
  'contains_scheme',
  'contains_query',
  'contains_fragment',
  'contains_backslash',
  'contains_traversal_segment',
  'contains_request_path_parameter',
  'contains_empty_segment',
  'contains_dot_terminated_segment',
  'contains_sling_selector',
  'contains_json_extension',
] as const;

export type JcrPathRejectionReason = (typeof JCR_PATH_REJECTION_REASONS)[number];

/**
 * Matches a trailing Sling response-format extension, with or without a
 * preceding depth selector (`.json`, `.1.json`, `.99.json`, `.-1.json`,
 * `.infinity.json`, matched case-insensitively). The application, not the
 * agent, appends the URL's extension and depth selector when it builds the
 * actual request (section 6); a path already carrying one is not "a deeper
 * request", it is an attempt to choose the output format/depth the agent is
 * not trusted with. Banning only this suffix - not dots in general - is
 * deliberate: `/content/dam/my.file.pdf` is an ordinary DAM path and must
 * keep working.
 */
const JSON_EXTENSION_PATTERN = /\.json$/i;

/**
 * A bare numeric or signed-numeric dot-token (`99`, `-1`) is a Sling depth
 * selector, not part of a node name - `-1`, like `infinity`, requests
 * unbounded depth (implementation-plan.md line 319 names "servlet-selector
 * substitution" by name as something a JCR path validator must catch, not
 * just the `.infinity.json` spelling of it).
 */
const NUMERIC_SELECTOR_TOKEN_PATTERN = /^-?\d+$/;

/**
 * Word-form Sling selectors worth rejecting even without a following
 * extension, because the application - not the agent - chooses both the
 * selector chain and the extension when it builds the request
 * (implementation-plan.md line 315-316). `infinity` is unbounded depth,
 * exactly like `-1`; `tidy`/`harray`/`blocks` are common output-shaping
 * selectors bundled with Sling/AEM that likewise change what is returned.
 */
const SLING_SELECTOR_KEYWORDS = new Set(['infinity', 'tidy', 'harray', 'blocks']);

/**
 * A `%XX` sequence surviving a single `decodeURIComponent` pass only occurs
 * when the caller encoded the percent sign itself (`%25`), i.e. a
 * double-encoding attempt aimed at surviving this validator's one decode
 * pass and being decoded a second time by something downstream. There is no
 * legitimate JCR path that needs this.
 */
const PERCENT_ENCODED_OCTET_PATTERN = /%[0-9a-fA-F]{2}/;

/**
 * True if the path's final segment carries a dot-token, after the first
 * (the node name itself), that looks like a Sling selector rather than part
 * of that name. Only the final segment is checked: selectors are meaningful
 * only on the terminal resource of a Sling URL, never on an intermediate
 * path segment.
 *
 * This is deliberately over-inclusive: at validation time there is no way to
 * tell a genuinely-named node like `/content/dam/report.2024` apart from
 * `report` plus a `2024` depth selector - only the repository could resolve
 * that, and this function never asks it. Per requirements-decisions.md
 * section 6 ("reject invalid values explicitly rather than silently
 * changing the requested operation"), a false rejection the user can see and
 * retry under a different path is the correct failure mode here; a silently
 * accepted unbounded-depth fetch is not recoverable at all. Do not "fix" this
 * by loosening the pattern without re-reading this comment.
 */
function containsSlingSelectorToken(candidate: string): boolean {
  const finalSegment = candidate.slice(candidate.lastIndexOf('/') + 1);
  const [, ...suffixTokens] = finalSegment.split('.');
  return suffixTokens.some(
    (token) =>
      NUMERIC_SELECTOR_TOKEN_PATTERN.test(token) ||
      SLING_SELECTOR_KEYWORDS.has(token.toLowerCase()),
  );
}

/**
 * Validates a candidate JCR/Sling path without rewriting it. The plan is
 * explicit that a bad path must be rejected, not sanitised: silently
 * stripping `..` or a scheme would make the eventual AEM request address
 * something other than what the agent (and, transitively, the user reading
 * its answer) believes was asked for.
 *
 * Returns the shared {@link Result} rather than a parallel ok/error shape -
 * there is nothing operation-specific about "valid, or invalid for this
 * reason" that would justify a second type doing the same job.
 *
 * CONTRACT FOR CALLERS (step 06 and beyond): every structural check below
 * runs against the percent-decoded form of `candidate`, because that is what
 * a servlet container hands to Sling - validating only the raw string would
 * leave every rule (selector substitution, traversal, backslash, ...) open
 * to a trivial `%2E`/`%2D`/`%2F`-style bypass. This function still returns
 * only ok/err, not the decoded string, so whatever builds the real request
 * URL from an accepted `candidate` MUST reproduce exactly the same single
 * `decodeURIComponent` pass performed here, and MUST then percent-encode the
 * result per path segment. Applying a different number of decode passes -
 * zero, or two - is what reopens the gap this function closes, because the
 * string being judged would no longer be the string being requested. One
 * pass, then re-encode, is the only arrangement in which those two strings
 * are identical.
 *
 * Order matters below only for which single reason is reported first when a
 * path is wrong in more than one way; every listed condition is checked
 * before the path is ever handed to a URL constructor downstream (step 06).
 */
export function parseJcrPath(candidate: string): Result<void, JcrPathRejectionReason> {
  if (candidate.length === 0) return err('empty');
  if (candidate.length > JCR_PATH_MAX_LENGTH) return err('too_long');

  let decoded: string;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return err('malformed_percent_encoding');
  }
  if (PERCENT_ENCODED_OCTET_PATTERN.test(decoded)) {
    return err('contains_double_percent_encoding');
  }

  if ([...decoded].some((char) => char.codePointAt(0)! < 0x20 || char === '\u007f')) {
    return err('contains_control_character');
  }
  // Checked before the plain "not absolute" case: "//host/path" already starts
  // with "/", but is a network-path reference (resolves against a host), not
  // a repository path, and deserves its own diagnosis.
  if (decoded.startsWith('//')) return err('protocol_relative');
  if (!decoded.startsWith('/')) return err('not_absolute');
  if (decoded.includes('://')) return err('contains_scheme');
  if (decoded.includes('?')) return err('contains_query');
  if (decoded.includes('#')) return err('contains_fragment');
  // Windows path separators have no meaning in a JCR path, and some URL/path
  // parsers treat them as separators anyway - reject rather than guess intent.
  if (decoded.includes('\\')) return err('contains_backslash');
  if (decoded.split('/').some((segment) => segment === '..')) {
    return err('contains_traversal_segment');
  }
  // Sling parses `;key=value` after the resource path (or after the extension)
  // as a *request path parameter*, not as part of a node name
  // (https://sling.apache.org/documentation/the-sling-engine/url-decomposition.html,
  // SLING-848). The documented `;v=1.0` parameter selects a different VERSION
  // of the resource, so a path carrying one would silently answer from content
  // other than the current state the user is looking at. Note the quoted form
  // `;v='1.0'` is the spelling the Sling docs require when the value contains a
  // dot, and it slips past the selector-token check below - which is precisely
  // why this needs its own rule rather than being left to that one.
  if (decoded.includes(';')) {
    return err('contains_request_path_parameter');
  }
  // An empty segment means a trailing slash or a `//` run. Appending the
  // application's own `.<depth>.json` to a path ending in `/` produces a URI
  // whose resource path no longer matches any resource (Sling requires the
  // character after the resource path to be a dot), so this would fail as an
  // opaque 404 rather than an explicit, actionable rejection. The repository
  // root is the one legitimate path that is nothing but a slash.
  if (decoded !== '/' && decoded.slice(1).split('/').includes('')) {
    return err('contains_empty_segment');
  }
  // A segment ending in `.` is the suffix hazard from the same decomposition
  // rules: for `/a/b./c/d` Sling resolves resource `/a/b` with suffix `/c/d`
  // and *no extension at all*, which routes the request to the stream
  // rendering instead of the JSON servlet. That is servlet substitution
  // (implementation-plan.md line 319) reached without any selector keyword.
  if (decoded.split('/').some((segment) => segment.length > 0 && segment.endsWith('.'))) {
    return err('contains_dot_terminated_segment');
  }
  if (containsSlingSelectorToken(decoded)) {
    return err('contains_sling_selector');
  }
  if (JSON_EXTENSION_PATTERN.test(decoded)) {
    return err('contains_json_extension');
  }
  return ok(undefined);
}

function jcrPathRejectionMessage(reason: JcrPathRejectionReason): string {
  switch (reason) {
    case 'empty':
      return 'must not be empty';
    case 'too_long':
      return `must be at most ${String(JCR_PATH_MAX_LENGTH)} characters`;
    case 'malformed_percent_encoding':
      return "must not contain a malformed percent-encoded sequence (e.g. '%ZZ' or a truncated '%2')";
    case 'contains_double_percent_encoding':
      return (
        "must not contain a double percent-encoded sequence (e.g. '%252E' encoding a " +
        "literal '%'); the application decodes the path exactly once"
      );
    case 'contains_control_character':
      return 'must not contain control characters';
    case 'protocol_relative':
      return "must not start with '//' (that resolves as a network-path reference, not a repository path)";
    case 'not_absolute':
      return "must be an absolute repository path starting with '/'";
    case 'contains_scheme':
      return "must not contain a URL scheme ('://')";
    case 'contains_query':
      return "must not contain a query string ('?')";
    case 'contains_fragment':
      return "must not contain a fragment ('#')";
    case 'contains_backslash':
      return 'must not contain a backslash';
    case 'contains_traversal_segment':
      return "must not contain a '..' path segment";
    case 'contains_request_path_parameter':
      return (
        "must not contain ';' (Sling reads ';key=value' after a resource path as a request " +
        "path parameter - for example ';v=1.0' selects a different version of the content - " +
        'so it would change which content is returned)'
      );
    case 'contains_empty_segment':
      return "must not contain an empty path segment (a trailing '/' or a '//' run)";
    case 'contains_dot_terminated_segment':
      return (
        "must not contain a path segment ending in '.' (Sling would treat the rest of the " +
        'path as a suffix and drop the extension, routing the request to a different ' +
        'renderer than the JSON one)'
      );
    case 'contains_sling_selector':
      return (
        "must not contain a Sling selector in its final segment (a numeric or '-1' depth " +
        "selector, 'infinity', 'tidy', 'harray', or 'blocks'); the application chooses " +
        'selectors and extensions itself - if this is a genuine node name, it cannot be ' +
        'addressed through this tool'
      );
    case 'contains_json_extension':
      return (
        "must not include a '.json' extension or Sling depth selector (e.g. '.json', " +
        "'.99.json', '.-1.json', '.infinity.json'); the application appends its own " +
        'response format and depth'
      );
  }
}

export const jcrPathSchema = z.string().superRefine((value, ctx) => {
  const result = parseJcrPath(value);
  if (!result.ok) {
    ctx.addIssue({ code: 'custom', message: `path ${jcrPathRejectionMessage(result.error)}` });
  }
});

// ---------------------------------------------------------------------------
// Shared leaf schemas
// ---------------------------------------------------------------------------

const PROPERTY_NAME_MAX_LENGTH = 200;

const propertyNameSchema = z
  .string()
  .min(1, 'must not be empty')
  .max(PROPERTY_NAME_MAX_LENGTH, `must be at most ${String(PROPERTY_NAME_MAX_LENGTH)} characters`)
  .refine(
    (value) => ![...value].some((char) => char.codePointAt(0)! < 0x20 || char === '\u007f'),
    'must not contain control characters',
  );

const propertiesSelectionSchema = z.array(propertyNameSchema);

export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 200;
export const MIN_QUERY_LIMIT = 1;

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
  .safe('offset must be a safe integer')
  .default(0);

const PREDICATE_KEY_MAX_LENGTH = 200;
const PREDICATE_VALUE_MAX_LENGTH = 2000;

/**
 * QueryBuilder's own output-control parameters (section 6: "Disallow
 * `p.limit=-1` ... and uncontrolled recursive node output"). These are
 * unprefixed, top-level keys only - `group.p.or`, `1_group.p.or`, and
 * `group.1_property` name ordinary scoped predicates and are unaffected
 * (section 6 gives `group.p.or` by name as the example of what must keep
 * working).
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

/**
 * `constructor`/`prototype` are ordinary own-enumerable keys as far as
 * `Object.keys`/property iteration are concerned, so they reach this
 * key-level check like any other predicate name would.
 */
const UNSAFE_PREDICATE_KEYS = ['constructor', 'prototype'] as const;

/**
 * `__proto__` is not an ordinary key: assigned via the object-literal/`[[Set]]`
 * path it sets the prototype instead of creating an own property, and even
 * when it does exist as a real own-enumerable property (as `JSON.parse`
 * produces, since it uses `[[DefineOwnProperty]]`), plain object
 * reconstruction - including zod's own `record` output - silently drops it
 * rather than rejecting it. That silent drop is exactly the "silently
 * changing the requested operation" section 6 forbids, just relocated from
 * pagination into predicate keys, so it needs its own explicit check against
 * the raw candidate before any reconstruction can eat it.
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
 * Deliberately not restricted to a predicate-name allowlist (section 6:
 * "Do not restrict QueryBuilder predicates to a predefined list"). What *is*
 * rejected - reserved output-control keys and prototype-pollution keys - is
 * rejected here, in the one validator the handler and transport boundary
 * both use (implementation-plan.md step 03: "the handler and transport
 * boundary use the same validator"); leaving it for step 08 to strip or
 * reject would mean that boundary needs its own second check of the same
 * map, which is the duplication that sentence rules out.
 *
 * Wrapped in `z.preprocess` rather than a `superRefine` on the record itself:
 * by the time a refinement on `z.record(...)` runs, the record's own base
 * parsing has already constructed its output object by assignment, which
 * silently drops a `__proto__` key before any refinement could see it.
 * Preprocessing inspects the raw candidate - where `__proto__` still shows up
 * as an own key when the input came from `JSON.parse` - before that happens.
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
// aem_get_json
// ---------------------------------------------------------------------------

export const aemGetJsonArgsSchema = z
  .object({
    path: jcrPathSchema,
    properties: propertiesSelectionSchema.optional(),
    includeChildren: z.boolean().optional(),
  })
  .strict();

export type AemGetJsonArgs = z.infer<typeof aemGetJsonArgsSchema>;

// ---------------------------------------------------------------------------
// aem_query
// ---------------------------------------------------------------------------

export const aemQueryArgsSchema = z
  .object({
    predicates: queryPredicatesSchema,
    offset: queryOffsetSchema,
    limit: queryLimitSchema,
    properties: propertiesSelectionSchema.optional(),
  })
  .strict();

export type AemQueryArgs = z.infer<typeof aemQueryArgsSchema>;

// ---------------------------------------------------------------------------
// SDK tool registration descriptors
// ---------------------------------------------------------------------------

/**
 * `zod@4.6.4` ships `z.toJSONSchema`, verified against the installed package
 * (`node_modules/zod/v4/core/to-json-schema.*`) rather than assumed from the
 * changelog. Deriving the descriptor's `parameters` from the same schema that
 * validates the call means the two cannot drift the way a hand-written JSON
 * Schema copy eventually would. `io: "input"` is required, not cosmetic: the
 * default ("output") reports `limit`/`offset` as required because a parsed
 * *result* always has them (their `.default()` fills them in), which would
 * wrongly tell the model it must supply values that are actually optional.
 */
export interface ToolDescriptor {
  readonly name: ToolOperation;
  readonly description: string;
  /**
   * The JSON Schema `z.toJSONSchema` produces. Left as `unknown` rather than
   * named against zod's internal `ZodStandardJSONSchemaPayload<T>` type:
   * `toJSONSchema` is overloaded (a single-schema form and a registry form),
   * so `ReturnType<typeof z.toJSONSchema>` resolves to whichever overload
   * TypeScript picks last, not the one actually called here.
   */
  readonly parameters: unknown;
}

export const AEM_GET_JSON_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: 'aem_get_json',
  description:
    'Fetches JCR/Sling node properties (and, optionally, immediate child node names) ' +
    'as JSON from the currently active AEM instance. `path` must be a bare absolute ' +
    "repository path starting with '/': no scheme, host, query string, '..' " +
    "traversal, and no Sling selector or extension in the final segment (e.g. '.json', " +
    "'.99', '.-1', '.infinity', '.tidy', with or without a following extension) - the " +
    'application appends the response format and depth itself. Do not percent-encode ' +
    'the path; it is validated after decoding, so encoding cannot bypass these rules. ' +
    '`properties` optionally restricts which properties are returned; omit it to ' +
    'receive every property AEM exposes for the node. `includeChildren` optionally ' +
    'returns immediate child nodes only; it never descends further.',
  parameters: z.toJSONSchema(aemGetJsonArgsSchema, { io: 'input' }),
};

export const AEM_QUERY_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: 'aem_query',
  description:
    'Runs an AEM QueryBuilder search from an arbitrary map of QueryBuilder ' +
    'predicate keys and values in `predicates`, including customer-installed ' +
    `predicates - there is no fixed predicate list. Results are paginated: ` +
    `\`limit\` defaults to ${String(DEFAULT_QUERY_LIMIT)} and may be at most ` +
    `${String(MAX_QUERY_LIMIT)} per call; \`offset\` defaults to 0. Fetch further ` +
    'results with additional calls at a higher `offset`, never by requesting a ' +
    "larger `limit`. Do not put QueryBuilder's own output-control parameters " +
    '(`p.limit`, `p.offset`, `p.guessTotal`, `p.hits`, `p.nodedepth`, `p.excerpt`, ' +
    '`p.facets`) in `predicates` - they are rejected; use the dedicated `limit`/' +
    '`offset`/`properties` fields instead. `properties` optionally restricts which ' +
    'result fields are returned.',
  parameters: z.toJSONSchema(aemQueryArgsSchema, { io: 'input' }),
};

export const TOOL_DESCRIPTORS: readonly ToolDescriptor[] = [
  AEM_GET_JSON_TOOL_DESCRIPTOR,
  AEM_QUERY_TOOL_DESCRIPTOR,
];

// ---------------------------------------------------------------------------
// Main-process request envelope
// ---------------------------------------------------------------------------

/**
 * Total budget for one AEM request, end to end, per requirements-decisions.md
 * section 6.
 */
export const AEM_REQUEST_TIMEOUT_MS = 90_000;

/**
 * Supplies the current time as epoch milliseconds. Kept as an injected
 * function rather than a call to `Date.now()` so deadline arithmetic stays
 * deterministic under test and so `src/shared` never reaches for an ambient
 * global (there is no `Date` ban here, only a project-wide preference for
 * testability - see the identical pattern for id generation in `./ids`).
 */
export type Clock = () => number;

/**
 * The envelope's deadline is an absolute timestamp, not a duration. A
 * duration would restart at every hop the request passes through (renderer to
 * preload, preload to page `fetch`, retry inside the transport, ...), so a
 * chain of hops could each individually stay "within timeout" while the
 * overall wait for the agent's answer blew past the intended 90 seconds.
 * Computing the deadline once, here, against a single clock reading is what
 * makes "90 seconds total" actually mean 90 seconds total.
 */
export function computeDeadline(clock: Clock): number {
  return clock() + AEM_REQUEST_TIMEOUT_MS;
}

export function isDeadlineExpired(deadlineMs: number, clock: Clock): boolean {
  return clock() >= deadlineMs;
}

const envelopeCommonShape = {
  requestId: requestIdSchema,
  chatId: chatIdSchema,
  turnId: turnIdSchema,
  serverId: serverIdSchema,
  serverRevision: z.number().int().nonnegative(),
  navigationEpoch: z.number().int().nonnegative(),
  deadlineMs: z.number().int().positive(),
};

/**
 * Fields the main process attaches to every tool call; the agent never
 * supplies or sees these as tool arguments (implementation-plan.md step 03).
 * Exported as its own type - rather than derived with `Pick` from the
 * envelope union below - because `Pick` does not distribute over a union the
 * way this shared shape needs to.
 */
export interface ToolRequestEnvelopeCommon {
  readonly requestId: RequestId;
  readonly chatId: ChatId;
  readonly turnId: TurnId;
  readonly serverId: ServerId;
  readonly serverRevision: number;
  readonly navigationEpoch: number;
  readonly deadlineMs: number;
}

const aemGetJsonRequestSchema = z
  .object({
    operation: aemGetJsonOperationSchema,
    ...envelopeCommonShape,
    args: aemGetJsonArgsSchema,
  })
  .strict();

const aemQueryRequestSchema = z
  .object({
    operation: aemQueryOperationSchema,
    ...envelopeCommonShape,
    args: aemQueryArgsSchema,
  })
  .strict();

/**
 * A discriminated union keyed by `operation`, rather than one object with an
 * open-ended `operation: string`, so an unknown operation name is a structural
 * validation failure and so `args` is always the schema that matches the
 * operation it is attached to - a model cannot send `aem_query`'s shape under
 * `operation: "aem_get_json"`.
 */
export const toolRequestEnvelopeSchema = z.discriminatedUnion('operation', [
  aemGetJsonRequestSchema,
  aemQueryRequestSchema,
]);

export type ToolRequestEnvelope = z.infer<typeof toolRequestEnvelopeSchema>;

/**
 * requirements-decisions.md section 6 also requires exactly one in-flight AEM
 * request application-wide, with queued requests cancelled on stop/switch.
 * That is a runtime scheduling policy that needs a live queue and cancellation
 * hooks; it is enforced by the main-process transport (implementation-plan.md
 * step 06/07), not here. A `maxConcurrency` field on this envelope would not
 * enforce anything by itself - it would just be a number nobody reads - so
 * this module intentionally contains no such field.
 */

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

export interface CurrentAemContext {
  readonly serverRevision: number;
  readonly navigationEpoch: number;
}

/**
 * `"fresh"` alongside the two distinct staleness causes, rather than a single
 * boolean, because the two causes are user-facing differently: a revision
 * change means "this server's configuration changed under you", while a
 * navigation-epoch change means "the browser left the page this request was
 * for". Collapsing both into `isStale: boolean` would force the caller to
 * re-derive which happened, from state this function already has.
 */
export type StalenessStatus = 'fresh' | 'stale_server_revision' | 'stale_navigation_epoch';

/**
 * Deliberately symmetric (`!==`, either direction), unlike
 * {@link "./serverConfig".isStaleRevision}, which only treats
 * `observed < current` as stale because a chat's cached revision can never
 * legitimately be ahead of the server it describes. This function instead
 * gates whether an in-flight tool call's *result* may still be delivered -
 * a decision where relying on that same "can only fall behind" invariant
 * would be actively dangerous if it were ever violated (a revision counter
 * reset, a server removed and re-added, or any other anomaly): the
 * directional check would then misclassify a request built against a
 * config that no longer exists in that form as "fresh". A false
 * `stale_server_revision` just makes the caller retry; a false `"fresh"`
 * here would hand the model a result against server state that has since
 * changed. Any mismatch, in either direction, is therefore treated as
 * staleness for this specific gate.
 */
export function classifyStaleness(
  envelope: ToolRequestEnvelope,
  current: CurrentAemContext,
): StalenessStatus {
  if (envelope.serverRevision !== current.serverRevision) return 'stale_server_revision';
  if (envelope.navigationEpoch !== current.navigationEpoch) return 'stale_navigation_epoch';
  return 'fresh';
}
