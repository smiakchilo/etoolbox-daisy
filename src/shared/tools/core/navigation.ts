import type { ServerId } from '../../contracts';
import { originsMatch, parseOrigin } from '../../contracts';
import { type Result, err, ok } from '../../result';

/**
 * The browser-pane navigation contract shared by the `browser_navigate` tool,
 * the `environment_facts` tool and the main-process browser controller.
 *
 * Pure and dependency-free (no Electron, no Node built-ins, no browser
 * globals), so it runs unchanged in main, preload and renderer. It is the one
 * place that decides what a "browser path" may be and how a host origin and a
 * path become a URL, so the tool that validates the model's arguments and the
 * controller that actually navigates cannot drift apart.
 */

/**
 * One configured host as the model may see it: its user-facing label, its
 * canonical origin, and its effective content/component roots. The origin is
 * application-owned - the model reads it, it never supplies one.
 */
export interface ConfiguredHostInfo {
  /** The host's stable id. Never shown to the model; used to address `openPage`. */
  readonly serverId: ServerId;
  readonly label: string;
  readonly origin: string;
  readonly contentRoots: readonly string[];
  readonly componentRoots: readonly string[];
  /** Effective DAM roots (never empty; `/content/dam` when the project names none). */
  readonly damRoots: readonly string[];
  /** Content priority paths in written order; empty when the host's project names none. */
  readonly contentPriorityPaths: readonly string[];
}

/**
 * What a tool asks the application to open. `serverId` names a configured host
 * (the model supplies a label, which the application resolves to this id); the
 * origin is therefore never part of the request.
 */
export interface OpenPageTarget {
  readonly serverId: ServerId;
  /** A verbatim browser path beginning with `/` (no scheme, host or userinfo). */
  readonly path: string;
}

/**
 * The outcome of one `openPage` request. Deliberately small and
 * application-authored - never raw Chromium text.
 */
export type OpenPageOutcome =
  | {
      readonly kind: 'opened';
      /** The absolute URL the pane was sent to. */
      readonly url: string;
      /** True when the pane moved to a different host, false for a same-host page. */
      readonly switched: boolean;
    }
  | {
      readonly kind: 'network_error';
      /** The Chromium `ERR_*` code, e.g. `ERR_CONNECTION_REFUSED`. */
      readonly errorCode: string;
      readonly message: string;
    }
  | { readonly kind: 'invalid_path' }
  | { readonly kind: 'no_view' }
  | { readonly kind: 'server_not_found' }
  | { readonly kind: 'storage_error' }
  /** A newer navigation (typically the user's) superseded this one before it loaded. */
  | { readonly kind: 'cancelled' };

const BROWSER_PATH_MAX_LENGTH = 2000;

export type BrowserPathRejection =
  'empty' | 'not_absolute' | 'protocol_relative' | 'too_long' | 'unsafe_characters';

/**
 * Validates the model-supplied browser path.
 *
 * The model may pass any path on a configured host - a content page, an
 * authoring UI, CRXDE - but never a scheme, host or userinfo: the origin always
 * comes from the configured host. A leading `//` is refused because `URL` would
 * read it as a protocol-relative *host*, and whitespace/control characters are
 * refused rather than silently normalised by `URL`.
 */
export function validateBrowserPath(value: string): Result<string, BrowserPathRejection> {
  if (value.length === 0) return err('empty');
  if (value.length > BROWSER_PATH_MAX_LENGTH) return err('too_long');
  if (!value.startsWith('/')) return err('not_absolute');
  if (value.startsWith('//')) return err('protocol_relative');
  if (hasUnsafeCharacters(value)) return err('unsafe_characters');
  return ok(value);
}

/**
 * True for whitespace or a control character. Checked without a control-char
 * range in a regex (`no-control-regex`), so the C0/DEL scan is explicit.
 */
function hasUnsafeCharacters(value: string): boolean {
  if (/\s/.test(value)) return true;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Hyphen characters that look like an ASCII `-` but are not one. A model
 * writing prose routinely emits a non-breaking hyphen (U+2011) inside what it
 * means as a path - `templates/custom‑skeleton` - while the AEM repository
 * stores the plain ASCII `-`. The URL builder must fold them back to `-` so a
 * built URL targets the node that actually exists.
 *
 * En dash / em dash (U+2013/U+2014) are deliberately excluded: in prose they
 * separate clauses, and admitting one would pull the following words into the
 * path. The accepted set is the hyphen family - U+2010 HYPHEN, U+2011
 * NON-BREAKING HYPHEN, U+2012 FIGURE DASH, U+FE63 SMALL HYPHEN-MINUS, U+FF0D
 * FULLWIDTH HYPHEN-MINUS.
 */
const PATH_DASH_PATTERN = /[\u2010-\u2012\uFE63\uFF0D]/g;

/** Folds every {@link PATH_DASH_PATTERN} character to ASCII `-`. */
export function normalizePathDashes(value: string): string {
  return value.replace(PATH_DASH_PATTERN, '-');
}

/**
 * Percent-encodes a JCR path for use in a URL, segment by segment.
 *
 * JCR names routinely carry characters that are not URL-safe in a path - most
 * visibly the `:` of `jcr:content`, but also spaces, `[`/`]`, unicode, ... - so
 * every segment is `encodeURIComponent`-ed. The path is decoded once first
 * because it may already be percent-encoded (an absolute link's pathname
 * arrives that way from `new URL`), and encoding it again would double-escape
 * it; this mirrors `buildResourceUrl`'s "decode once, re-encode per segment"
 * rule.
 *
 * Shared by the renderer's linkifier and the `browser_navigate` tool's display
 * modes, so every pane URL - a content view, an editor or console prefix, and
 * the **CRX** fragment alike - is built from one encoder. CRXDE Lite resolves
 * the fragment by decoding it back to a JCR path, so a raw `:` there makes the
 * tree view fail to select the node (reported 2026-10-11); `jcr:content` must
 * reach CRX as `jcr%3Acontent`.
 */
export function encodeAemPathname(pathname: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  return normalizePathDashes(decoded)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export type BuildNavigationUrlError = 'invalid_origin' | 'path_not_preserved';

/**
 * Builds the absolute URL for `path` on `origin`, refusing anything that would
 * leave that origin (a protocol-relative `//host`, an embedded userinfo, a
 * relative path). The composed URL is re-parsed and its origin checked against
 * the intended one, mirroring `buildResourceUrl`'s discipline.
 */
export function buildNavigationUrl(params: {
  readonly origin: string;
  readonly path: string;
}): Result<string, BuildNavigationUrlError> {
  const originResult = parseOrigin(params.origin);
  if (!originResult.ok) return err('invalid_origin');

  if (!params.path.startsWith('/') || params.path.startsWith('//')) {
    return err('path_not_preserved');
  }

  let url: URL;
  try {
    url = new URL(params.path, originResult.origin);
  } catch {
    return err('path_not_preserved');
  }

  if (
    url.origin !== originResult.origin ||
    url.username !== '' ||
    url.password !== '' ||
    !url.pathname.startsWith('/')
  ) {
    return err('path_not_preserved');
  }

  return ok(url.toString());
}

/**
 * The URL shapes a page may be carried to another host in. An **allowlist** of
 * leading path segments: the replay of a GET on a host the user did not load it
 * from must never reach a login, callback or other endpoint nobody chose, so
 * anything not named here is not carried (the host's root opens instead).
 * `/crx` and `/system` are whole subtrees (package manager, CRXDE, the OSGi
 * console); the one exception inside them is {@link LOGOUT_PATH}.
 */
const CARRYABLE_PATH_ROOTS: readonly string[] = [
  '/content',
  '/editor.html',
  '/sites.html',
  '/assets.html',
  '/assetdetails.html',
  '/aem',
  '/mnt/overlay',
  '/crx',
  '/system',
  '/ui',
];

/**
 * A `logout` segment under `/crx` or `/system` (`/system/sling/logout.html`,
 * `/crx/de/logout.jsp`). Carried to another host it would sign the user out of
 * *that* host - a side effect nobody asked for - so it is never carried, even
 * though those roots are allowlisted. Scoped to them on purpose: a content page
 * named `logout.html` is an ordinary page.
 */
const LOGOUT_PATH = /^\/(?:crx|system)\/(?:.*\/)?logout(?:\.[^/]*)?(?:\/|$)/i;

/** True when the (already URL-normalised) pathname falls under an allowlisted root. */
export function isCarryablePagePath(pathname: string): boolean {
  return (
    CARRYABLE_PATH_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`)) &&
    !LOGOUT_PATH.test(pathname)
  );
}

/**
 * Query/fragment parameter names that mark a URL as an authentication hop
 * (an OAuth/SAML callback, a credential-bearing form GET). Such a URL is never
 * replayed on another host, even under an allowlisted path.
 */
const AUTH_PARAMETER_NAMES = new Set([
  'samlresponse',
  'samlrequest',
  'relaystate',
  'code',
  'state',
  'access_token',
  'id_token',
  'token',
  'j_username',
  'j_password',
  'password',
]);

const AUTH_FRAGMENT_PARAMETER = new RegExp(
  `[#&?;](?:${[...AUTH_PARAMETER_NAMES].join('|')})=`,
  'i',
);

function carriesAuthenticationParameters(url: URL): boolean {
  for (const name of url.searchParams.keys()) {
    if (AUTH_PARAMETER_NAMES.has(name.toLowerCase())) return true;
  }
  return AUTH_FRAGMENT_PARAMETER.test(url.hash);
}

/**
 * The address a host picker selection navigates to: the page currently open,
 * re-targeted at `targetOrigin`, or `targetOrigin` itself.
 *
 * The page is carried - path, query and fragment together, because AEM keeps
 * the content path in all three (`/content/..`, `?item=/content/..`,
 * `#/content/..` in CRXDE) - only when every one of these holds:
 *
 * - the current URL is an http(s) page on a *configured* host, without userinfo
 *   (an SSO identity-provider page, an error page or `about:blank` is not);
 * - the target is a *different* origin (re-picking the host you are on opens its
 *   root, as it always did);
 * - its path is under an allowlisted root ({@link isCarryablePagePath});
 * - it carries no authentication parameter;
 * - the carried path passes {@link validateBrowserPath}, the same check the
 *   `browser_navigate` tool applies to a model-supplied path.
 *
 * The origin always comes from `targetOrigin` (through
 * {@link buildNavigationUrl}), never from the current URL, so nothing carried
 * can steer the navigation to another origin. Anything else falls back to the
 * bare `targetOrigin`, so the carry is only ever an enhancement.
 */
export function resolveContextualHostUrl(params: {
  readonly currentUrl: string;
  readonly configuredOrigins: readonly string[];
  readonly targetOrigin: string;
}): string {
  const { currentUrl, configuredOrigins, targetOrigin } = params;

  let current: URL;
  try {
    current = new URL(currentUrl);
  } catch {
    return targetOrigin;
  }
  if (current.protocol !== 'http:' && current.protocol !== 'https:') return targetOrigin;
  if (current.username !== '' || current.password !== '') return targetOrigin;
  if (!configuredOrigins.some((origin) => originsMatch(origin, current.origin))) {
    return targetOrigin;
  }
  if (originsMatch(current.origin, targetOrigin)) return targetOrigin;
  if (!isCarryablePagePath(current.pathname) || carriesAuthenticationParameters(current)) {
    return targetOrigin;
  }

  const path = validateBrowserPath(`${current.pathname}${current.search}${current.hash}`);
  if (!path.ok) return targetOrigin;
  const built = buildNavigationUrl({ origin: targetOrigin, path: path.value });
  return built.ok ? built.value : targetOrigin;
}
