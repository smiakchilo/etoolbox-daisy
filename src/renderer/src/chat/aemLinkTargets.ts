import { parseNavigationTarget } from '../../../shared';

/**
 * Turns the links an assistant message contains into targets the AEM pane can
 * actually open, and decides which of them are clickable at all.
 *
 * Two kinds of link are recognised (owner decision, 2026-09-22):
 *
 *  - an absolute `http(s)` URL whose origin is one of the configured AEM
 *    hosts, and
 *  - an AEM-native JCR path written relative to the active host - exactly the
 *    roots `/content`, `/apps`, `/libs`, `/conf`, `/var`, `/etc`, `/home`.
 *
 * Everything else (an external http(s) origin, `mailto:`, `#anchor`) is left
 * alone: an external link still renders, but is not marked clickable - see
 * `renderMarkdown.ts`, which only stamps `data-daisy-link` on the targets this
 * module resolves.
 *
 * The AEM-native paths are opened in edit mode: a `/content/...` path (but not
 * `/content/dam/...`) becomes the page editor (`/editor.html<path>.html`), and
 * everything else - `/content/dam/...` and the six remaining roots, which are
 * not pages - becomes CRXDE Lite (`/crx/de/index.jsp#<path>`).
 *
 * This module is deliberately pure and DOM-free: the same classification is
 * exercised with no jsdom, and `renderMarkdown.ts` is the only place that turns
 * the resolved targets into real `<a>` elements.
 */

/** The JCR roots that denote AEM-native content the pane can open. */
export const AEM_ROOT_SEGMENTS: readonly string[] = [
  'content',
  'apps',
  'libs',
  'conf',
  'var',
  'etc',
  'home',
];

/**
 * What the message renderer knows about where the pane is pointing.
 *
 * `hostOrigins` is the set of configured AEM servers (from the settings
 * snapshot); `activeOrigin` is the origin of the page the pane is showing
 * *when that origin is a configured host*, or `undefined` otherwise. A relative
 * path can only be resolved against `activeOrigin`, which is why a message
 * rendered while the pane is not on a configured host keeps its bare paths as
 * plain text (owner decision: "do not convert relative paths to links if
 * none").
 */
export interface LinkContext {
  readonly hostOrigins: readonly string[];
  readonly activeOrigin: string | undefined;
}

export const EMPTY_LINK_CONTEXT: LinkContext = {
  hostOrigins: [],
  activeOrigin: undefined,
};

/**
 * The attribute `renderMarkdown.ts` stamps on a resolved, clickable anchor -
 * and the only selector `transcriptView.ts` intercepts. It is set *after*
 * sanitization, on a link this module resolved, so it can never be forged by
 * model output: an external or unrecognised link is left without it and is
 * therefore inert.
 */
export const MESSAGE_LINK_ATTRIBUTE = 'data-daisy-link';

const TRAILING_HTML_EXTENSION = /\.html$/i;

/** True for a pathname whose first segment is one of {@link AEM_ROOT_SEGMENTS}. */
export function isAemNativePath(pathname: string): boolean {
  const match = /^\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(pathname);
  return match !== null && AEM_ROOT_SEGMENTS.includes(match[1]!);
}

/** True for `/content/dam` and anything under it - the one `/content` subtree that is not a page. */
export function isDamPath(pathname: string): boolean {
  return pathname === '/content/dam' || pathname.startsWith('/content/dam/');
}

function withoutTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/**
 * Builds the AEM Author edit-mode URL for an AEM-native JCR path.
 *
 * `/content/...` (except `/content/dam/...`) is a page, so it opens in the page
 * editor. `/content/dam/...` and the other six roots are not pages, so they
 * open in CRXDE Lite. The `.html` suffix is normalised so a path given either
 * way (`/content/x` or `/content/x.html`) produces the same editor URL.
 */
export function buildAemEditUrl(origin: string, pathname: string): string {
  const path = withoutTrailingSlash(pathname);
  if (!isDamPath(path) && (path === '/content' || path.startsWith('/content/'))) {
    return `${origin}/editor.html${path.replace(TRAILING_HTML_EXTENSION, '')}.html`;
  }
  return `${origin}/crx/de/index.jsp#${path}`;
}

/**
 * Resolves one absolute `http(s)` href. Returns the edit-mode URL when it is on
 * a configured host and names an AEM-native path, the URL unchanged when it is
 * on a configured host but names something else, and `undefined` for any other
 * origin - an unconfigured host is never clickable.
 */
export function resolveAbsoluteMessageLink(
  rawHref: string,
  context: LinkContext,
): string | undefined {
  const parsed = parseNavigationTarget(rawHref);
  if (!parsed.ok) return undefined;
  if (!context.hostOrigins.includes(parsed.origin)) return undefined;

  const url = new URL(parsed.url);
  return isAemNativePath(url.pathname) ? buildAemEditUrl(parsed.origin, url.pathname) : parsed.url;
}

/**
 * Resolves one relative AEM-native path against the active host. Returns
 * `undefined` when there is no active host, when the value is not a
 * root-anchored path, or when its root is not one of the seven AEM roots.
 */
export function resolveRelativeAemPath(
  rawHref: string,
  activeOrigin: string | undefined,
): string | undefined {
  if (activeOrigin === undefined) return undefined;
  if (!rawHref.startsWith('/') || rawHref.startsWith('//')) return undefined;
  const pathname = rawHref.split(/[?#]/, 1)[0] ?? '';
  if (!isAemNativePath(pathname)) return undefined;
  return buildAemEditUrl(activeOrigin, pathname);
}

/**
 * The single entry point the renderer uses for an href that is already an
 * anchor in the message: an absolute host URL or a relative AEM-native path.
 * `undefined` means "leave this link alone" (render it, but do not open it).
 */
export function resolveMessageLink(rawHref: string, context: LinkContext): string | undefined {
  return (
    resolveAbsoluteMessageLink(rawHref, context) ??
    resolveRelativeAemPath(rawHref, context.activeOrigin)
  );
}

export interface MessageTextSegment {
  readonly kind: 'text';
  readonly value: string;
}
export interface MessageLinkSegment {
  readonly kind: 'link';
  readonly value: string;
  readonly url: string;
}
export type MessageSegment = MessageTextSegment | MessageLinkSegment;

/**
 * Matches a bare AEM-native path inside prose. The leading boundary group is
 * kept so the character before the path (`<p>/content/x` starts the node, but
 * `(/content/x)` and `see /content/x` do not lose their space or bracket) is
 * re-emitted as text. The segment character class deliberately omits `()`, `,`,
 * `;` and `/`, so a parenthesised or comma-terminated path does not swallow its
 * own punctuation.
 */
const AEM_PATH_PATTERN =
  /(^|[\s([{])(\/(?:content|apps|libs|conf|var|etc|home)(?:\/[A-Za-z0-9._~%:@!$&'*+=-]+)*\/?)/g;

/** Punctuation a sentence may append directly to a path; trimmed from the end. */
const TRAILING_SENTENCE_PUNCTUATION = new Set(['.', ':', ',', ';', '!', '?']);

function trimTrailingSentencePunctuation(path: string): string {
  let end = path.length;
  while (end > 1 && TRAILING_SENTENCE_PUNCTUATION.has(path[end - 1]!)) end -= 1;
  return path.slice(0, end);
}

function pushText(segments: MessageSegment[], value: string): void {
  if (value.length === 0) return;
  const previous = segments[segments.length - 1];
  if (previous !== undefined && previous.kind === 'text') {
    segments[segments.length - 1] = { kind: 'text', value: previous.value + value };
    return;
  }
  segments.push({ kind: 'text', value });
}

/**
 * Splits a text node into text and link segments, wrapping every bare
 * AEM-native path as a link to its edit-mode URL. With no `activeOrigin` there
 * is nothing to resolve against, so the whole string is returned as one text
 * segment - a bare path is never made clickable without a host.
 */
export function splitAemPathLinks(
  text: string,
  activeOrigin: string | undefined,
): readonly MessageSegment[] {
  if (activeOrigin === undefined || text.length === 0) {
    return [{ kind: 'text', value: text }];
  }

  const pattern = new RegExp(AEM_PATH_PATTERN.source, 'g');
  const segments: MessageSegment[] = [];
  let consumed = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const boundary = match[1]!;
    const rawPath = match[2]!;
    const pathStart = match.index + boundary.length;
    const path = trimTrailingSentencePunctuation(rawPath);
    if (path.length <= 1) continue;

    pushText(segments, text.slice(consumed, pathStart));
    segments.push({ kind: 'link', value: path, url: buildAemEditUrl(activeOrigin, path) });
    consumed = pathStart + path.length;
  }

  pushText(segments, text.slice(consumed));
  return segments;
}
