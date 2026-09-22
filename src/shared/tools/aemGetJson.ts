import { z } from 'zod';
import {
  createToolError,
  type RequiredAction,
  type ToolError,
  type ToolErrorCode,
} from '../contracts';
import { newRequestId, requestIdSchema, type IdGenerator, type RequestId } from '../contracts';
import type { JsonValue } from '../contracts';
import { err, ok, type Result } from '../result';
import { originSchema, parseOrigin } from '../contracts';
import { computeDeadline, envelopeCommonShape } from './core/envelope';
import type { ToolResult } from './index';
import { brokerErrorKey } from './core/brokerOutcome';
import { classifyAemResponse, type JsonObject } from './core/responseValidation';
import {
  propertiesSelectionSchema,
  propertySelectionSchema,
  renderHasMore,
  renderSelection,
  type PropertySelection,
} from './core/resultCommon';
import type {
  AemToolExecutor,
  BrokerOutcome,
  CurrentAemToolContext,
  ToolDescriptor,
} from './core/types';

/**
 * The `aem_get_json` tool, self-contained.
 *
 * Everything specific to this one agent capability lives in this file: the JCR
 * path validator and argument schema, its model-facing descriptor, its success
 * result shape and model rendering, the URL it builds, how it classifies the
 * response, how it projects the body, its error wording, and the executor that
 * `sdkAgentService.ts` registers. Shared, tool-agnostic pieces (HTTP
 * classification, the envelope/deadline, the error arm, property-selection
 * shapes) are imported from their own modules; the transport is injected as
 * `fetchThroughBridge`, so this module stays pure and unit-testable.
 *
 * The application - never the agent - decides the target: the JCR path is the
 * only per-call input from the model, and the origin is bound from the live
 * application context. The executor has no parameter that could carry an
 * origin from tool arguments even if a caller tried to supply one.
 */

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
 * `.infinity.json`, case-insensitive). The application appends the URL's
 * extension and depth selector when it builds the actual request; a path
 * already carrying one is an attempt to choose the output format/depth the
 * agent is not trusted with. Banning only this suffix - not dots in general -
 * is deliberate: `/content/dam/my.file.pdf` is an ordinary DAM path.
 */
const JSON_EXTENSION_PATTERN = /\.json$/i;

/**
 * A bare numeric or signed-numeric dot-token (`99`, `-1`) is a Sling depth
 * selector, not part of a node name - `-1`, like `infinity`, requests
 * unbounded depth.
 */
const NUMERIC_SELECTOR_TOKEN_PATTERN = /^-?\d+$/;

/**
 * Word-form Sling selectors worth rejecting even without a following
 * extension, because the application - not the agent - chooses both the
 * selector chain and the extension when it builds the request.
 */
const SLING_SELECTOR_KEYWORDS = new Set(['infinity', 'tidy', 'harray', 'blocks']);

/**
 * A `%XX` sequence surviving a single `decodeURIComponent` pass only occurs
 * when the caller encoded the percent sign itself (`%25`), i.e. a
 * double-encoding attempt aimed at surviving this validator's one decode pass.
 */
const PERCENT_ENCODED_OCTET_PATTERN = /%[0-9a-fA-F]{2}/;

/**
 * True if the path's final segment carries a dot-token, after the first (the
 * node name itself), that looks like a Sling selector rather than part of that
 * name. Only the final segment is checked: selectors are meaningful only on
 * the terminal resource of a Sling URL.
 *
 * Deliberately over-inclusive: at validation time there is no way to tell
 * `/content/dam/report.2024` apart from `report` plus a `2024` depth selector.
 * A false rejection the user can see and retry is the correct failure mode; a
 * silently accepted unbounded-depth fetch is not recoverable.
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
 * Validates a candidate JCR/Sling path without rewriting it. A bad path must be
 * rejected, not sanitised: silently stripping `..` or a scheme would make the
 * eventual AEM request address something other than what the agent (and the
 * user reading its answer) believes was asked for.
 *
 * CONTRACT FOR CALLERS: every structural check runs against the
 * percent-decoded form of `candidate`, because that is what a servlet
 * container hands to Sling. Whatever builds the real request URL must
 * reproduce exactly the same single `decodeURIComponent` pass performed here,
 * then percent-encode the result per path segment.
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
  if (decoded.startsWith('//')) return err('protocol_relative');
  if (!decoded.startsWith('/')) return err('not_absolute');
  if (decoded.includes('://')) return err('contains_scheme');
  if (decoded.includes('?')) return err('contains_query');
  if (decoded.includes('#')) return err('contains_fragment');
  if (decoded.includes('\\')) return err('contains_backslash');
  if (decoded.split('/').some((segment) => segment === '..')) {
    return err('contains_traversal_segment');
  }
  // Sling parses `;key=value` after the resource path (or extension) as a
  // request path parameter, not part of a node name. The documented `;v=1.0`
  // parameter selects a different VERSION of the resource.
  if (decoded.includes(';')) {
    return err('contains_request_path_parameter');
  }
  if (decoded !== '/' && decoded.slice(1).split('/').includes('')) {
    return err('contains_empty_segment');
  }
  // A segment ending in `.` is a suffix hazard: for `/a/b./c/d` Sling resolves
  // resource `/a/b` with suffix `/c/d` and no extension, routing to the stream
  // rendering instead of the JSON servlet.
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
// Arguments, descriptor, request envelope
// ---------------------------------------------------------------------------

export const aemGetJsonArgsSchema = z
  .object({
    path: jcrPathSchema,
    properties: propertiesSelectionSchema.optional(),
    includeChildren: z.boolean().optional(),
  })
  .strict();

export type AemGetJsonArgs = z.infer<typeof aemGetJsonArgsSchema>;

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

/** The key `sdkAgentService.ts`'s `toolHandlers` registers this executor under. */
export const AEM_GET_JSON_TOOL_NAME: string = AEM_GET_JSON_TOOL_DESCRIPTOR.name;

/**
 * The allowlist entry `aem_get_json` is registered under
 * (`HardenedToolPolicy.availableTools`), in the source-qualified syntax the
 * policy's matcher and the SDK's own `validateToolFilterList` both expect.
 */
export const AEM_GET_JSON_ALLOWLIST_ENTRY = 'custom:aem_get_json';

export const aemGetJsonRequestSchema = z
  .object({
    operation: z.literal('aem_get_json'),
    ...envelopeCommonShape,
    args: aemGetJsonArgsSchema,
  })
  .strict();

export type AemGetJsonRequest = z.infer<typeof aemGetJsonRequestSchema>;

// ---------------------------------------------------------------------------
// Success result and model rendering
// ---------------------------------------------------------------------------

const childrenMetadataSchema = z.discriminatedUnion('requested', [
  z.object({ requested: z.literal(false) }).strict(),
  z
    .object({
      requested: z.literal(true),
      returned: z.number().int().nonnegative(),
      hasMore: z.union([z.literal(true), z.literal(false), z.literal('unknown')]),
    })
    .strict(),
]);

export type ChildrenMetadata = z.infer<typeof childrenMetadataSchema>;

export const aemGetJsonSuccessSchema = z
  .object({
    ok: z.literal(true),
    operation: z.literal('aem_get_json'),
    requestId: requestIdSchema,
    sourceOrigin: originSchema,
    serverRevision: z.number().int().nonnegative(),
    path: jcrPathSchema,
    fetchedAt: z.number().int().nonnegative(),
    data: z.unknown(),
    selection: propertySelectionSchema,
    children: childrenMetadataSchema,
  })
  .strict();

export type AemGetJsonSuccess = z.infer<typeof aemGetJsonSuccessSchema>;

export function renderGetJsonSuccess(result: AemGetJsonSuccess): string {
  const childrenLine = result.children.requested
    ? `Children: ${String(result.children.returned)} returned; ` +
      `${renderHasMore(result.children.hasMore)}.`
    : 'Children: not requested.';
  return [
    `AEM node ${result.path} (origin ${result.sourceOrigin}, revision ` +
      `${String(result.serverRevision)}, fetched at ${String(result.fetchedAt)}).`,
    `Selection: ${renderSelection(result.selection)}.`,
    childrenLine,
    `Data: ${JSON.stringify(result.data)}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Canonical same-origin Sling JSON resource URL
// ---------------------------------------------------------------------------

export type BuildResourceUrlError =
  | { readonly kind: 'invalid_path'; readonly reason: JcrPathRejectionReason }
  | { readonly kind: 'invalid_origin' }
  | { readonly kind: 'unencodable_path' }
  | { readonly kind: 'path_not_preserved' };

export interface BuildResourceUrlOptions {
  readonly origin: string;
  readonly path: string;
  readonly includeChildren: boolean;
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment);
}

/**
 * Constructs a canonical, same-origin Sling JSON resource URL from an
 * application-validated origin and an agent-supplied JCR path.
 *
 * `options.path` is decoded exactly once - reproducing the single
 * `decodeURIComponent` pass `parseJcrPath` performed - then percent-encoded per
 * segment, so the string that was validated and the string that is requested
 * are the same string. The composed URL is re-parsed and every intended part
 * checked against what `URL` reports, refusing a URL that was normalised or
 * reinterpreted in any way.
 */
export function buildResourceUrl(
  options: BuildResourceUrlOptions,
): Result<string, BuildResourceUrlError> {
  const pathResult = parseJcrPath(options.path);
  if (!pathResult.ok) {
    return err({ kind: 'invalid_path', reason: pathResult.error });
  }

  const originResult = parseOrigin(options.origin);
  if (!originResult.ok) {
    return err({ kind: 'invalid_origin' });
  }

  // Always the explicit numeric selector, never a bare ".json": relying on
  // Sling's depth-0 default would make the effective request depend on a
  // server-side default the application does not control.
  const depthSelector = options.includeChildren ? '1' : '0';

  let encodedSegments: readonly string[];
  try {
    const decodedPath = decodeURIComponent(options.path);
    encodedSegments = decodedPath.split('/').map(encodePathSegment);
  } catch {
    return err({ kind: 'unencodable_path' });
  }
  const encodedPath = encodedSegments.join('/');
  const pathname = `${encodedPath}.${depthSelector}.json`;
  const candidate = `${originResult.origin}${pathname}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return err({ kind: 'path_not_preserved' });
  }

  if (
    url.origin !== originResult.origin ||
    url.pathname !== pathname ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return err({ kind: 'path_not_preserved' });
  }

  return ok(url.toString());
}

// ---------------------------------------------------------------------------
// Success projection
// ---------------------------------------------------------------------------

/** One immediate child node, identified by name only. */
export interface ProjectedChildEntry {
  readonly name: string;
}

export interface ProjectedResourceData {
  readonly properties: Readonly<Record<string, JsonValue>>;
  readonly childNodes?: readonly ProjectedChildEntry[];
}

export interface ProjectGetJsonResultInput {
  readonly data: JsonObject;
  readonly args: AemGetJsonArgs;
  readonly requestId: RequestId;
  readonly sourceOrigin: string;
  readonly serverRevision: number;
  readonly fetchedAt: number;
}

function isChildNode(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Builds the `AemGetJsonSuccess` object for one already-fetched, already-
 * classified node body. Owns the property/child split - Sling's depth-1
 * response mixes a node's own properties and its immediate children into one
 * flat object, and JSON shape is the only signal available.
 */
export function projectGetJsonResult(input: ProjectGetJsonResultInput): AemGetJsonSuccess {
  const propertyEntries: Array<readonly [string, JsonValue]> = [];
  const childNames: string[] = [];

  for (const [key, value] of Object.entries(input.data)) {
    if (isChildNode(value)) {
      childNames.push(key);
    } else {
      propertyEntries.push([key, value]);
    }
  }

  const requestedProperties = input.args.properties;
  let selection: PropertySelection;
  let selectedProperties: Record<string, JsonValue>;

  if (requestedProperties !== undefined) {
    selection = { kind: 'selected', properties: requestedProperties };
    const propertyValues = new Map(propertyEntries);
    selectedProperties = {};
    for (const name of requestedProperties) {
      const value = propertyValues.get(name);
      if (value !== undefined) {
        selectedProperties[name] = value;
      }
    }
  } else {
    selection = { kind: 'all' };
    selectedProperties = Object.fromEntries(propertyEntries);
  }

  const includeChildren = input.args.includeChildren ?? false;

  const childrenMetadata: ChildrenMetadata = includeChildren
    ? { requested: true, returned: childNames.length, hasMore: false }
    : { requested: false };

  const data: ProjectedResourceData = includeChildren
    ? { properties: selectedProperties, childNodes: childNames.map((name) => ({ name })) }
    : { properties: selectedProperties };

  return {
    ok: true,
    operation: 'aem_get_json',
    requestId: input.requestId,
    sourceOrigin: input.sourceOrigin,
    serverRevision: input.serverRevision,
    path: input.args.path,
    fetchedAt: input.fetchedAt,
    data,
    selection,
    children: childrenMetadata,
  };
}

// ---------------------------------------------------------------------------
// Handler: error taxonomy and HTTP -> result
// ---------------------------------------------------------------------------

/**
 * Every message this tool can produce, as a fixed table of application-authored
 * strings. Nothing here is derived from the response: `invalid_json`'s parser
 * message can quote a fragment of the body, and a redirect's `Location` is
 * attacker-controllable. Either would put remote text into the model's context
 * and into logs, which requirements-decisions.md section 2 forbids.
 */
const ERROR_MESSAGES = {
  invalid_path: 'The requested path is not a valid JCR path.',
  invalid_origin: 'The current server address could not be used to build a request.',
  unencodable_path: 'The requested path contains characters that cannot be encoded in a URL.',
  path_not_preserved: 'The request URL could not be built safely for that path.',
  cross_origin: 'The request was refused because it would have left the current server.',
  redirect_blocked:
    'AEM redirected the request away from the server, which usually means the session has expired.',
  redirected:
    'AEM redirected the request away from the server, which usually means the session has expired.',
  no_view: 'The AEM browser pane is not available, so no request could be made.',
  bridge_unavailable:
    'The AEM browser pane is present but its request bridge is not available, so no request ' +
    'could be made. This is an application problem, not an AEM one.',
  network_error: 'The request to AEM could not be completed.',
  cancelled: 'The request was cancelled.',
  timeout: 'AEM did not respond before the request deadline.',
  stale_server_revision: 'The server configuration changed while the request was in flight.',
  stale_navigation_epoch: 'The browser left the page this request was made for.',
  unauthorized: 'AEM did not accept the current session. Sign in again in the browser pane.',
  forbidden: 'The current AEM account is not permitted to read that path.',
  not_found: 'AEM reports that no resource exists at that path.',
  bad_request: 'AEM rejected the request as malformed.',
  url_too_long: 'The request URL was too long for AEM to accept. Send fewer or shorter predicates.',
  multiple_choices:
    'AEM refused to return that resource because it has too many nodes to traverse at once.',
  server_error: 'AEM returned a server error.',
  unexpected_status: 'AEM returned an unexpected status for that request.',
  not_json_content_type: 'AEM returned a response that was not JSON.',
  html_login_page:
    'AEM returned a sign-in page instead of data. Sign in again in the browser pane.',
  invalid_json: 'AEM returned a response that could not be parsed as JSON.',
  unexpected_json_shape: 'AEM returned JSON that was not a resource object.',
} as const;

type ErrorMessageKey = keyof typeof ERROR_MESSAGES;

interface ErrorMapping {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly requiredAction: RequiredAction;
}

const ERROR_MAPPINGS: Readonly<Record<ErrorMessageKey, ErrorMapping>> = {
  invalid_path: { code: 'INVALID_ARGUMENT', retryable: false, requiredAction: 'none' },
  invalid_origin: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'select_server' },
  unencodable_path: { code: 'INVALID_ARGUMENT', retryable: false, requiredAction: 'none' },
  path_not_preserved: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'none' },
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
  // The rule this module exists to get right: authenticated but not permitted.
  forbidden: { code: 'NOT_AUTHORIZED', retryable: false, requiredAction: 'none' },
  not_found: { code: 'NOT_FOUND', retryable: false, requiredAction: 'none' },
  bad_request: { code: 'INVALID_ARGUMENT', retryable: false, requiredAction: 'none' },
  url_too_long: { code: 'INVALID_ARGUMENT', retryable: false, requiredAction: 'none' },
  multiple_choices: {
    code: 'RESULT_TOO_LARGE_FOR_MODEL',
    retryable: false,
    requiredAction: 'reduce_result_size',
  },
  server_error: { code: 'UNEXPECTED_RESPONSE', retryable: true, requiredAction: 'none' },
  unexpected_status: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  not_json_content_type: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  html_login_page: { code: 'AUTH_REQUIRED', retryable: false, requiredAction: 'sign_in_to_aem' },
  invalid_json: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  unexpected_json_shape: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
};

function toolError(key: ErrorMessageKey, requestId: RequestId): { ok: false; error: ToolError } {
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

export interface AemGetJsonDeps {
  /** The origin of the server the request is addressed to. */
  readonly origin: string;
  /** Performs the bridge round trip. Injected so this composition is testable without Electron. */
  readonly fetchThroughBridge: (url: string) => Promise<BrokerOutcome>;
  /** Wall-clock time stamped onto a successful result. */
  readonly now: () => number;
}

export async function executeAemGetJson(
  envelope: AemGetJsonRequest,
  deps: AemGetJsonDeps,
): Promise<ToolResult> {
  const args = envelope.args;
  const built = buildResourceUrl({
    origin: deps.origin,
    path: args.path,
    includeChildren: args.includeChildren ?? false,
  });
  if (!built.ok) {
    return toolError(built.error.kind, envelope.requestId);
  }

  const brokerOutcome = await deps.fetchThroughBridge(built.value);
  if (brokerOutcome.kind !== 'response') {
    return toolError(brokerErrorKey(brokerOutcome), envelope.requestId);
  }

  const classified = classifyAemResponse({
    status: brokerOutcome.status,
    contentType: brokerOutcome.contentType,
    bodyText: brokerOutcome.bodyText,
  });
  if (classified.kind !== 'ok') {
    return toolError(classified.kind, envelope.requestId);
  }

  return projectGetJsonResult({
    data: classified.value,
    args,
    requestId: envelope.requestId,
    sourceOrigin: deps.origin,
    serverRevision: envelope.serverRevision,
    fetchedAt: deps.now(),
  });
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export type AemGetJsonRequestEnvelope = AemGetJsonRequest;

export interface AemGetJsonExecutorConfig<TRuntimeDeps extends Record<string, unknown>> {
  readonly execute: (
    envelope: AemGetJsonRequest,
    deps: { readonly origin: string } & TRuntimeDeps,
  ) => Promise<ToolResult>;
  readonly runtimeDeps: TRuntimeDeps;
  readonly currentContext: () => CurrentAemToolContext;
  readonly clock: () => number;
  readonly idGenerator: IdGenerator;
}

function firstIssueMessage(
  issues: readonly { readonly message: string }[],
  fallback: string,
): string {
  const message = issues[0]?.message;
  return message !== undefined && message.length > 0 ? message.slice(0, 500) : fallback;
}

function toSuccessPayload(result: AemGetJsonSuccess): JsonValue {
  return {
    textResultForLlm: renderGetJsonSuccess(result),
    resultType: 'success',
  };
}

/**
 * Builds the `AemToolExecutor` `sdkAgentService.ts` registers for
 * `aem_get_json`.
 *
 * Order of operations: an already-aborted signal is honoured before anything
 * else; the model's untrusted `args` are validated next; the target and every
 * other envelope field the model does not supply are read from
 * `currentContext()`; the resulting envelope is re-validated before being
 * handed to `config.execute`. Success resolves the rendered
 * `{ textResultForLlm, resultType: "success" }` payload; every failure resolves
 * `err(ToolError)` instead of throwing.
 */
export function createAemGetJsonExecutor<TRuntimeDeps extends Record<string, unknown>>(
  config: AemGetJsonExecutorConfig<TRuntimeDeps>,
): AemToolExecutor {
  return async (args, context) => {
    if (context.signal?.aborted === true) {
      const requestId = newRequestId(config.idGenerator);
      return err(
        createToolError('CANCELLED', 'The request was cancelled before it started.', requestId),
      );
    }

    const parsedArgs = aemGetJsonArgsSchema.safeParse(args);
    if (!parsedArgs.success) {
      const requestId = newRequestId(config.idGenerator);
      return err(
        createToolError(
          'INVALID_ARGUMENT',
          firstIssueMessage(parsedArgs.error.issues, 'Invalid aem_get_json arguments.'),
          requestId,
        ),
      );
    }

    const current = config.currentContext();
    const requestId = newRequestId(config.idGenerator);
    const candidate = {
      operation: 'aem_get_json' as const,
      requestId,
      chatId: current.chatId,
      turnId: current.turnId,
      serverId: current.serverId,
      serverRevision: current.serverRevision,
      navigationEpoch: current.navigationEpoch,
      deadlineMs: computeDeadline(config.clock),
      args: parsedArgs.data,
    };
    const parsedEnvelope = aemGetJsonRequestSchema.safeParse(candidate);
    if (!parsedEnvelope.success) {
      return err(
        createToolError(
          'UNEXPECTED_RESPONSE',
          firstIssueMessage(parsedEnvelope.error.issues, 'Failed to build an AEM request.'),
          requestId,
        ),
      );
    }

    try {
      const result = await config.execute(parsedEnvelope.data, {
        ...config.runtimeDeps,
        origin: current.origin,
      });
      if (!result.ok) return err(result.error);
      if (result.operation !== 'aem_get_json') {
        // Unreachable: `config.execute` is this tool's own handler. Handled
        // rather than asserted so a future change fails closed with a readable
        // message instead of a thrown type error.
        return err(
          createToolError(
            'UNEXPECTED_RESPONSE',
            'Internal error: unexpected tool result shape.',
            requestId,
          ),
        );
      }
      return ok(toSuccessPayload(result));
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message.slice(0, 500) : 'AEM request failed.';
      return err(createToolError('UNEXPECTED_RESPONSE', message, requestId));
    }
  };
}

/**
 * Registers itself with the session's tool policy under this entry, and
 * `sdkAgentService.ts` under {@link AEM_GET_JSON_TOOL_NAME}.
 */
export const AEM_GET_JSON_DEFINITION = {
  name: AEM_GET_JSON_TOOL_NAME,
  descriptor: AEM_GET_JSON_TOOL_DESCRIPTOR,
  allowlistEntry: AEM_GET_JSON_ALLOWLIST_ENTRY,
} as const;
