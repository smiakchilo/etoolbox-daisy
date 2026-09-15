import type { ToolRequestEnvelope } from '../../shared/contracts/toolContracts';
import type { RequestId } from '../../shared/contracts/ids';
import type { RequiredAction, ToolErrorCode } from '../../shared/contracts/errors';
import type { ToolResult } from '../../shared/contracts/toolResult';
import type { AemResponseOutcome } from './responseValidation';
import { classifyAemResponse } from './responseValidation';
import type { BrokerOutcome } from './bridgeBroker';
import { buildQueryUrl } from './queryUrl';
import { readQueryEnvelope } from './queryResponse';
import { projectQueryResult } from './queryProjection';

/**
 * Composes the `aem_query` tool (implementation-plan.md step 08) out of the
 * same four-stage pipeline `aemGetJson.ts` uses - build a URL, fetch it
 * through the browser session, classify the HTTP response, project a success
 * - with one stage the get-json path does not need: reading QueryBuilder's
 * own `success` envelope out of an otherwise perfectly healthy HTTP 200.
 *
 * The executor order is load-bearing and matches `aem_get_json`: validate and
 * build before anything leaves the process, so a rejected predicate or a
 * reserved-parameter collision costs no request at all.
 */

const ERROR_MESSAGES = {
  invalid_origin: 'The current server address could not be used to build a request.',
  reserved_parameter: 'A QueryBuilder output-control parameter was supplied as a search predicate.',
  unencodable_predicate: 'A predicate contains characters that cannot be encoded in a URL.',
  query_not_preserved: 'The query URL could not be built safely for those predicates.',
  cross_origin: 'The request was refused because it would have left the current server.',
  redirect_blocked:
    'AEM redirected the request away from the server, which usually means the session has expired.',
  redirected:
    'AEM redirected the request away from the server, which usually means the session has expired.',
  no_view: 'The AEM browser pane is not available, so no request could be made.',
  network_error: 'The request to AEM could not be completed.',
  cancelled: 'The request was cancelled.',
  timeout: 'AEM did not respond before the request deadline.',
  stale_server_revision: 'The server configuration changed while the request was in flight.',
  stale_navigation_epoch: 'The browser left the page this request was made for.',
  unauthorized: 'AEM did not accept the current session. Sign in again in the browser pane.',
  forbidden: 'The current AEM account is not permitted to run that query.',
  not_found: 'AEM reports that the QueryBuilder endpoint does not exist on this instance.',
  bad_request: 'AEM rejected the query as malformed.',
  multiple_choices: 'AEM refused to return that result because it has too many nodes to traverse.',
  url_too_long:
    'The query URL was too long for AEM to accept. Send fewer or shorter predicates; ' +
    'the query cannot be retried by another method.',
  server_error: 'AEM returned a server error.',
  unexpected_status: 'AEM returned an unexpected status for that query.',
  not_json_content_type: 'AEM returned a response that was not JSON.',
  html_login_page:
    'AEM returned a sign-in page instead of data. Sign in again in the browser pane.',
  invalid_json: 'AEM returned a response that could not be parsed as JSON.',
  unexpected_json_shape: 'AEM returned JSON that was not a QueryBuilder result object.',
  /**
   * The message this module exists for. It says the query was *rejected*,
   * never that it matched nothing - an agent told "no results" stops looking,
   * while an agent told the server refused the query fixes the predicate.
   */
  query_rejected:
    'AEM rejected the query. One of the predicates was not accepted by this instance - ' +
    'check the predicate names and values. This is not an empty result.',
  malformed_envelope: 'AEM returned a QueryBuilder response without a usable result set.',
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
  invalid_json: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  unexpected_json_shape: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  // A server-side rejection, per step 08 ("A custom predicate rejected by the
  // server produces a server error"). Not retryable: the identical query will
  // be rejected identically until the agent changes a predicate.
  query_rejected: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  malformed_envelope: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
};

function toolError(key: ErrorMessageKey, requestId: RequestId): ToolResult {
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

function brokerOutcomeKey(outcome: BrokerOutcome): ErrorMessageKey | undefined {
  switch (outcome.kind) {
    case 'response':
      return undefined;
    case 'blocked':
      return outcome.reason === 'redirect_blocked' ? 'redirect_blocked' : 'cross_origin';
    case 'network_error':
      return 'network_error';
    case 'cancelled':
      return 'cancelled';
    case 'timeout':
      return 'timeout';
    case 'stale':
      return outcome.status;
    case 'no_view':
      return 'no_view';
  }
}

function responseOutcomeKey(outcome: AemResponseOutcome): ErrorMessageKey | undefined {
  return outcome.kind === 'ok' ? undefined : outcome.kind;
}

export type AemQueryRequest = Extract<ToolRequestEnvelope, { operation: 'aem_query' }>;

export interface AemQueryDeps {
  /** The origin of the server the query is addressed to. */
  readonly origin: string;
  /** Performs the bridge round trip. Injected so this composition is testable without Electron. */
  readonly fetchThroughBridge: (url: string) => Promise<BrokerOutcome>;
  /** Wall-clock time stamped onto a successful result. */
  readonly now: () => number;
}

export async function executeAemQuery(
  envelope: AemQueryRequest,
  deps: AemQueryDeps,
): Promise<ToolResult> {
  const args = envelope.args;
  const built = buildQueryUrl({
    origin: deps.origin,
    predicates: args.predicates,
    offset: args.offset,
    limit: args.limit,
    properties: args.properties,
  });
  if (!built.ok) {
    return toolError(built.error.kind, envelope.requestId);
  }

  const brokerOutcome = await deps.fetchThroughBridge(built.value.url);
  const brokerKey = brokerOutcomeKey(brokerOutcome);
  if (brokerKey !== undefined) {
    return toolError(brokerKey, envelope.requestId);
  }
  if (brokerOutcome.kind !== 'response') {
    return toolError('network_error', envelope.requestId);
  }

  const classified = classifyAemResponse({
    status: brokerOutcome.status,
    contentType: brokerOutcome.contentType,
    bodyText: brokerOutcome.bodyText,
  });
  const responseKey = responseOutcomeKey(classified);
  if (responseKey !== undefined) {
    return toolError(responseKey, envelope.requestId);
  }
  if (classified.kind !== 'ok') {
    return toolError('unexpected_json_shape', envelope.requestId);
  }

  // The stage `aem_get_json` has no equivalent of. Everything above has
  // already agreed the response is healthy; only this call can tell a
  // rejected query from an empty one.
  const envelopeOutcome = readQueryEnvelope({ body: classified.value, offset: args.offset });
  if (envelopeOutcome.kind !== 'ok') {
    return toolError(envelopeOutcome.kind, envelope.requestId);
  }

  return projectQueryResult({
    envelope: envelopeOutcome.value,
    args,
    projectedProperties: built.value.projectedProperties,
    requestId: envelope.requestId,
    sourceOrigin: deps.origin,
    serverRevision: envelope.serverRevision,
    fetchedAt: deps.now(),
  });
}
