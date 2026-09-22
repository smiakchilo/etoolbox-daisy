import { jsonValueSchema, type JsonValue } from '../../contracts';

/**
 * Classifies an HTTP response from AEM as usable JSON, or as one specific,
 * named failure (implementation-plan.md step 06: "Validate Content-Type, HTTP
 * status, and JSON shape. A 403 is not automatically a request to sign in
 * again; a 200 HTML login/error page is not JSON").
 *
 * Generic across every AEM read tool and free of I/O: it takes a plain input
 * struct rather than a live `fetch` `Response`, so it is exercisable under
 * plain vitest with a hand-built object. Whatever calls `fetch` for real reads
 * `response.status`/`headers`/`text()` and hands the results here.
 *
 * This function never throws: every branch returns a classified outcome.
 */

/** The plain, JSON-serializable shape a successful AEM response body must have. */
export type JsonObject = { readonly [key: string]: JsonValue };

/** Why a parsed JSON value, though syntactically valid, is not a usable resource body. */
export type JsonShapeKind = 'array' | 'null' | 'string' | 'number' | 'boolean';

export type AemResponseOutcome =
  | { readonly kind: 'ok'; readonly value: JsonObject }
  | { readonly kind: 'unauthorized' } // 401
  | { readonly kind: 'forbidden' } // 403 - never treated as "sign in again"
  | { readonly kind: 'not_found' } // 404
  | { readonly kind: 'bad_request' } // 400
  /**
   * 414 - the request URL exceeded what the server (or a proxy in front of it)
   * will accept. Named explicitly rather than falling into `unexpected_status`
   * because it is the one status that says "this exact request is too large to
   * ask", which is actionable (send fewer or shorter predicates) in a way a
   * generic unexpected status is not. It is emphatically not a licence to
   * retry the same request over POST or any other transport.
   */
  | { readonly kind: 'url_too_long' } // 414
  | { readonly kind: 'multiple_choices' } // 300 - Sling's too-many-results alternatives array
  | { readonly kind: 'redirected'; readonly location?: string } // other 3xx - likely IdP/SSO
  | { readonly kind: 'server_error'; readonly status: number } // 5xx
  | { readonly kind: 'unexpected_status'; readonly status: number } // any other status
  | { readonly kind: 'not_json_content_type'; readonly contentType: string | null }
  | { readonly kind: 'html_login_page' } // 200 + text/html - an SSO login page
  | { readonly kind: 'invalid_json'; readonly message: string }
  | { readonly kind: 'unexpected_json_shape'; readonly actualType: JsonShapeKind };

export interface AemResponseInput {
  readonly status: number;
  /** The raw `Content-Type` header value, or `null` if the response had none. */
  readonly contentType: string | null;
  readonly bodyText: string;
  /**
   * The `Location` header value on a redirect status, if present. Optional
   * (omitted, never `undefined`, per `exactOptionalPropertyTypes`) because a
   * redirect response is not guaranteed to carry one.
   */
  readonly location?: string;
}

/**
 * Extracts the bare MIME media type from a `Content-Type` header value,
 * discarding parameters and case. Per RFC 9110 §8.3, a parameter such as
 * `charset` describes how to interpret the payload, not what it is -
 * `application/json; charset=UTF-8` is exactly as much JSON as
 * `application/json` alone.
 */
function parseMediaType(contentType: string | null): string | null {
  if (contentType === null) return null;
  const withoutParameters = contentType.split(';')[0] ?? '';
  const mediaType = withoutParameters.trim().toLowerCase();
  return mediaType.length > 0 ? mediaType : null;
}

/**
 * True for `application/json` and any `+json` structured syntax suffix (RFC
 * 6839). Slightly more permissive than strictly necessary for AEM: every
 * accepted body still has to parse as JSON *and* be a plain object to reach
 * `ok`, so a non-JSON body cannot slip through merely by claiming a `+json`
 * type.
 */
function isJsonMediaType(mediaType: string | null): boolean {
  return mediaType === 'application/json' || (mediaType !== null && mediaType.endsWith('+json'));
}

/**
 * Judges a 200 response body: the one status where the payload might actually
 * be the requested resource. Every other status is classified by status code
 * alone and never reaches here.
 */
function classifyOkBody(contentType: string | null, bodyText: string): AemResponseOutcome {
  const mediaType = parseMediaType(contentType);

  // text/html is checked by name, ahead of the generic non-JSON case: an
  // SSO/gateway login page IS a syntactically ordinary webpage - never valid
  // JSON - so naming it lets a caller say "you are signed out" instead of a
  // generic parse failure.
  if (mediaType === 'text/html') return { kind: 'html_login_page' };
  if (!isJsonMediaType(mediaType)) {
    return { kind: 'not_json_content_type', contentType };
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(bodyText);
  } catch (error) {
    return {
      kind: 'invalid_json',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const parsedJson = jsonValueSchema.safeParse(candidate);
  if (!parsedJson.success) {
    return { kind: 'invalid_json', message: 'parsed value is not a valid JSON value' };
  }
  const value = parsedJson.data;

  // Sling's HTTP 300 alternatives body is a syntactically valid JSON ARRAY of
  // `.N.json` URL strings, not the resource - "did it parse as JSON?" is not
  // the same question as "is it the resource?". A bare scalar or `null` is
  // equally not a usable resource body, so every non-object shape is rejected
  // here, not only the array case.
  if (isJsonObjectShape(value)) {
    return { kind: 'ok', value };
  }
  if (Array.isArray(value)) return { kind: 'unexpected_json_shape', actualType: 'array' };
  if (value === null) return { kind: 'unexpected_json_shape', actualType: 'null' };
  if (typeof value === 'string') return { kind: 'unexpected_json_shape', actualType: 'string' };
  if (typeof value === 'number') return { kind: 'unexpected_json_shape', actualType: 'number' };
  return { kind: 'unexpected_json_shape', actualType: 'boolean' };
}

/** True for a plain JSON object: excludes arrays and `null`, both `typeof "object"`. */
function isJsonObjectShape(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Classifies a raw AEM HTTP response. Status is judged first and exhaustively:
 * every non-200 status is resolved to an outcome without ever looking at the
 * body, because an error page's `Content-Type` and body text describe the
 * error, not a resource, no matter what they claim.
 */
export function classifyAemResponse(input: AemResponseInput): AemResponseOutcome {
  const { status } = input;

  if (status === 401) return { kind: 'unauthorized' };
  if (status === 403) return { kind: 'forbidden' };
  if (status === 404) return { kind: 'not_found' };
  if (status === 400) return { kind: 'bad_request' };
  if (status === 414) return { kind: 'url_too_long' };
  // Sling's own DOS guard (SLING-2320) replies 300 with a JSON ARRAY of
  // alternative `.N.json` URLs once traversal would exceed `maximumResults`.
  if (status === 300) return { kind: 'multiple_choices' };
  if (status >= 300 && status < 400) {
    return input.location !== undefined
      ? { kind: 'redirected', location: input.location }
      : { kind: 'redirected' };
  }
  if (status >= 500) return { kind: 'server_error', status };
  if (status !== 200) return { kind: 'unexpected_status', status };

  return classifyOkBody(input.contentType, input.bodyText);
}
