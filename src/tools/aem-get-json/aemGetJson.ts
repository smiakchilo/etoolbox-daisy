import { z } from 'zod';
import {
  type AemResponseOutcome,
  type AemToolExecutor,
  type BrokerOutcome,
  type CurrentAemToolContext,
  type IdGenerator,
  type JcrPathRejectionReason,
  type JsonObject,
  type JsonValue,
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
  envelopeCommonShape,
  err,
  jcrPathSchema,
  ok,
  originSchema,
  parseJcrPath,
  parseOrigin,
  propertiesSelectionSchema,
  propertySelectionSchema,
  renderHasMore,
  renderSelection,
  requestIdSchema,
} from '../../shared';

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

/** What `executeAemGetJson` resolves: this tool's success shape, or the shared error arm. */
export type AemGetJsonResult = ToolOutcome<AemGetJsonSuccess>;

export function renderGetJsonSuccess(result: AemGetJsonSuccess): string {
  const childrenLine = result.children.requested
    ? `Children: ${String(result.children.returned)} returned; ` +
      `${renderHasMore(result.children.hasMore)}`
    : 'Children: not requested';
  return [
    `AEM node ${result.path} (origin ${result.sourceOrigin}, revision ` +
      `${String(result.serverRevision)}, fetched at ${String(result.fetchedAt)})`,
    `Selection: ${renderSelection(result.selection)}`,
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
  invalid_path: 'The requested path is not a valid JCR path',
  invalid_origin: 'The current server address could not be used to build a request',
  unencodable_path: 'The requested path contains characters that cannot be encoded in a URL',
  path_not_preserved: 'The request URL could not be built safely for that path',
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
  forbidden: 'The current AEM account is not permitted to read that path',
  not_found: 'AEM reports that no resource exists at that path',
  bad_request: 'AEM rejected the request as malformed',
  url_too_long: 'The request URL was too long for AEM to accept. Send fewer or shorter predicates',
  multiple_choices:
    'AEM refused to return that resource because it has too many nodes to traverse at once',
  server_error: 'AEM returned a server error',
  unexpected_status: 'AEM returned an unexpected status for that request',
  not_json_content_type: 'AEM returned a response that was not JSON',
  html_login_page: 'AEM returned a sign-in page instead of data. Sign in again in the browser pane',
  html_error_page:
    'AEM returned an HTML page instead of data. Check that the browser pane is still signed in, ' +
    'then try a narrower request',
  empty_response:
    'AEM returned an empty response instead of data. The path may be too large to render - ' +
    'request a narrower path or fewer properties',
  invalid_json: 'AEM returned a response that could not be parsed as JSON',
  unexpected_json_shape: 'AEM returned JSON that was not a resource object',
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
  html_error_page: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  empty_response: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  invalid_json: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  unexpected_json_shape: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
};

function toolError(key: ErrorMessageKey, requestId: RequestId): AemGetJsonResult {
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
  /**
   * Optional diagnostics sink, called once per HTTP response with the
   * classification this tool reached (see `ToolHost.recordResponseClassification`).
   * Never affects the result.
   */
  readonly onClassified?: (requestId: RequestId, kind: AemResponseOutcome['kind']) => void;
}

export async function executeAemGetJson(
  envelope: AemGetJsonRequest,
  deps: AemGetJsonDeps,
): Promise<AemGetJsonResult> {
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
  deps.onClassified?.(envelope.requestId, classified.kind);
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
  ) => Promise<AemGetJsonResult>;
  readonly runtimeDeps: TRuntimeDeps;
  readonly currentContext: () => CurrentAemToolContext;
  readonly clock: () => number;
  readonly idGenerator: IdGenerator;
}

/**
 * Builds the `AemToolExecutor` the SDK adapter registers for `aem_get_json`.
 * The shared order of operations (abort, validate args, bind context, re-validate
 * the envelope, execute, render) lives in `createToolExecutor`.
 */
export function createAemGetJsonExecutor<TRuntimeDeps extends Record<string, unknown>>(
  config: AemGetJsonExecutorConfig<TRuntimeDeps>,
): AemToolExecutor {
  return createToolExecutor({
    operation: 'aem_get_json',
    argsSchema: aemGetJsonArgsSchema,
    requestSchema: aemGetJsonRequestSchema,
    render: renderGetJsonSuccess,
    failureFallbackMessage: 'AEM request failed',
    ...config,
  });
}
