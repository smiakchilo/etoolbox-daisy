import { z } from 'zod';
import {
  type BridgeRequestOptions,
  type BrokerOutcome,
  type CurrentToolContext,
  type IdGenerator,
  type JsonValue,
  type RequestId,
  type RequiredAction,
  type ToolDescriptor,
  type ToolErrorCode,
  type ToolExecutor,
  type ToolOutcome,
  brokerErrorKey,
  createToolExecutor,
  envelopeCommonShape,
  parseOrigin,
  requestIdSchema,
} from '../../shared';

/**
 * The `http_fetch` tool: one HTTP GET or HEAD, returned as data.
 *
 * It is the generic transport the other read tools sit on (`aem_get_json` is a
 * composite over it). It deliberately interprets nothing: every HTTP status is a
 * successful call that returns the status, so a caller that audits links sees a
 * 404 as a 404 rather than as an error. Only a request that could not be made
 * or completed (refused target, timeout, no pane, a redirect off the origin) is
 * a failure.
 *
 * Where a request goes is the application's decision, never the model's:
 * - the host the browser pane is on (same origin) goes through the pane's
 *   authenticated bridge, so it carries the user's session;
 * - another *configured* host is refused - the pane must be moved there first,
 *   because only the pane holds that host's session;
 * - anything else goes out through the application's own network stack with no
 *   cookies and no session (`ToolHost.externalFetch`), which enforces its own
 *   address, redirect, size and time limits.
 */

// ---------------------------------------------------------------------------
// Arguments, descriptor, request envelope
// ---------------------------------------------------------------------------

export const httpFetchArgsSchema = z
  .object({
    url: z.string().trim().min(1).max(2048),
    method: z.enum(['GET', 'HEAD']).optional(),
    accept: z.string().min(1).max(200).optional(),
  })
  .strict();

export type HttpFetchArgs = z.infer<typeof httpFetchArgsSchema>;

export const HTTP_FETCH_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: 'http_fetch',
  description:
    'Fetches one URL with HTTP GET (default) or HEAD and returns its status, content type ' +
    'and body. `url` is an absolute http(s) URL, or a path starting with "/" that is resolved ' +
    "against the host the browser pane is on (that request carries the user's signed-in " +
    'session). Any other host is fetched anonymously, without cookies or a session, and ' +
    'addresses on a local or private network are refused. Every HTTP status is returned as ' +
    'data (a 404 is a result, not a failure); the call only fails when no request could be ' +
    'made or completed. `accept` optionally replaces the default JSON `Accept` header, e.g. ' +
    '"text/html". The body is cut to a size limit and then marked `truncated`.',
  parameters: z.toJSONSchema(httpFetchArgsSchema, { io: 'input' }),
};

export const HTTP_FETCH_TOOL_NAME: string = HTTP_FETCH_TOOL_DESCRIPTOR.name;

export const HTTP_FETCH_ALLOWLIST_ENTRY = 'custom:http_fetch';

/** What the model sees of a body: enough to read a page, not a whole download. */
export const HTTP_FETCH_MODEL_BODY_LIMIT = 100_000;
/** What a calling tool may receive; it processes the body itself and shows the model a summary. */
export const HTTP_FETCH_NESTED_BODY_LIMIT = 5_000_000;

export const httpFetchRequestSchema = z
  .object({
    operation: z.literal('http_fetch'),
    ...envelopeCommonShape,
    args: httpFetchArgsSchema,
  })
  .strict();

export type HttpFetchRequest = z.infer<typeof httpFetchRequestSchema>;

// ---------------------------------------------------------------------------
// Success result and model rendering
// ---------------------------------------------------------------------------

export const httpFetchSuccessSchema = z
  .object({
    ok: z.literal(true),
    operation: z.literal('http_fetch'),
    requestId: requestIdSchema,
    url: z.string(),
    via: z.enum(['bridge', 'external']),
    method: z.enum(['GET', 'HEAD']),
    status: z.number().int(),
    contentType: z.string().nullable(),
    bodyText: z.string(),
    truncated: z.boolean(),
    fetchedAt: z.number().int().nonnegative(),
  })
  .strict();

export type HttpFetchSuccess = z.infer<typeof httpFetchSuccessSchema>;

export type HttpFetchResult = ToolOutcome<HttpFetchSuccess>;

function statusLine(result: HttpFetchSuccess): string {
  const via = result.via === 'bridge' ? 'signed-in session' : 'anonymous';
  const type = result.contentType ?? 'no content type';
  return `${result.method} ${result.url} -> HTTP ${String(result.status)} (${type}, ${via})`;
}

export function renderHttpFetchSuccess(result: HttpFetchSuccess): string {
  if (result.method === 'HEAD' || result.bodyText.length === 0) return statusLine(result);
  const note = result.truncated ? '\n[body truncated to the size limit]' : '';
  return `${statusLine(result)}\n${result.bodyText}${note}`;
}

// ---------------------------------------------------------------------------
// Handler: error taxonomy
// ---------------------------------------------------------------------------

/**
 * Application-authored messages only: nothing is derived from the response or
 * from a `Location` header, which the remote side controls.
 */
const ERROR_MESSAGES = {
  invalid_url:
    'The URL is not usable. Give an absolute http(s) URL without credentials, or a path starting with "/"',
  other_host:
    'That URL belongs to another configured host, which can only be read with its own session. ' +
    'Open that host in the browser pane first, then request it again',
  external_unavailable: 'Requests to hosts outside the browser pane are not available',
  address_refused:
    'That address was refused: requests to local, private or internal network addresses are not made',
  too_many_redirects: 'The request was redirected too many times to be followed',
  cross_origin: 'The request was refused because it would have left the current host',
  redirect_blocked:
    'The host redirected the request away from itself, which usually means the session has expired',
  no_view: 'The browser pane is not available, so no request could be made',
  bridge_unavailable:
    'The browser pane is present but its request bridge is not available, so no request ' +
    'could be made. This is an application problem, not one with the host',
  network_error: 'The request could not be completed',
  cancelled: 'The request was cancelled',
  timeout: 'The host did not respond before the request deadline',
  stale_server_revision: 'The host configuration changed while the request was in flight',
  stale_navigation_epoch: 'The browser left the page this request was made for',
} as const;

type ErrorMessageKey = keyof typeof ERROR_MESSAGES;

interface ErrorMapping {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly requiredAction: RequiredAction;
}

const ERROR_MAPPINGS: Readonly<Record<ErrorMessageKey, ErrorMapping>> = {
  invalid_url: { code: 'INVALID_ARGUMENT', retryable: false, requiredAction: 'none' },
  other_host: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'select_server' },
  external_unavailable: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'none' },
  address_refused: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'none' },
  too_many_redirects: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  cross_origin: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'none' },
  redirect_blocked: {
    code: 'REDIRECT_BLOCKED',
    retryable: false,
    requiredAction: 'sign_in_to_host',
  },
  no_view: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'select_server' },
  bridge_unavailable: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'none' },
  network_error: { code: 'NETWORK_ERROR', retryable: true, requiredAction: 'none' },
  cancelled: { code: 'CANCELLED', retryable: true, requiredAction: 'none' },
  timeout: { code: 'TIMEOUT', retryable: true, requiredAction: 'none' },
  stale_server_revision: { code: 'STALE_CONTEXT', retryable: true, requiredAction: 'none' },
  stale_navigation_epoch: { code: 'STALE_CONTEXT', retryable: true, requiredAction: 'none' },
};

function toolError(key: ErrorMessageKey, requestId: RequestId): HttpFetchResult {
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

/**
 * A failure of an *external* request. No pane session is involved, so a refusal
 * is about the address and a blocked redirect means "too many", never a lost
 * sign-in.
 */
function externalFailureKey(
  outcome: Exclude<BrokerOutcome, { kind: 'response' }>,
): ErrorMessageKey {
  if (outcome.kind === 'blocked') {
    if (outcome.reason === 'invalid_url') return 'invalid_url';
    return outcome.reason === 'redirect_blocked' ? 'too_many_redirects' : 'address_refused';
  }
  return brokerErrorKey(outcome);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface HttpFetchDeps {
  /** The origin of the page the browser pane is on. */
  readonly origin: string;
  readonly now: () => number;
  /** The pane's authenticated bridge. */
  readonly viaBridge: (url: string, options: BridgeRequestOptions) => Promise<BrokerOutcome>;
  /** The anonymous fetch; absent when the application offers none. */
  readonly external:
    | ((
        url: string,
        options: BridgeRequestOptions,
        signal: AbortSignal | undefined,
      ) => Promise<BrokerOutcome>)
    | undefined;
  readonly isConfiguredOrigin: (origin: string) => boolean;
  readonly bodyLimit: number;
  readonly signal: AbortSignal | undefined;
}

/**
 * Resolves the model's `url`. A path starting with a single "/" is read against
 * the pane's origin. Only http(s) with no credentials is accepted; the fragment
 * never reaches a server, so it is dropped.
 */
export function resolveFetchUrl(raw: string, currentOrigin: string): URL | undefined {
  let url: URL;
  try {
    url = raw.startsWith('/') && !raw.startsWith('//') ? new URL(raw, currentOrigin) : new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  if (url.hostname === '') return undefined;
  url.hash = '';
  return url;
}

export async function executeHttpFetch(
  envelope: HttpFetchRequest,
  deps: HttpFetchDeps,
): Promise<HttpFetchResult> {
  const { args, requestId } = envelope;
  const url = resolveFetchUrl(args.url, deps.origin);
  if (url === undefined) return toolError('invalid_url', requestId);

  const parsedOrigin = parseOrigin(url.origin);
  if (!parsedOrigin.ok) return toolError('invalid_url', requestId);
  const targetOrigin = parsedOrigin.origin;

  const method = args.method ?? 'GET';
  const options: BridgeRequestOptions = {
    method,
    ...(args.accept !== undefined ? { accept: args.accept } : {}),
  };

  let via: 'bridge' | 'external';
  let outcome: BrokerOutcome;
  if (targetOrigin === deps.origin) {
    via = 'bridge';
    outcome = await deps.viaBridge(url.href, options);
    if (outcome.kind !== 'response') return toolError(brokerErrorKey(outcome), requestId);
  } else if (deps.isConfiguredOrigin(targetOrigin)) {
    return toolError('other_host', requestId);
  } else {
    if (deps.external === undefined) return toolError('external_unavailable', requestId);
    via = 'external';
    outcome = await deps.external(url.href, options, deps.signal);
    if (outcome.kind !== 'response') return toolError(externalFailureKey(outcome), requestId);
  }

  const truncated = outcome.bodyText.length > deps.bodyLimit;
  return {
    ok: true,
    operation: 'http_fetch',
    requestId,
    url: url.href,
    via,
    method,
    status: outcome.status,
    contentType: outcome.contentType,
    bodyText: truncated ? outcome.bodyText.slice(0, deps.bodyLimit) : outcome.bodyText,
    truncated,
    fetchedAt: deps.now(),
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface HttpFetchExecutorConfig {
  /** The pane's bridge, bound to the call's envelope. */
  readonly request: (
    envelope: HttpFetchRequest,
    url: string,
    options: BridgeRequestOptions,
  ) => Promise<BrokerOutcome>;
  readonly external: HttpFetchDeps['external'];
  readonly isConfiguredOrigin: (origin: string) => boolean;
  readonly currentContext: () => CurrentToolContext;
  readonly clock: () => number;
  readonly idGenerator: IdGenerator;
}

/**
 * Builds the `ToolExecutor` for `http_fetch`. The body limit and the text the
 * caller reads depend on who is asking - the model, or another tool through the
 * tool-to-tool bridge (which processes the body itself, so its text is only the
 * status line) - and the call's abort signal is handed to the anonymous fetch,
 * so the shared builder is assembled per call.
 */
export function createHttpFetchExecutor(config: HttpFetchExecutorConfig): ToolExecutor {
  return (args, context) => {
    const nested = context.nested === true;
    const text = (result: HttpFetchSuccess): string =>
      nested ? statusLine(result) : renderHttpFetchSuccess(result);
    return createToolExecutor({
      operation: 'http_fetch',
      argsSchema: httpFetchArgsSchema,
      requestSchema: httpFetchRequestSchema,
      render: text,
      toPayload: (result): JsonValue => ({
        ...result,
        textResultForLlm: text(result),
        resultType: 'success',
      }),
      execute: (envelope: HttpFetchRequest, deps: { readonly origin: string }) =>
        executeHttpFetch(envelope, {
          origin: deps.origin,
          now: config.clock,
          viaBridge: (url, options) => config.request(envelope, url, options),
          external: config.external,
          isConfiguredOrigin: config.isConfiguredOrigin,
          bodyLimit: nested ? HTTP_FETCH_NESTED_BODY_LIMIT : HTTP_FETCH_MODEL_BODY_LIMIT,
          signal: context.signal,
        }),
      runtimeDeps: {},
      currentContext: config.currentContext,
      clock: config.clock,
      idGenerator: config.idGenerator,
      failureFallbackMessage: 'HTTP request failed',
    })(args, context);
  };
}
