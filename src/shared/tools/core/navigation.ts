import type { ServerId } from '../../contracts';
import { parseOrigin } from '../../contracts';
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
