import { jsonValueSchema, type JsonValue } from '../../shared/contracts/agentEvents';

/**
 * Classifies an HTTP response from AEM as usable JSON, or as one specific,
 * named failure (implementation-plan.md step 06: "Validate Content-Type,
 * HTTP status, and JSON shape. A 403 is not automatically a request to sign
 * in again; a 200 HTML login/error page is not JSON").
 *
 * Takes a plain input struct rather than a live `fetch` `Response` so this
 * module has zero I/O and no DOM/Electron dependency: `src/main` compiles
 * against `lib: ["ES2023"]` only (see `tsconfig.base.json`), and this file
 * must be exercisable under plain vitest with a hand-built object, not a
 * real network round trip. Whatever calls `fetch` for real is a separate,
 * impure piece that reads `response.status`/`response.headers`/
 * `await response.text()` and hands the results here - deliberately not
 * written in this file, so that boundary stays this module's only contract.
 *
 * This function never throws: every branch below returns a classified
 * outcome, including the parse-failure and wrong-shape cases, so a caller
 * can always render *something specific* to the user instead of an
 * unexpected-error path.
 */

/** The plain, JSON-serializable shape a successful `aem_get_json`/`aem_query` response body must have. */
export type JsonObject = { readonly [key: string]: JsonValue };

/** Why a parsed JSON value, though syntactically valid, is not a usable resource body. */
export type JsonShapeKind = 'array' | 'null' | 'string' | 'number' | 'boolean';

export type AemResponseOutcome =
  | { readonly kind: 'ok'; readonly value: JsonObject }
  | { readonly kind: 'unauthorized' } // 401
  | { readonly kind: 'forbidden' } // 403 - see the dedicated comment below; never treated as "sign in again"
  | { readonly kind: 'not_found' } // 404
  | { readonly kind: 'bad_request' } // 400 - e.g. Sling rejected an invalid recursion selector
  /**
   * 414 - the request URL exceeded what the server (or a proxy in front of
   * it) will accept. Named explicitly rather than falling into
   * `unexpected_status` because step 08 requires it to be reported as itself:
   * it is the one status that says "this exact query is too large to ask",
   * which is actionable (send fewer or shorter predicates) in a way that a
   * generic unexpected status is not. It is emphatically not a licence to
   * retry the same query over POST or any other transport.
   */
  | { readonly kind: 'url_too_long' } // 414
  | { readonly kind: 'multiple_choices' } // 300 - Sling's too-many-results alternatives array, not the resource
  | { readonly kind: 'redirected'; readonly location?: string } // other 3xx - likely an IdP/SSO redirect
  | { readonly kind: 'server_error'; readonly status: number } // 5xx
  | { readonly kind: 'unexpected_status'; readonly status: number } // any other status
  | { readonly kind: 'not_json_content_type'; readonly contentType: string | null }
  | { readonly kind: 'html_login_page' } // 200 + text/html - an SSO login page masquerading as success
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
 * `charset` describes how to interpret the payload, not what the payload
 * is - `application/json; charset=UTF-8` is exactly as much JSON as
 * `application/json` alone, and checking the raw header string for equality
 * would reject the single most common real-world spelling of a JSON
 * response.
 */
function parseMediaType(contentType: string | null): string | null {
  if (contentType === null) return null;
  const withoutParameters = contentType.split(';')[0] ?? '';
  const mediaType = withoutParameters.trim().toLowerCase();
  return mediaType.length > 0 ? mediaType : null;
}

/**
 * True for `application/json` and any `+json` structured syntax suffix (RFC
 * 6839), e.g. `application/problem+json`. Sling's own JSON servlet only ever
 * emits plain `application/json`, so this is slightly more permissive than
 * strictly necessary for AEM itself - chosen deliberately anyway, because
 * the permissiveness cannot weaken anything below: every accepted body still
 * has to parse as JSON *and* be a plain object to reach `ok`, so a non-JSON
 * body cannot slip through merely by claiming a `+json` type. Being
 * narrower here would only risk misclassifying a legitimate JSON error
 * wrapper from something in front of AEM (a reverse proxy, a WAF) as
 * `not_json_content_type` instead of parsing it and judging its actual
 * shape - a worse failure mode for no security benefit.
 */
function isJsonMediaType(mediaType: string | null): boolean {
  return mediaType === 'application/json' || (mediaType !== null && mediaType.endsWith('+json'));
}

/**
 * Judges a 200 response body: the one status where the payload might
 * actually be the requested resource. Every other status is classified by
 * status code alone in {@link classifyAemResponse} and never reaches here,
 * because a non-2xx response's body describes an error page, not data,
 * regardless of what its `Content-Type` claims.
 */
function classifyOkBody(contentType: string | null, bodyText: string): AemResponseOutcome {
  const mediaType = parseMediaType(contentType);

  // text/html is checked by name, ahead of the generic non-JSON case: an
  // SSO/gateway login or error page IS a syntactically ordinary webpage -
  // never valid JSON - so naming it lets a caller say "you are signed out"
  // instead of a generic parse failure. Any other non-JSON content type
  // (missing header, text/plain, application/xml, ...) has no equally
  // specific explanation available, so it stays the generic
  // `not_json_content_type`.
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

  // Re-uses the shared `JsonValue` schema (agentEvents.ts) instead of a type
  // assertion: `JSON.parse` already guarantees a JSON-serializable result,
  // so this should never actually fail, but going through the schema keeps
  // `value` genuinely typed as `JsonValue` with no `as`/cast anywhere in
  // this file, matching the JSON.parse -> zod pattern `toolResult.ts` uses
  // for the same reason.
  const parsedJson = jsonValueSchema.safeParse(candidate);
  if (!parsedJson.success) {
    return { kind: 'invalid_json', message: 'parsed value is not a valid JSON value' };
  }
  const value = parsedJson.data;

  // The trap this module exists to catch: Sling's HTTP 300 alternatives body
  // is a syntactically valid JSON ARRAY of `.N.json` URL strings, not the
  // resource - "did it parse as JSON?" is not the same question as "is it
  // the resource?". A bare scalar or `null` is equally not a usable
  // resource body, so every non-object shape is rejected here, not only the
  // array case. Checked via an explicit type predicate rather than negative
  // narrowing after `Array.isArray`: TypeScript does not narrow a `readonly
  // T[]` union member out through `Array.isArray` alone, so relying on that
  // would leave `value`'s static type still including the array branch on
  // the `ok` path below.
  if (isJsonObjectShape(value)) {
    return { kind: 'ok', value };
  }
  if (Array.isArray(value)) return { kind: 'unexpected_json_shape', actualType: 'array' };
  if (value === null) return { kind: 'unexpected_json_shape', actualType: 'null' };
  if (typeof value === 'string') return { kind: 'unexpected_json_shape', actualType: 'string' };
  if (typeof value === 'number') return { kind: 'unexpected_json_shape', actualType: 'number' };
  return { kind: 'unexpected_json_shape', actualType: 'boolean' };
}

/** True for a plain JSON object: excludes arrays and `null`, both of which are also `typeof "object"`. */
function isJsonObjectShape(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Classifies a raw AEM HTTP response. Status is judged first and
 * exhaustively: every non-200 status is resolved to an outcome without ever
 * looking at the body, because an error page's `Content-Type` and body text
 * describe the error, not a resource, no matter what they claim.
 */
export function classifyAemResponse(input: AemResponseInput): AemResponseOutcome {
  const { status } = input;

  if (status === 401) return { kind: 'unauthorized' };
  // Deliberately distinct from `unauthorized`: the plan calls this out by
  // name ("A 403 is not automatically a request to sign in again"). A
  // session that is already correctly signed in can still be denied by
  // AEM's own ACLs for a specific node - telling an authenticated user to
  // sign in again would be actively wrong, not merely imprecise, for that
  // case.
  if (status === 403) return { kind: 'forbidden' };
  if (status === 404) return { kind: 'not_found' };
  if (status === 400) return { kind: 'bad_request' };
  // Checked ahead of the generic ranges below so it keeps its own name: a 414
  // means the query itself was too long to send, which the agent can act on,
  // whereas `unexpected_status: 414` would tell it nothing.
  if (status === 414) return { kind: 'url_too_long' };
  // Sling's own DOS guard (SLING-2320) replies 300 with a JSON ARRAY of
  // alternative `.N.json` URLs once traversal would exceed
  // `maximumResults` - classified by status alone, never by inspecting a
  // body that would otherwise look like valid JSON data.
  if (status === 300) return { kind: 'multiple_choices' };
  if (status >= 300 && status < 400) {
    // A redirect other than Sling's 300 is most plausibly an IdP/SSO
    // redirect, not a resource. `location` is included only when present
    // (`exactOptionalPropertyTypes`): the caller must not assume every
    // redirect carries one.
    return input.location !== undefined
      ? { kind: 'redirected', location: input.location }
      : { kind: 'redirected' };
  }
  if (status >= 500) return { kind: 'server_error', status };
  if (status !== 200) return { kind: 'unexpected_status', status };

  return classifyOkBody(input.contentType, input.bodyText);
}
