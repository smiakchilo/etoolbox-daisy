import type { ToolRequestEnvelope } from '../../shared/contracts/toolContracts';
import type { RequestId } from '../../shared/contracts/ids';
import type { RequiredAction, ToolErrorCode } from '../../shared/contracts/errors';
import type { ToolResult } from '../../shared/contracts/toolResult';
import type { AemResponseOutcome } from './responseValidation';
import { classifyAemResponse } from './responseValidation';
import type { BrokerOutcome } from './bridgeBroker';
import { buildResourceUrl } from './resourceUrl';
import { projectGetJsonResult } from './getJsonProjection';

/**
 * Composes the `aem_get_json` tool (implementation-plan.md step 06) out of the
 * four single-purpose modules that surround it: `buildResourceUrl` turns a
 * validated JCR path into a request, the broker performs it through the AEM
 * view's session, `classifyAemResponse` decides what came back, and
 * `getJsonProjection` shapes a success for the model. This module adds no new
 * judgement about URLs, HTTP, or JSON - it only decides what each of their
 * verdicts means *to the agent*.
 *
 * That decision is a genuine one, because a tool error has to answer three
 * separate questions, and the interesting cases disagree on them:
 *
 * - which `ToolErrorCode` names what happened,
 * - whether an identical retry could plausibly work (`retryable`),
 * - and what the *user* would have to do (`requiredAction`).
 *
 * A 403 is the case the plan calls out by name: it is emphatically not a
 * request to sign in again. A session that is correctly signed in can still
 * be denied a specific node by AEM's own ACLs, and telling that user to sign
 * in would be wrong rather than merely vague. So 403 maps to
 * `NOT_AUTHORIZED` with `requiredAction: "none"`, while 401 and a 200 HTML
 * login page - which really do mean "no usable session" - map to
 * `AUTH_REQUIRED` with `sign_in_to_aem`.
 */

/**
 * Every message this module can produce, as a fixed table of
 * application-authored strings.
 *
 * Nothing here is derived from the response. That is a hard rule, not a
 * stylistic one: `invalid_json`'s underlying parser message can quote a
 * fragment of the body, and a redirect's `Location` is entirely
 * attacker-controllable if AEM is compromised or spoofed. Either would put
 * remote text into the model's context and into logs, which
 * requirements-decisions.md section 2 forbids. Keeping the strings in one
 * closed table makes "no remote content in an error" checkable by reading a
 * single object rather than auditing every branch.
 */
const ERROR_MESSAGES = {
  invalid_path: 'The requested path is not a valid JCR path.',
  invalid_origin: 'The current server address could not be used to build a request.',
  unencodable_path: 'The requested path contains characters that cannot be encoded in a URL.',
  path_not_preserved: 'The request URL could not be built safely for that path.',
  cross_origin: 'The request was refused because it would have left the current server.',
  redirect_blocked:
    'AEM redirected the request away from the server, which usually means the session has expired.',
  /**
   * The same fact as `redirect_blocked`, reached by the other of two possible
   * routes. `redirect: "manual"` normally means a redirect never becomes a
   * readable response at all, so the preload reports it as a block; but if a
   * 3xx ever does arrive as a real response, it means exactly the same thing
   * and must not fall through to a vaguer code.
   */
  redirected:
    'AEM redirected the request away from the server, which usually means the session has expired.',
  no_view: 'The AEM browser pane is not available, so no request could be made.',
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

/**
 * The one place each failure's three answers are decided together.
 *
 * `retryable` here means "could the *identical* request succeed if repeated",
 * which is deliberately narrower than "is this recoverable". A timeout or a
 * 5xx can genuinely succeed unchanged, so both are retryable. A 403 or a 404
 * cannot - the agent must change something - even though a user action might
 * eventually make them succeed. Keeping the two notions separate is what
 * stops an agent from looping on an error that will never resolve by itself.
 */
const ERROR_MAPPINGS: Readonly<Record<ErrorMessageKey, ErrorMapping>> = {
  invalid_path: { code: 'INVALID_ARGUMENT', retryable: false, requiredAction: 'none' },
  invalid_origin: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'select_server' },
  unencodable_path: { code: 'INVALID_ARGUMENT', retryable: false, requiredAction: 'none' },
  path_not_preserved: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'none' },
  cross_origin: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'none' },
  // Not retryable: repeating the request cannot resolve an expired session,
  // and an agent that retries a redirect loop learns nothing. The user has to
  // sign in in the browser pane first.
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
  // Retryable because a fresh request would be stamped with the current
  // context and would simply be the right request; nothing the user must do.
  stale_server_revision: { code: 'STALE_CONTEXT', retryable: true, requiredAction: 'none' },
  stale_navigation_epoch: { code: 'STALE_CONTEXT', retryable: true, requiredAction: 'none' },
  unauthorized: { code: 'AUTH_REQUIRED', retryable: false, requiredAction: 'sign_in_to_aem' },
  // The rule this module exists to get right: authenticated but not permitted.
  // `requiredAction: "none"` because signing in again would change nothing.
  forbidden: { code: 'NOT_AUTHORIZED', retryable: false, requiredAction: 'none' },
  not_found: { code: 'NOT_FOUND', retryable: false, requiredAction: 'none' },
  bad_request: { code: 'INVALID_ARGUMENT', retryable: false, requiredAction: 'none' },
  // Not retryable and no user action: the request, not the server or the
  // session, is what has to change. `INVALID_ARGUMENT` says that plainly.
  url_too_long: { code: 'INVALID_ARGUMENT', retryable: false, requiredAction: 'none' },
  // Sling's 300 means the traversal exceeded its own `maximumResults` guard.
  // `reduce_result_size` is actionable advice the agent can act on directly -
  // re-requesting without children usually succeeds - which a bare
  // "unexpected response" would not be.
  multiple_choices: {
    code: 'RESULT_TOO_LARGE_FOR_MODEL',
    retryable: false,
    requiredAction: 'reduce_result_size',
  },
  // Retryable: a 5xx is frequently transient, and unlike the 4xx cases the
  // agent has nothing to correct.
  server_error: { code: 'UNEXPECTED_RESPONSE', retryable: true, requiredAction: 'none' },
  unexpected_status: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  not_json_content_type: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  html_login_page: { code: 'AUTH_REQUIRED', retryable: false, requiredAction: 'sign_in_to_aem' },
  invalid_json: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
  unexpected_json_shape: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
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

/** Maps a broker verdict to the message table key, or to the body it produced. */
function brokerOutcomeKey(outcome: BrokerOutcome): ErrorMessageKey | undefined {
  switch (outcome.kind) {
    case 'response':
      return undefined;
    case 'blocked':
      // `invalid_url` cannot be reached from a URL this application built and
      // then round-tripped through `URL` itself, so it is folded into the same
      // refusal as `cross_origin` rather than given a message of its own: both
      // mean the bridge declined to issue the request as addressed.
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

/** Maps a response classification to the message table key; `undefined` means it was usable. */
function responseOutcomeKey(outcome: AemResponseOutcome): ErrorMessageKey | undefined {
  return outcome.kind === 'ok' ? undefined : outcome.kind;
}

/**
 * The single member of the `ToolRequestEnvelope` union this handler serves.
 * `Extract` rather than an intersection: the envelope is discriminated on
 * `operation`, so intersecting it with an args type would ask every member -
 * including `aem_query`, whose args are a different shape - to satisfy both at
 * once, which nothing can.
 */
export type AemGetJsonRequest = Extract<ToolRequestEnvelope, { operation: 'aem_get_json' }>;

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
  const brokerKey = brokerOutcomeKey(brokerOutcome);
  if (brokerKey !== undefined) {
    return toolError(brokerKey, envelope.requestId);
  }
  if (brokerOutcome.kind !== 'response') {
    // Unreachable: `brokerOutcomeKey` returns `undefined` only for a response.
    // Narrowing explicitly rather than asserting keeps this file free of casts.
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

  return projectGetJsonResult({
    data: classified.value,
    args,
    requestId: envelope.requestId,
    sourceOrigin: deps.origin,
    serverRevision: envelope.serverRevision,
    fetchedAt: deps.now(),
  });
}
