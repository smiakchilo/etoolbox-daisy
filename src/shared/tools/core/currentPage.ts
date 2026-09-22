import { originsMatch } from '../../contracts';

/**
 * The "where is the browser pane right now" context the application hands the
 * model at the start of every turn.
 *
 * This is deliberately application-owned, like the tool target: the model never
 * supplies a URL, and the raw browser URL is never copied into the prompt. Only
 * a pane that is sitting on the *active AEM server's own origin* produces a
 * context at all - an SSO/IdP page mid-redirect, an error page, or any other
 * origin yields `undefined`, so a login URL can never reach the agent's
 * context (implementation-plan.md step 05: "the address bar shows the current
 * URL without sending OAuth URLs to the agent or logs"). Query and fragment are
 * stripped from the reported URL for the same reason.
 *
 * Pure and dependency-free apart from the shared origin helpers, so it runs
 * unchanged in main, preload and renderer.
 */

export interface CurrentPageContext {
  /** Canonical origin of the AEM server the pane is showing. */
  readonly origin: string;
  /** `origin` plus the page's path, with query and fragment removed. */
  readonly url: string;
  /** The JCR path the page addresses, when one could be derived; otherwise `undefined`. */
  readonly jcrPath: string | undefined;
}

export interface CurrentPageContextInput {
  /** The live browser-pane URL, or `undefined` when there is no document. */
  readonly documentUrl: string | undefined;
  /** The canonical origin of the currently active AEM server. */
  readonly activeOrigin: string;
}

const CONTENT_ROOT = '/content';
const HTML_EXTENSION = '.html';

/**
 * The AEM Author UI route wrappers that carry a content path immediately after
 * them (`/editor.html/content/...`, `/sites.html/content/...`, ...). Only these
 * - plus a bare `/content/...` - are treated as naming content. Without the
 * allowlist, an incidental `/content/` segment deep inside a non-content route
 * (`/libs/granite/core/content/login.html`, the AEM sign-in form) would be
 * mistaken for "this page".
 */
const AEM_UI_PATH_PREFIXES = [
  '/editor.html',
  '/sites.html',
  '/assets.html',
  '/siteadmin.html',
] as const;

/**
 * AEM as a Cloud Service (and the AEM 6.5 unified shell) serves the author UI
 * through a shell route, so the real UI path sits behind an `/aem` segment
 * inside the fragment - `.../ui#/aem/editor.html/content/...` - rather than at
 * the start of the pathname. Stripping that segment first lets the same
 * wrapper allowlist above apply to the shell form as to the on-prem one.
 */
const SHELL_APP_PREFIX = '/aem';

function stripTrailingHtml(path: string): string {
  return path.endsWith(HTML_EXTENSION) ? path.slice(0, -HTML_EXTENSION.length) : path;
}

function stripAppPrefix(candidate: string): string {
  if (candidate === SHELL_APP_PREFIX) return '/';
  return candidate.startsWith(`${SHELL_APP_PREFIX}/`)
    ? candidate.slice(SHELL_APP_PREFIX.length)
    : candidate;
}

function stripAemUiPrefix(candidate: string): string {
  for (const prefix of AEM_UI_PATH_PREFIXES) {
    if (candidate === prefix) return '/';
    if (candidate.startsWith(`${prefix}/`)) return candidate.slice(prefix.length);
  }
  return candidate;
}

/**
 * Reads a `/content/...` path out of an AEM UI pathname or fragment, and
 * `undefined` for anything else - so the model is never handed `/libs/...`,
 * `/system/...`, or a login route as "this page". `candidate` is either a URL
 * pathname (`/editor.html/content/wknd.html`) or a damadmin-style fragment
 * (`/content/dam/wknd`), both of which are handled identically.
 */
function extractJcrPath(candidate: string): string | undefined {
  const path = stripAemUiPrefix(stripAppPrefix(candidate));
  if (path !== CONTENT_ROOT && !path.startsWith(`${CONTENT_ROOT}/`)) return undefined;
  const withoutExtension = stripTrailingHtml(path);
  return withoutExtension.length > 1 && withoutExtension.endsWith('/')
    ? withoutExtension.slice(0, -1)
    : withoutExtension;
}

function decodeFragment(hash: string): string {
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

/**
 * Derives the model-facing page context from a live pane URL, or `undefined`
 * when there is nothing safe and useful to say (no URL, an unparseable URL, a
 * non-http(s) scheme, or a URL that is not the active AEM server's own origin).
 */
export function deriveCurrentPageContext(
  input: CurrentPageContextInput,
): CurrentPageContext | undefined {
  const { documentUrl, activeOrigin } = input;
  if (documentUrl === undefined || documentUrl.length === 0) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(documentUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  if (!originsMatch(parsed.origin, activeOrigin)) return undefined;

  // AEM DAM admin keeps the content path in the fragment (`/damadmin#/content/...`);
  // every other UI keeps it in the pathname.
  const fragment = parsed.hash.startsWith('#') ? decodeFragment(parsed.hash.slice(1)) : '';
  const jcrPath = extractJcrPath(parsed.pathname) ?? extractJcrPath(fragment);

  return { origin: parsed.origin, url: `${parsed.origin}${parsed.pathname}`, jcrPath };
}

/**
 * Renders one {@link deriveCurrentPageContext} result into the text block
 * prepended to a user's prompt. Kept here - beside the derivation - so the
 * wording the model is given and the values it is given cannot drift.
 */
export function renderCurrentPageContextForModel(context: CurrentPageContext): string {
  const lines = [
    'Current AEM page (supplied by the application from the browser pane, not typed by the user):',
    `Host: ${context.origin}`,
    `URL: ${context.url}`,
  ];
  if (context.jcrPath !== undefined) {
    lines.push(`Content path: ${context.jcrPath}`);
    lines.push(
      'References such as "this page", "here", or "this content" mean the content path above; ' +
        '"this host", "this server", or "this instance" mean the host above. A request that ' +
        'names no path or server targets this page and this host.',
    );
  } else {
    lines.push(
      'No content path is available for the current page. "This host", "this server", and ' +
        '"this instance" mean the host above; for a page-specific request, find the path (for ' +
        'example with aem_query) rather than guessing one.',
    );
  }
  return lines.join('\n');
}
