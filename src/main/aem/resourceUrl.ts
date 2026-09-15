import { err, ok, type Result } from '../../shared/result';
import { parseJcrPath, type JcrPathRejectionReason } from '../../shared/contracts/toolContracts';
import { parseOrigin } from '../../shared/contracts/origin';

/**
 * Builds the canonical same-origin Sling JSON resource URL for a tool call
 * (implementation-plan.md step 06: "The application constructs a canonical
 * same-origin JSON resource URL... do not insert a complete agent-supplied
 * URL"). The agent supplies a server-relative JCR `path`; this module is the
 * only thing that turns that path into an actual request URL. It never
 * accepts a whole URL from the agent, and it never lets the path decide the
 * host, scheme, extension, or recursion depth.
 *
 * Sling facts this module relies on (verified against
 * `org.apache.sling.servlets.get.impl.helpers.JsonRenderer` /
 * `util.ResourceTraversor`, not re-derived here):
 * - A bare `.json` defaults to `maxRecursionLevels=0` (own properties only) -
 *   i.e. `.json` and `.0.json` are the same request.
 * - `.1.json` adds the immediate children, with no further recursion.
 * - `infinity`/`-1` both mean unbounded recursion (rejected upstream by
 *   `parseJcrPath`, which this module reuses rather than re-validating).
 */

export type BuildResourceUrlError =
  | { readonly kind: 'invalid_path'; readonly reason: JcrPathRejectionReason }
  | { readonly kind: 'invalid_origin' }
  /**
   * `encodeURIComponent` throws `URIError` on a lone UTF-16 surrogate (half
   * of a surrogate pair with no partner). `parseJcrPath` does not reject
   * this - it only rejects control characters and structural metacharacters,
   * and a lone surrogate is neither - so a path can pass that validation and
   * still be un-encodable as a URL. This is reported explicitly rather than
   * letting the exception propagate, matching the "never throw at a trust
   * boundary" posture used throughout this layer.
   */
  | { readonly kind: 'unencodable_path' }
  /**
   * The "validate one string, request another" defence: after composing the
   * URL, it is re-parsed and checked against exactly what was intended. If
   * anything about the composed string was not what `URL` reports back -
   * origin, pathname, query, or fragment - the URL is refused rather than
   * used, even though every individual step above believes it did the right
   * thing. This is what actually catches a *future* gap between "what was
   * validated" and "what will be requested", which is the class of bug a
   * step-by-step review cannot rule out by itself.
   */
  | { readonly kind: 'path_not_preserved' };

export interface BuildResourceUrlOptions {
  /** A previously-validated server origin (see `parseOrigin`), never a full page URL. */
  readonly origin: string;
  /** The agent-supplied JCR path. Validated here with `parseJcrPath`; never trusted as-is. */
  readonly path: string;
  /** `true` requests the immediate children too (Sling depth 1); `false` requests depth 0 (own properties only). */
  readonly includeChildren: boolean;
}

/**
 * Percent-encodes one path segment for use in a URL. Segments are encoded
 * individually (never the path as a whole) so a literal `/` inside a
 * segment - which cannot occur once `parseJcrPath` has accepted the path,
 * but would be catastrophic if it ever did - can never be reinterpreted as a
 * path separator.
 *
 * `encodeURIComponent` deliberately leaves `.` unescaped. That is required,
 * not incidental: `parseJcrPath` has already rejected every dot that could
 * be a Sling selector or a dot-terminated segment, so any `.` reaching here
 * is part of a legitimate node name (e.g. `my.file.pdf`) and must survive
 * unchanged. Namespaced names (`jcr:content`, `cq:Page`) keep their meaning
 * too: `:` is not in `encodeURIComponent`'s unescaped set, so it becomes
 * `%3A`, which the servlet container decodes back to `:` - the round trip
 * preserves the name without ever handing the agent a way to inject a URL
 * scheme (`scheme://...`) through a path segment.
 *
 * Throws `URIError` for a lone surrogate; callers must catch it (see
 * `unencodable_path` above) rather than letting it escape as an unhandled
 * exception at the tool boundary.
 */
function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment);
}

/**
 * Constructs a canonical, same-origin Sling JSON resource URL from an
 * application-validated origin and an agent-supplied JCR path.
 *
 * `options.path` is decoded exactly once - reproducing the single
 * `decodeURIComponent` pass `parseJcrPath` performed - and the result is then
 * percent-encoded per segment. That is what `parseJcrPath`'s caller contract
 * requires, and it is the only arrangement in which the string that was
 * validated and the string that is requested are the same string. Encoding
 * the raw candidate instead would double-encode an already-encoded path
 * (`/content/caf%C3%A9` would address a node literally named `caf%C3%A9`),
 * quietly asking for something other than what was validated; decoding twice
 * would let a `%252E`-style sequence become a `.` after validation had
 * already passed it.
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
  // server-side default the application does not control, instead of being
  // self-describing on the wire exactly as this module intended it.
  const depthSelector = options.includeChildren ? '1' : '0';

  let encodedSegments: readonly string[];
  try {
    // `parseJcrPath` has already rejected malformed percent-encoding, so this
    // decode cannot throw for an accepted path; it stays inside the `try`
    // because the encode below genuinely can (a lone surrogate), and because
    // relying on that ordering argument alone would be fragile.
    //
    // Splitting AFTER decoding is deliberate. A `%2F` therefore becomes a real
    // separator rather than a literal character inside one segment - which is
    // correct, because `parseJcrPath` judged that same decoded string, and
    // applied its traversal and metacharacter rules to those same separators.
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

  // Belt and braces: re-derive the intended pieces from what `URL` actually
  // parsed, and refuse to hand back a URL unless every one of them matches
  // exactly. `url.origin` must still be the validated server origin (nothing
  // in the path can smuggle a different host); `url.pathname` must be byte-
  // identical to the pathname just composed (nothing was normalised,
  // collapsed, or reinterpreted); `search`/`hash` must be empty (nothing in
  // the path became a query or fragment on the way through `URL`).
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
