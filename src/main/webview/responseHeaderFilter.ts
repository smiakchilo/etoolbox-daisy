/**
 * A small, data-driven response-header filter for the browser pane's session.
 *
 * The pane exists to read and preview, never to save files (owner decision: a
 * DAM asset link is "a preview experience - not downloaded or offered to
 * download"), so every download on the view session is cancelled
 * (`session.ts`). AEM, however, serves a DAM asset's own URL
 * (`/content/dam/.../photo.jpg`) with `Content-Disposition: attachment`; the
 * navigation therefore becomes a download, the download guard cancels it, and
 * the asset link in the transcript appears to do nothing at all (measured live:
 * `BROWSER_NAVIGATION` -> `VIEW_DOWNLOAD_BLOCKED` -> `BROWSER_SWITCH_FAILED`).
 *
 * Chromium does not need the file to be downloadable to display it: the
 * download is triggered by the disposition header, not by the body. The default
 * rule below therefore drops that one header when the response's own media type
 * is one Chromium renders (an image, a PDF, plain text, ...), so the same bytes
 * become an ordinary document in the pane - the preview the link promised,
 * with nothing saved to disk.
 *
 * This is a **filter of rules**, not a one-off patch, because the same problem
 * recurs in different shapes: another host may serve a different renderable
 * type as an attachment, a host may need the rule only for its own origin
 * (e.g. an unrelated site must keep its download semantics), and a broken
 * `Content-Type` may need swapping rather than a header suppressed. A rule is
 * data - which hosts, which media types, which disposition, which header
 * mutations - so adding one is a list entry, never a new branch in the wiring.
 *
 * Pure and Electron-free, so the whole policy has a direct unit test.
 */
import { parseOrigin } from '../../shared';

/** The response headers Electron's `webRequest` hands over, as a read-only map. */
export interface ResponseHeaderMap {
  readonly [name: string]: readonly string[];
}

/** One header change a rule asks for. Header names are matched case-insensitively. */
export type HeaderMutation =
  /** Drops every value of the named header. */
  | { readonly kind: 'remove'; readonly name: string }
  /** Replaces every value of the named header with `values` (dropping the original casing). */
  | { readonly kind: 'set'; readonly name: string; readonly values: readonly string[] };

/**
 * One response-header rule: *when* it applies and *what* it changes.
 *
 * Every present criterion must hold. An omitted (or empty) list means "any":
 * no `hosts` applies to every host, no `contentTypes` to every media type, no
 * `disposition` to either disposition. Rules are evaluated in list order, and
 * **every** matching rule is applied, so small rules can compose - the first
 * one can suppress a header and a later one can add a replacement.
 */
export interface ResponseHeaderRule {
  /** Stable identity, used by diagnostics and tests. */
  readonly id: string;
  /**
   * Hosts this rule applies to: an origin (`https://author.example:4502`), a
   * `host:port`, or a bare hostname. `*` is a wildcard, so `*.adobeaemcloud.com`
   * covers every AEM as a Cloud Service author of one program. Omitted = any.
   */
  readonly hosts?: readonly string[];
  /**
   * Media types this rule applies to: an exact type (`application/pdf`) or a
   * family (`image/*`, or equivalently `image/`). `*`/`*\/*` matches any type.
   * The `; charset=...` parameters are ignored. Omitted = any.
   */
  readonly contentTypes?: readonly string[];
  /** Requires a `Content-Disposition` of this kind. Omitted = either kind, or none. */
  readonly disposition?: 'attachment' | 'inline';
  /** Header changes, applied in order. */
  readonly mutations: readonly HeaderMutation[];
}

/** One response being filtered. */
export interface ResponseHeaderFilterInput {
  /** The absolute URL the response came from; only the origin/host is inspected. */
  readonly url: string;
  readonly responseHeaders: ResponseHeaderMap;
}

/** The substituted headers, plus which rules produced them. */
export interface FilteredResponseHeaders {
  readonly headers: Record<string, string[]>;
  readonly ruleIds: readonly string[];
}

export interface ResponseHeaderFilter {
  /** The substituted headers, or `undefined` when no rule matched (leave the response untouched). */
  filter(input: ResponseHeaderFilterInput): FilteredResponseHeaders | undefined;
}

/**
 * The media types Chromium renders as a document instead of saving. Exported
 * so a host-specific rule can reuse the same vocabulary rather than restating
 * it (and drifting from this one).
 */
export const RENDERABLE_CONTENT_TYPES: readonly string[] = [
  'audio/*',
  'image/*',
  'text/*',
  'video/*',
  // Electron's built-in PDF viewer; JSON/XML are shown as structured text.
  'application/json',
  'application/pdf',
  'application/xhtml+xml',
  'application/xml',
];

/**
 * AEM's DAM asset behaviour, and the reason an asset link used to be cancelled
 * as a download: an asset URL is answered with `Content-Disposition:
 * attachment` even though its body is an image the pane can display.
 * Deliberately scoped to *renderable* types - a `.zip` keeps its attachment
 * disposition, still reaches `will-download`, and is still cancelled.
 */
export const INLINE_RENDERABLE_ATTACHMENT_RULE: ResponseHeaderRule = {
  id: 'inline-renderable-attachment',
  disposition: 'attachment',
  contentTypes: RENDERABLE_CONTENT_TYPES,
  mutations: [{ kind: 'remove', name: 'content-disposition' }],
};

/** The rules the view session uses unless a caller supplies its own. */
export const DEFAULT_RESPONSE_HEADER_RULES: readonly ResponseHeaderRule[] = [
  INLINE_RENDERABLE_ATTACHMENT_RULE,
];

/** The first value of `name`, matched case-insensitively (`URL` header names are not case-preserving). */
function firstHeader(headers: ResponseHeaderMap, name: string): string | undefined {
  for (const [key, values] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return values[0];
  }
  return undefined;
}

/** The bare media type of a `Content-Type` value (`image/jpeg; charset=x` -> `image/jpeg`). */
function mediaType(contentType: string | undefined): string {
  return (contentType?.split(';', 1)[0] ?? '').trim().toLowerCase();
}

/** The bare disposition of a `Content-Disposition` value (`attachment; filename=x` -> `attachment`). */
function dispositionKind(disposition: string | undefined): string {
  return (disposition?.split(';', 1)[0] ?? '').trim().toLowerCase();
}

/** Escapes one literal fragment for a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `value` matches `pattern`, where the only metacharacter is `*`. */
function globMatches(pattern: string, value: string): boolean {
  const source = pattern.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${source}$`, 'i').test(value);
}

/**
 * True when `pattern` names the host of `url`.
 *
 * Three forms are accepted so a rule can be written at whatever precision the
 * host is configured with: a canonical origin, a `host:port`, or a bare
 * hostname. A bare hostname matches any port and either scheme, while an
 * origin or `host:port` pins the port (and an origin pins the scheme too).
 * `*` works in every non-origin form.
 */
export function hostMatches(pattern: string, url: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (trimmed.includes('://')) {
    const origin = parseOrigin(trimmed);
    return origin.ok && parsed.origin === origin.origin;
  }
  return globMatches(trimmed, parsed.host) || globMatches(trimmed, parsed.hostname);
}

/**
 * True when `pattern` names `contentType`: an exact media type, a `type/*` (or
 * `type/`) family, or `*`. The comparison ignores the content type's
 * parameters and case.
 */
export function contentTypeMatches(pattern: string, contentType: string | undefined): boolean {
  const mime = mediaType(contentType);
  if (mime.length === 0) return false;

  const candidate = pattern.trim().toLowerCase();
  if (candidate === '*' || candidate === '*/*') return true;
  if (candidate.endsWith('/*')) return mime.startsWith(candidate.slice(0, -1));
  if (candidate.endsWith('/')) return mime.startsWith(candidate);
  return mime === candidate;
}

function matchesRule(
  rule: ResponseHeaderRule,
  input: ResponseHeaderFilterInput,
  contentType: string | undefined,
  disposition: string | undefined,
): boolean {
  if (
    rule.hosts !== undefined &&
    rule.hosts.length > 0 &&
    !rule.hosts.some((pattern) => hostMatches(pattern, input.url))
  ) {
    return false;
  }
  if (
    rule.contentTypes !== undefined &&
    rule.contentTypes.length > 0 &&
    !rule.contentTypes.some((pattern) => contentTypeMatches(pattern, contentType))
  ) {
    return false;
  }
  if (rule.disposition !== undefined) {
    return dispositionKind(disposition) === rule.disposition;
  }
  return true;
}

/** A mutable copy of `headers`, so no rule can alter the object Electron handed over. */
function cloneHeaders(headers: ResponseHeaderMap): Record<string, string[]> {
  const clone: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(headers)) clone[name] = [...values];
  return clone;
}

/** Drops every spelling of `name` (header names are case-insensitive). */
function removeHeader(headers: Record<string, string[]>, name: string): void {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) delete headers[key];
  }
}

function applyMutation(headers: Record<string, string[]>, mutation: HeaderMutation): void {
  removeHeader(headers, mutation.name);
  if (mutation.kind === 'set') headers[mutation.name] = [...mutation.values];
}

/**
 * Builds the filter over `rules` (the default renderable-attachment rule when
 * omitted). Every matching rule runs in list order against a private copy of
 * the headers; the caller gets that copy only if at least one rule matched, so
 * an untouched response still flows through Electron exactly as received.
 */
export function createResponseHeaderFilter(
  rules: readonly ResponseHeaderRule[] = DEFAULT_RESPONSE_HEADER_RULES,
): ResponseHeaderFilter {
  return {
    filter(input) {
      const contentType = firstHeader(input.responseHeaders, 'content-type');
      const disposition = firstHeader(input.responseHeaders, 'content-disposition');

      let headers: Record<string, string[]> | undefined;
      const ruleIds: string[] = [];
      for (const rule of rules) {
        if (!matchesRule(rule, input, contentType, disposition)) continue;
        headers ??= cloneHeaders(input.responseHeaders);
        for (const mutation of rule.mutations) applyMutation(headers, mutation);
        ruleIds.push(rule.id);
      }

      return headers === undefined ? undefined : { headers, ruleIds };
    },
  };
}
