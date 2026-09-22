import {
  AEM_BRIDGE_REQUEST_HEADERS,
  type AemBridgeFetchCommand,
  type AemBridgeHeader,
  type AemBridgeReply,
} from '../shared/contracts/aemBridge';

/**
 * The entire decision logic of the AEM preload bridge, extracted from
 * `aem-preload.ts` so it can be unit-tested without an Electron renderer.
 * The preload file itself is then only wiring: receive, call this, reply.
 *
 * Everything security-relevant about the bridge lives here, so the rules are
 * stated once, in the place they are enforced:
 *
 * - The request is issued with the document's own ambient credentials
 *   (`credentials: "same-origin"`). The bridge never reads `document.cookie`,
 *   never constructs an `Authorization` header, and never handles a token. It
 *   cannot: the AEM session cookie is HttpOnly, and this code never asks for
 *   it. The session is used, not obtained.
 * - The URL is re-checked against the document's origin here, not only in
 *   main. Main builds the URL and is trusted to build it correctly, but a bug
 *   there must not be sufficient to turn this bridge - which runs inside a
 *   document holding a live authenticated session - into a general-purpose
 *   cross-origin fetcher.
 * - Redirects are never followed (`redirect: "manual"`). An expired session
 *   answers with a bounce to the IdP; following it would send the request on
 *   to a different origin, and in the worst case hand an SSO flow a
 *   machine-driven client. Ordinary *navigation* is unaffected by this - the
 *   user's own browsing still follows redirects and still completes SSO
 *   normally. Only tool fetches are pinned to one origin.
 */
export interface BridgeFetchDeps {
  /** Injected so tests can drive every branch without a network. */
  readonly fetch: typeof globalThis.fetch;
  /** The document's own origin, i.e. `location.origin`. */
  readonly currentOrigin: string;
}

export async function performBridgeFetch(
  command: AemBridgeFetchCommand,
  deps: BridgeFetchDeps,
  signal: AbortSignal,
): Promise<AemBridgeReply> {
  const { requestId } = command;

  let target: URL;
  try {
    target = new URL(command.url);
  } catch {
    return { kind: 'blocked', requestId, reason: 'invalid_url' };
  }

  // Compared against the live document origin, so a request issued before a
  // navigation cannot be executed after one that changed origin.
  if (target.origin !== deps.currentOrigin) {
    return { kind: 'blocked', requestId, reason: 'cross_origin' };
  }

  let response: Response;
  try {
    response = await deps.fetch(target.toString(), {
      credentials: 'same-origin',
      // `manual` rather than `error`: both refuse to follow the redirect, but
      // `error` collapses into a generic TypeError indistinguishable from a
      // connection failure, whereas `manual` yields an inspectable
      // opaque-redirect response. The difference matters because "your session
      // expired" and "the server is unreachable" need different answers.
      redirect: 'manual',
      cache: 'no-store',
      // Asking for JSON explicitly gives a well-behaved SSO gateway the chance
      // to answer 401 instead of an HTML login page - a far more actionable
      // result. Safe to send on a same-origin request: it triggers no preflight.
      headers: { ...AEM_BRIDGE_REQUEST_HEADERS },
      signal,
    });
  } catch (error) {
    // An abort surfaces here as an exception; it is a cancellation, not a
    // failure, and must not be reported as one.
    if (signal.aborted) return { kind: 'cancelled', requestId };
    return {
      kind: 'network_error',
      requestId,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // `opaqueredirect` is what `redirect: "manual"` produces when the server
  // answered 3xx. Its status is 0 and its body is empty by specification, so
  // it must be recognised by type before any attempt to read it - otherwise it
  // would be reported as an empty 0-status response rather than as the
  // session-expiry signal it actually is.
  if (response.type === 'opaqueredirect' || response.status === 0) {
    return { kind: 'blocked', requestId, reason: 'redirect_blocked' };
  }

  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (error) {
    if (signal.aborted) return { kind: 'cancelled', requestId };
    return {
      kind: 'network_error',
      requestId,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // Read but never interpreted here: classification is main's job
  // (`classifyAemResponse`), so that exactly one component decides what counts
  // as a usable resource.
  return {
    kind: 'response',
    requestId,
    status: response.status,
    contentType: response.headers.get('content-type'),
    bodyText,
    headers: readableHeaders(response.headers),
  };
}

/**
 * Flattens a `Headers` object to the array main logs. Only *readable* headers
 * are obtainable: `Set-Cookie` (and `Set-Cookie2`) are browser-forbidden
 * response-header names, filtered out by the fetch implementation before this
 * code ever sees them, so the AEM session cookie cannot be reported here even
 * if something upstream tried to. Iteration order and duplicate handling are
 * whatever the `Headers` object gives - this does not re-combine or sort.
 */
function readableHeaders(headers: Headers): AemBridgeHeader[] {
  return [...headers].map(([name, value]) => ({ name, value }));
}
