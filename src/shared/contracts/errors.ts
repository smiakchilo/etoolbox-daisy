import { z } from 'zod';
import { requestIdSchema, type RequestId } from './ids';

/**
 * Error taxonomy shared by the tool boundary, the transport, and the agent
 * event stream (implementation-plan.md step 03).
 *
 * The codes are deliberately coarse. The plan's instruction is to "refine
 * categories only when supported by evidence", and its worked example is the
 * one that matters most in practice: a browser `TypeError: Failed to fetch`
 * is indistinguishable between DNS failure, a refused connection, a proxy
 * that dropped the tunnel, a TLS rejection, and an extension blocking the
 * request. Reporting that as `PROXY_ERROR` would send a user to rewrite proxy
 * settings that were never wrong. {@link classifyNetworkFailure} therefore
 * refuses to guess, and callers must supply positive evidence to get a
 * narrower code.
 */

export const TOOL_ERROR_CODES = [
  /** The agent's arguments failed validation. Not retryable as-is. */
  'INVALID_ARGUMENT',
  /** AEM understood the caller but the account lacks permission. */
  'NOT_AUTHORIZED',
  /** No usable AEM session; the user must sign in through the browser pane. */
  'AUTH_REQUIRED',
  /** The application's own policy refused the request before it was sent. */
  'ACCESS_DENIED',
  /** AEM reported that the requested resource does not exist. */
  'NOT_FOUND',
  /** A redirect left the configured origin, so the response was discarded. */
  'REDIRECT_BLOCKED',
  /** A response arrived but did not match the documented AEM shape. */
  'UNEXPECTED_RESPONSE',
  /** Transport failed with no evidence of a more specific cause. */
  'NETWORK_ERROR',
  /** Positive evidence of a proxy fault, such as a 407 or CONNECT failure. */
  'PROXY_ERROR',
  /** Positive evidence of a certificate or TLS handshake rejection. */
  'TLS_ERROR',
  /** The request passed its absolute deadline. */
  'TIMEOUT',
  /** Cancelled by the user, or by a chat/server switch. */
  'CANCELLED',
  /** The request was issued against configuration that has since changed. */
  'STALE_CONTEXT',
  /**
   * The session was not in a state that permits the operation - for example a
   * prompt sent while a turn is already in flight, or into a closed session.
   * Distinct from {@link ToolErrorCode} `ACCESS_DENIED`, which means policy
   * refused the request outright: this is a transient precondition, and the
   * identical request may succeed once the blocking condition clears.
   */
  'PRECONDITION_FAILED',
  /** The result could not be handed to the model because of its size. */
  'RESULT_TOO_LARGE_FOR_MODEL',
  /** The active agent's runtime is unusable, absent, or not signed in. */
  'AGENT_UNAVAILABLE',
  /** Reading or writing the application's own settings/history failed. */
  'STORAGE_ERROR',
  /** An existing SDK session could not be resumed. */
  'RESUME_FAILED',
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export const toolErrorCodeSchema = z.enum(TOOL_ERROR_CODES);

/**
 * What the user would have to do for the request to have a chance of
 * succeeding. Distinct from retryability: a timeout is retryable and needs no
 * user action, while `AUTH_REQUIRED` needs action and is pointless to retry
 * until that action is taken.
 */
export const REQUIRED_ACTIONS = [
  'none',
  'sign_in_to_aem',
  'sign_in_to_agent',
  'add_server',
  'select_server',
  'review_certificate',
  'check_proxy_settings',
  'reduce_result_size',
  'start_new_chat',
] as const;

export type RequiredAction = (typeof REQUIRED_ACTIONS)[number];

export const requiredActionSchema = z.enum(REQUIRED_ACTIONS);

/**
 * Maximum length of the human-readable message. Messages are built by this
 * application, never echoed verbatim from AEM or a model: remote content is
 * untrusted (requirements-decisions.md section 2) and an unbounded passthrough
 * is both a spoofing surface and a way to leak response content into logs.
 */
const MESSAGE_MAX_LENGTH = 500;

export const toolErrorSchema = z
  .object({
    code: toolErrorCodeSchema,
    /** Safe, application-authored text. Never raw remote content. */
    message: z.string().min(1).max(MESSAGE_MAX_LENGTH),
    requestId: requestIdSchema,
    /** Whether an identical retry could plausibly succeed unchanged. */
    retryable: z.boolean(),
    requiredAction: requiredActionSchema,
  })
  .strict();

export type ToolError = z.infer<typeof toolErrorSchema> & { readonly requestId: RequestId };

/**
 * Default retryability per code. A caller may override it when it has better
 * information (for example, a 503 carrying `Retry-After`), but the default is
 * what keeps behaviour consistent across the many places errors are built.
 */
const RETRYABLE_BY_DEFAULT: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>([
  'NETWORK_ERROR',
  'PROXY_ERROR',
  'TIMEOUT',
  'AGENT_UNAVAILABLE',
  'STORAGE_ERROR',
]);

const REQUIRED_ACTION_BY_CODE: Readonly<Record<ToolErrorCode, RequiredAction>> = {
  INVALID_ARGUMENT: 'none',
  NOT_AUTHORIZED: 'none',
  AUTH_REQUIRED: 'sign_in_to_aem',
  ACCESS_DENIED: 'none',
  NOT_FOUND: 'none',
  REDIRECT_BLOCKED: 'sign_in_to_aem',
  UNEXPECTED_RESPONSE: 'none',
  NETWORK_ERROR: 'none',
  PROXY_ERROR: 'check_proxy_settings',
  TLS_ERROR: 'review_certificate',
  TIMEOUT: 'none',
  CANCELLED: 'none',
  STALE_CONTEXT: 'none',
  PRECONDITION_FAILED: 'none',
  RESULT_TOO_LARGE_FOR_MODEL: 'reduce_result_size',
  AGENT_UNAVAILABLE: 'sign_in_to_agent',
  STORAGE_ERROR: 'none',
  RESUME_FAILED: 'start_new_chat',
};

export interface ToolErrorOverrides {
  readonly retryable?: boolean;
  readonly requiredAction?: RequiredAction;
}

/**
 * Builds a validated {@link ToolError}, applying the default retryability and
 * required action for the code unless explicitly overridden. Centralised so
 * that "is this retryable?" is answered the same way everywhere rather than
 * re-decided at each throw site.
 */
export function createToolError(
  code: ToolErrorCode,
  message: string,
  requestId: RequestId,
  overrides: ToolErrorOverrides = {},
): ToolError {
  return toolErrorSchema.parse({
    code,
    message,
    requestId,
    retryable: overrides.retryable ?? RETRYABLE_BY_DEFAULT.has(code),
    requiredAction: overrides.requiredAction ?? REQUIRED_ACTION_BY_CODE[code],
  });
}

/**
 * Evidence a caller can offer about *why* a transport attempt failed. Each
 * field must come from something actually observed - a status line, a
 * certificate validation callback, an abort signal - never from pattern
 * matching on an opaque error string.
 */
export interface NetworkFailureEvidence {
  /** A `407 Proxy Authentication Required` was received. */
  readonly proxyAuthenticationRequired?: boolean;
  /** The proxy refused, or failed to establish, the CONNECT tunnel. */
  readonly proxyTunnelFailed?: boolean;
  /** Certificate validation failed, as reported by the TLS layer itself. */
  readonly certificateRejected?: boolean;
  /** The application's own deadline elapsed. */
  readonly deadlineExceeded?: boolean;
  /** The request was aborted deliberately by the application or user. */
  readonly aborted?: boolean;
}

/**
 * Maps observed evidence to the narrowest *justified* code.
 *
 * With no evidence the answer is `NETWORK_ERROR`. That is the entire point:
 * the plan calls out that a bare `TypeError: Failed to fetch` does not prove a
 * proxy error, and this function is where that discipline is enforced instead
 * of being restated as a comment at each call site.
 */
export function classifyNetworkFailure(evidence: NetworkFailureEvidence = {}): ToolErrorCode {
  if (evidence.aborted === true) return 'CANCELLED';
  if (evidence.deadlineExceeded === true) return 'TIMEOUT';
  if (evidence.certificateRejected === true) return 'TLS_ERROR';
  if (evidence.proxyAuthenticationRequired === true || evidence.proxyTunnelFailed === true) {
    return 'PROXY_ERROR';
  }
  return 'NETWORK_ERROR';
}

/**
 * Maps an AEM HTTP status to a code.
 *
 * `401` is reported as `AUTH_REQUIRED` rather than `NOT_AUTHORIZED`: AEM
 * answers an unauthenticated request to a protected path with `401`, and the
 * remedy is signing in through the browser pane. `403` is a genuine
 * permission decision by AEM for an identity it already knows, so retrying or
 * re-authenticating will not help.
 */
export function classifyHttpStatus(status: number): ToolErrorCode {
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'NOT_AUTHORIZED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 407) return 'PROXY_ERROR';
  if (status === 408 || status === 504) return 'TIMEOUT';
  return 'UNEXPECTED_RESPONSE';
}
