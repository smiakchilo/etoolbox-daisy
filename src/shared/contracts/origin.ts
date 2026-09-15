import { z } from 'zod';

/**
 * Canonical AEM origin handling (implementation-plan.md step 03,
 * requirements-decisions.md section 3).
 *
 * An origin identifies *a server*, not *a page*. The plan is explicit that a
 * full login-form URL must never be stored as a setting, and that nonstandard
 * reverse-proxy path prefixes are deferred - AEM's APIs are addressed from the
 * root of the origin (`https://author.example/bin/querybuilder.json`). So the
 * stored value is reduced to exactly scheme, host and port, and anything that
 * would smuggle extra meaning is rejected rather than quietly stripped.
 *
 * Userinfo (`https://user:pass@host`) is rejected outright rather than
 * removed. Silently dropping it would turn a credential the user believed they
 * had configured into a request that omits it, and would put a password into
 * settings storage on the way. Rejecting makes the mistake visible.
 */

/** Reasons {@link parseOrigin} can refuse a candidate string. */
export const ORIGIN_REJECTION_REASONS = [
  'malformed',
  'unsupported_scheme',
  'contains_userinfo',
  'contains_path',
  'contains_query',
  'contains_fragment',
  'missing_host',
] as const;

export type OriginRejectionReason = (typeof ORIGIN_REJECTION_REASONS)[number];

export type ParseOriginResult =
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly reason: OriginRejectionReason };

/**
 * Normalizes a user-entered server address to a canonical origin.
 *
 * Canonical means: lowercase scheme and host, an explicit port only when it is
 * not the scheme's default, and no trailing slash. Two entries for the same
 * server must produce byte-identical strings, because origin equality is what
 * the bridge uses to decide whether the browser is currently on the server a
 * tool call is allowed to touch.
 */
export function parseOrigin(candidate: string): ParseOriginResult {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'malformed' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'contains_userinfo' };
  }
  if (url.hostname === '') return { ok: false, reason: 'missing_host' };
  if (url.search !== '') return { ok: false, reason: 'contains_query' };
  // `URL` drops a bare "#", so an empty hash cannot be distinguished from none
  // and is treated as absent - the fragment carried no information either way.
  if (url.hash !== '') return { ok: false, reason: 'contains_fragment' };
  if (url.pathname !== '' && url.pathname !== '/') {
    return { ok: false, reason: 'contains_path' };
  }

  return { ok: true, origin: url.origin };
}

/**
 * True when the string is already in canonical form. Used at trust boundaries
 * that receive an origin which should have been canonicalized earlier: it
 * verifies rather than re-normalizes, so a value that drifted is reported
 * instead of being silently repaired.
 */
export function isCanonicalOrigin(value: string): boolean {
  const parsed = parseOrigin(value);
  return parsed.ok && parsed.origin === value;
}

export const originSchema = z
  .string()
  .refine(isCanonicalOrigin, 'must be a canonical http(s) origin with no userinfo, path, or query');

/** True when the two origins denote the same server. */
export function originsMatch(left: string, right: string): boolean {
  const a = parseOrigin(left);
  const b = parseOrigin(right);
  return a.ok && b.ok && a.origin === b.origin;
}

/**
 * Whether an origin's traffic is unencrypted. Plain HTTP is permitted for
 * explicitly configured internal hosts, but requirements-decisions.md section
 * 4 requires a persistent visible indicator - so this is a first-class query
 * rather than something each UI site re-derives from the string.
 */
export function isInsecureOrigin(value: string): boolean {
  const parsed = parseOrigin(value);
  return parsed.ok && parsed.origin.startsWith('http://');
}

export type ParseNavigationTargetResult =
  | { readonly ok: true; readonly origin: string; readonly url: string }
  | { readonly ok: false; readonly reason: OriginRejectionReason };

/**
 * Parses an address the user typed or pasted into the *browser address bar*,
 * which is a different concept from {@link parseOrigin}'s input.
 *
 * `parseOrigin` guards what may be *stored as a server setting*, where a path
 * genuinely is an error: a server is identified by scheme/host/port, and
 * keeping a login-form URL there would be wrong. An address bar names *a
 * page*. AEM authors work by pasting deep links
 * (`https://author.example/editor.html/content/site.html`), and the address
 * bar already displays the full current URL - so refusing to accept the very
 * string it just showed the user would make the control self-contradictory.
 *
 * The security-relevant rejections are kept identical to `parseOrigin`:
 * non-http(s) schemes cannot be navigated to, and embedded userinfo is
 * refused rather than stripped so a credential never rides along invisibly.
 * Only path, query and fragment - the parts that name a page rather than a
 * server - become permitted here.
 *
 * Returns both halves deliberately: `origin` is what the caller matches
 * against configured servers (authorization), `url` is where it then
 * navigates (destination). Collapsing them would either lose the path or
 * authorize against an unvalidated string.
 */
export function parseNavigationTarget(candidate: string): ParseNavigationTargetResult {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'malformed' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'contains_userinfo' };
  }
  if (url.hostname === '') return { ok: false, reason: 'missing_host' };

  return { ok: true, origin: url.origin, url: url.toString() };
}
