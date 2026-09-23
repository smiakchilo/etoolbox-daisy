import { parseNavigationTarget } from '../../../shared';

/**
 * Turns the links an assistant message contains into the target the AEM pane
 * (or the system browser) should open, plus any edit-mode actions the link
 * offers in its hover popover.
 *
 * Three kinds of input are recognised:
 *
 *  - an absolute `http(s)` URL whose origin is a configured AEM host,
 *  - an absolute `http(s)` URL whose origin is *not* a configured host (opens
 *    in the system browser), and
 *  - an AEM-native JCR path written relative to the active host - exactly the
 *    roots `/content`, `/apps`, `/libs`, `/conf`, `/var`, `/etc`, `/home`.
 *
 * Everything else (`mailto:`, `#anchor`, a relative path with no active host)
 * is left alone - `renderMarkdown.ts` only stamps `MESSAGE_LINK_ATTRIBUTE` /
 * `MESSAGE_EXTERNAL_ATTRIBUTE` on the links this module resolves.
 *
 * The AEM-native rules (owner decisions, 2026-09-23):
 *
 *  - A path with an extension other than `.html` is an asset: clicking it opens
 *    the raw asset URL in the pane (a preview, never a download). A path under
 *    `/content/dam` additionally offers **Edit** (`/assetdetails.html<path>`).
 *  - A `.html`/extensionless path is a Page when it is under `/content` (but not
 *    `/content/dam`) and contains no `jcr:content` segment; a Page opens its
 *    rendered `.html` URL and offers **Edit** (`/editor.html<path>.html`) and
 *    **CRX** (`/crx/de/index.jsp#<path-without-.html>`). Every other
 *    `.html`/extensionless path is not a page: it opens the raw path and offers
 *    **CRX** only.
 *
 * This module is deliberately pure and DOM-free: the whole classification is
 * exercised with no jsdom, and `renderMarkdown.ts` is the only place that turns
 * the resolved targets into real `<a>` elements.
 */

/** The JCR roots that denote AEM-native content the pane can open. */
export const AEM_ROOT_SEGMENTS: readonly string[] = [
  'apps',
  'conf',
  'content',
  'etc',
  'home',
  'libs',
  'var',
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
 * The attribute `renderMarkdown.ts` stamps on a resolved anchor that opens in
 * the AEM pane - one of the two selectors `transcriptView.ts` intercepts.
 */
export const MESSAGE_LINK_ATTRIBUTE = 'data-daisy-link';

/**
 * The attribute `renderMarkdown.ts` stamps on a resolved anchor whose origin is
 * not a configured host, so it opens in the system browser instead.
 */
export const MESSAGE_EXTERNAL_ATTRIBUTE = 'data-daisy-external';

/** Where a resolved link opens. */
export type LinkOpenIn = 'pane' | 'external';

/** One button in a link's hover popover. */
export interface LinkAction {
  readonly id: 'edit' | 'crx';
  /** Visible-in-a-tooltip / accessible label, e.g. `"Edit"`. */
  readonly title: string;
  /** The absolute URL the action opens in the AEM pane. */
  readonly href: string;
}

/** A resolved message link: where clicking it goes, and which actions it offers. */
export interface ResolvedLink {
  readonly openIn: LinkOpenIn;
  /** The absolute URL the link itself opens. */
  readonly href: string;
  /** Popover actions; empty for a plain link. */
  readonly actions: readonly LinkAction[];
}

const TRAILING_HTML_EXTENSION = /\.html$/i;
const LAST_SEGMENT_EXTENSION = /\.[A-Za-z0-9]+$/;

/** True for a pathname whose first segment is one of {@link AEM_ROOT_SEGMENTS}. */
export function isAemNativePath(pathname: string): boolean {
  const match = /^\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(pathname);
  return match !== null && AEM_ROOT_SEGMENTS.includes(match[1]!);
}

/** True for `/content/dam` and anything under it - the one `/content` subtree that is not a page. */
export function isDamPath(pathname: string): boolean {
  return pathname === '/content/dam' || pathname.startsWith('/content/dam/');
}

/** True for a `/content/...` path that is not under `/content/dam`. */
function isContentPath(pathname: string): boolean {
  return (pathname === '/content' || pathname.startsWith('/content/')) && !isDamPath(pathname);
}

/** True when the path carries any `jcr:content` segment. */
function hasJcrContent(pathname: string): boolean {
  return pathname.split('/').includes('jcr:content');
}

/**
 * True when the final path segment ends in an extension other than `.html`
 * (`.jpg`, `.pdf`, `.json`, ...). A `.html` path is a page/document, not an
 * asset, and an extensionless path falls to the page/non-page decision.
 */
export function hasNonHtmlExtension(pathname: string): boolean {
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  return LAST_SEGMENT_EXTENSION.test(lastSegment) && !TRAILING_HTML_EXTENSION.test(lastSegment);
}

function withoutTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function withoutHtmlExtension(pathname: string): string {
  return pathname.replace(TRAILING_HTML_EXTENSION, '');
}

/**
 * Classifies one AEM-native path and builds its open target plus actions. The
 * single source of truth for the owner's rules - `resolveMessageLink` and the
 * bare-path linkifier both route through here.
 */
export function classifyAemPath(origin: string, rawPathname: string): ResolvedLink {
  const path = withoutTrailingSlash(rawPathname);
  const pathNoHtml = withoutHtmlExtension(path);

  if (hasNonHtmlExtension(path)) {
    // An asset: preview it in the pane. A DAM asset also offers Edit.
    const actions: LinkAction[] = isDamPath(path)
      ? [{ id: 'edit', title: 'Edit', href: `${origin}/assetdetails.html${path}` }]
      : [];
    return { openIn: 'pane', href: `${origin}${path}`, actions };
  }

  const crx: LinkAction = {
    id: 'crx',
    title: 'CRX',
    href: `${origin}/crx/de/index.jsp#${pathNoHtml}`,
  };

  if (isContentPath(path) && !hasJcrContent(path)) {
    return {
      openIn: 'pane',
      href: `${origin}${pathNoHtml}.html`,
      actions: [
        { id: 'edit', title: 'Edit', href: `${origin}/editor.html${pathNoHtml}.html` },
        crx,
      ],
    };
  }

  return { openIn: 'pane', href: `${origin}${path}`, actions: [crx] };
}

/**
 * Resolves one absolute `http(s)` href. A configured host is opened in the pane
 * (classified as AEM-native when its path is one); any other origin is opened
 * in the system browser. `undefined` for a non-http(s) value.
 */
export function resolveAbsoluteLink(
  rawHref: string,
  context: LinkContext,
): ResolvedLink | undefined {
  const parsed = parseNavigationTarget(rawHref);
  if (!parsed.ok) return undefined;
  if (!context.hostOrigins.includes(parsed.origin)) {
    return { openIn: 'external', href: parsed.url, actions: [] };
  }

  const url = new URL(parsed.url);
  return isAemNativePath(url.pathname)
    ? classifyAemPath(parsed.origin, url.pathname)
    : { openIn: 'pane', href: parsed.url, actions: [] };
}

/**
 * Resolves one relative AEM-native path against the active host. Returns
 * `undefined` when there is no active host, when the value is not a
 * root-anchored path, or when its root is not one of the seven AEM roots.
 */
export function resolveRelativePath(
  rawHref: string,
  activeOrigin: string | undefined,
): ResolvedLink | undefined {
  if (activeOrigin === undefined) return undefined;
  if (!rawHref.startsWith('/') || rawHref.startsWith('//')) return undefined;
  const pathname = rawHref.split(/[?#]/, 1)[0] ?? '';
  if (!isAemNativePath(pathname)) return undefined;
  return classifyAemPath(activeOrigin, pathname);
}

/**
 * The single entry point the renderer uses for an href that is already an
 * anchor in the message: an absolute URL (host or external) or a relative
 * AEM-native path. `undefined` means "leave this link alone" (render it, but do
 * not open it).
 */
export function resolveMessageLink(
  rawHref: string,
  context: LinkContext,
): ResolvedLink | undefined {
  return (
    resolveAbsoluteLink(rawHref, context) ?? resolveRelativePath(rawHref, context.activeOrigin)
  );
}

export interface MessageTextSegment {
  readonly kind: 'text';
  readonly value: string;
}
export interface MessageLinkSegment {
  readonly kind: 'link';
  readonly value: string;
  readonly resolved: ResolvedLink;
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
 * AEM-native path as a link to its classified target. With no `activeOrigin`
 * there is nothing to resolve against, so the whole string is returned as one
 * text segment - a bare path is never made clickable without a host.
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
    segments.push({ kind: 'link', value: path, resolved: classifyAemPath(activeOrigin, path) });
    consumed = pathStart + path.length;
  }

  pushText(segments, text.slice(consumed));
  return segments;
}
