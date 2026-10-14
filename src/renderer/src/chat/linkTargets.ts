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
 *    `/content/dam`) and names the page itself: it opens its rendered `.html`
 *    URL and offers **Edit** (`/editor.html<path>.html`) and **CRX**
 *    (`/crx/de/index.jsp#<path-without-.html>`).
 *  - A `/content` path carrying a `jcr:content` segment names a resource
 *    *inside* a page (a component, a parsys, a rendition). The link itself opens
 *    the owning page - trimmed at `/jcr:content` and rendered as `.html` - and
 *    offers **Edit** for that owning page; **CRX** still targets the exact
 *    resource the message referenced, untrimmed.
 *  - Every other `.html`/extensionless path is not a page: it opens the raw path
 *    and offers **CRX** only.
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

/**
 * The attribute `renderMarkdown.ts` stamps on a resolved pane anchor with the
 * JSON-serialized {@link LinkAction}s its hover popover offers.
 *
 * It exists so the popover reads the actions the link was *classified* with,
 * rather than re-deriving them from the anchor's `href`: for a `jcr:content`
 * resource the href is deliberately trimmed to the owning page, so
 * re-classifying it would silently retarget **CRX** at that page and lose the
 * resource the message named.
 */
export const MESSAGE_ACTIONS_ATTRIBUTE = 'data-daisy-actions';

/**
 * The class both renderers put on the hover-only element a page-relative
 * partial path renders as. It exists only so CSS can wrap the path at any
 * character; it is deliberately **not** the link marker, so the element never
 * navigates and carries no link styling or cursor change.
 */
export const MESSAGE_PARTIAL_CLASS = 'chat-partial-link';

const LINK_ACTION_IDS: readonly LinkAction['id'][] = ['edit', 'crx'];

/** Serializes a link's popover actions for {@link MESSAGE_ACTIONS_ATTRIBUTE}. */
export function serializeLinkActions(actions: readonly LinkAction[]): string {
  return JSON.stringify(actions.map(({ id, title, href }) => ({ id, title, href })));
}

/**
 * Reads {@link MESSAGE_ACTIONS_ATTRIBUTE} back into actions. Defensive because
 * the attribute is DOM data: anything malformed or unrecognised is dropped, so
 * a corrupted value degrades to "no popover", never a throw.
 */
export function parseLinkActions(raw: string | null): readonly LinkAction[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const actions: LinkAction[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, title, href } = entry as Record<string, unknown>;
    if (
      typeof id === 'string' &&
      (LINK_ACTION_IDS as readonly string[]).includes(id) &&
      typeof title === 'string' &&
      typeof href === 'string'
    ) {
      actions.push({ id: id as LinkAction['id'], title, href });
    }
  }
  return actions;
}

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
 * The owning page path of a resource that carries a `jcr:content` segment:
 * everything before the first such segment, with no trailing slash.
 * `/content/a/b/jcr:content/x` -> `/content/a/b`. Segment-aware (not a raw
 * `indexOf`) so a segment that merely contains the substring is never mistaken
 * for the segment itself.
 */
function beforeJcrContent(pathname: string): string {
  const segments = pathname.split('/');
  const index = segments.indexOf('jcr:content');
  return index <= 1 ? pathname : segments.slice(0, index).join('/');
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
 * Percent-encodes a JCR path for use in a URL, segment by segment.
 *
 * JCR names routinely carry characters that are not URL-safe in a path - most
 * visibly the `:` of `jcr:content`, but also spaces, `[`/`]`, unicode, ... -
 * so every segment is `encodeURIComponent`-ed. The path is decoded once first
 * because it may already be percent-encoded (an absolute link's pathname
 * arrives that way from `new URL`), and encoding it again would double-escape
 * it; this mirrors `buildResourceUrl`'s "decode once, re-encode per segment"
 * rule.
 *
 * Every pane URL - the content-view URLs (page, editor, asset preview,
 * `assetdetails`) and the **CRX** action's `#fragment` alike - is built from
 * this. CRXDE Lite resolves the fragment by decoding it back to a JCR path, so
 * a raw `:` there makes the tree view fail to select the node (reported
 * 2026-10-11); `jcr:content` must reach CRX as `jcr%3Acontent`.
 */
function encodeAemPathname(pathname: string): string {
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

/**
 * Classifies one AEM-native path and builds its open target plus actions. The
 * single source of truth for the owner's rules - `resolveMessageLink` and the
 * bare-path linkifier both route through here.
 */
export function classifyAemPath(origin: string, rawPathname: string): ResolvedLink {
  const path = normalizePathDashes(withoutTrailingSlash(rawPathname));
  const pathNoHtml = withoutHtmlExtension(path);

  if (hasNonHtmlExtension(path)) {
    // An asset: preview it in the pane. A DAM asset also offers Edit.
    const encoded = encodeAemPathname(path);
    const actions: LinkAction[] = isDamPath(path)
      ? [{ id: 'edit', title: 'Edit', href: `${origin}/assetdetails.html${encoded}` }]
      : [];
    return { openIn: 'pane', href: `${origin}${encoded}`, actions };
  }

  const crx: LinkAction = {
    id: 'crx',
    title: 'CRX',
    href: `${origin}/crx/de/index.jsp#${encodeAemPathname(pathNoHtml)}`,
  };

  if (isContentPath(path)) {
    if (hasJcrContent(path)) {
      // A `jcr:content` segment names a resource *inside* a page (a component, a
      // parsys, a rendition). The link and Edit both open the owning page;
      // CRX still targets the exact resource the message referenced.
      const page = encodeAemPathname(beforeJcrContent(pathNoHtml));
      return {
        openIn: 'pane',
        href: `${origin}${page}.html`,
        actions: [{ id: 'edit', title: 'Edit', href: `${origin}/editor.html${page}.html` }, crx],
      };
    }
    const page = encodeAemPathname(pathNoHtml);
    return {
      openIn: 'pane',
      href: `${origin}${page}.html`,
      actions: [{ id: 'edit', title: 'Edit', href: `${origin}/editor.html${page}.html` }, crx],
    };
  }

  return { openIn: 'pane', href: `${origin}${encodeAemPathname(path)}`, actions: [crx] };
}

/**
 * The prefix a **page-relative** node path carries: a path inside a page's
 * `jcr:content` subtree, written relative to the owning page. A component
 * search's `Node` column is exactly this (`jcr:content/parsys/...`), as is any
 * other cell a tool or the model fills with a node path inside a page.
 */
export const PAGE_RELATIVE_PREFIX = 'jcr:content/';

/**
 * Resolves a page-relative path (`jcr:content/...`) against the last full AEM
 * path a table rendered - the "partly linkified" facility.
 *
 * The value is not a path the pane can open on its own: it names a node *inside*
 * the page the remembered path pointed at, so the full path is
 * `page + '/' + value`. The remembered path is trimmed at its own first
 * `jcr:content` segment first, so a base that was itself a resource still yields
 * the owning page. The result is classified like any other path, but only the
 * **CRX** action is kept: the row already links its owning page, so a second
 * navigable link would only repeat it, and **Edit** would retarget the page the
 * row already offers. The caller leaves the cell as plain text and hangs this
 * action off a non-anchored hover target.
 *
 * Empty when there is no active host, no remembered path, or `value` is not
 * page-relative.
 */
export function resolvePartialPathActions(
  basePath: string | undefined,
  value: string,
  activeOrigin: string | undefined,
): readonly LinkAction[] {
  if (activeOrigin === undefined || basePath === undefined) return [];
  if (!value.startsWith(PAGE_RELATIVE_PREFIX)) return [];
  const page = beforeJcrContent(withoutTrailingSlash(basePath));
  if (page.length <= 1) return [];
  const resolved = classifyAemPath(activeOrigin, `${page}/${value}`);
  return resolved.actions.filter((action) => action.id === 'crx');
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
 * The absolute `http(s)` URL a message href denotes *before* it is normalised to
 * its open target: an absolute URL normalised, or a relative AEM-native path
 * resolved against `activeOrigin`. `undefined` when the href does not resolve at
 * all (so it stays inert).
 *
 * `renderMarkdown.ts` normalises to this - rather than straight to
 * `ResolvedLink.href` - so its post-sanitization pass can re-classify the
 * *original* path. For a `jcr:content` resource that is what keeps the exact
 * resource for **CRX**; the open target itself is applied from the
 * re-classification.
 */
export function absoluteMessageHref(rawHref: string, context: LinkContext): string | undefined {
  const parsed = parseNavigationTarget(rawHref);
  if (parsed.ok) return parsed.url;
  if (context.activeOrigin === undefined) return undefined;
  if (!rawHref.startsWith('/') || rawHref.startsWith('//')) return undefined;
  const pathname = rawHref.split(/[?#]/, 1)[0] ?? '';
  if (!isAemNativePath(pathname)) return undefined;
  try {
    return new URL(rawHref, context.activeOrigin).href;
  } catch {
    return undefined;
  }
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
  /**
   * `true` for a full AEM-native path (a real, navigable link to its classified
   * target); `false` for a **page-relative** `jcr:content/...` partial, a
   * hover-only target offering the node's CRX (see
   * {@link resolvePartialPathActions}).
   */
  readonly navigable: boolean;
}
export type MessageSegment = MessageTextSegment | MessageLinkSegment;

/**
 * The AEM linkifier's carry-over: the last full AEM path it linked. Both
 * callers - the markdown renderer, over a message's text nodes, and the table
 * renderer, over a run's cells - thread this in reading order, so a later
 * page-relative `jcr:content/...` path is prefixed with the page that precedes
 * it. One state type, one linkifier, both surfaces.
 */
export interface AemLinkifyState {
  readonly lastFullPath: string | undefined;
}

export const EMPTY_AEM_LINKIFY_STATE: AemLinkifyState = { lastFullPath: undefined };

/** What {@link splitAemPathLinks} returns: this string's segments and the state to thread into the next. */
export interface AemLinkifyResult {
  readonly segments: readonly MessageSegment[];
  readonly state: AemLinkifyState;
}

/**
 * Hyphen characters that look like an ASCII `-` but are not one. A model
 * writing prose routinely emits a non-breaking hyphen (U+2011) inside what it
 * means as a path - `templates/custom‑skeleton` - while the AEM repository
 * stores the plain ASCII `-`. Two things follow: the path matcher must treat
 * these as segment characters (otherwise the match stops dead at `custom`, the
 * bug this fixes), and the URL builder must fold them back to `-` so the link
 * targets the node that actually exists.
 *
 * En dash / em dash (U+2013/U+2014) are deliberately excluded: in prose they
 * separate clauses, and admitting one would pull the following words into the
 * path. The accepted set is the hyphen family - U+2010 HYPHEN, U+2011
 * NON-BREAKING HYPHEN, U+2012 FIGURE DASH, U+FE63 SMALL HYPHEN-MINUS, U+FF0D
 * FULLWIDTH HYPHEN-MINUS.
 */
const PATH_DASH_PATTERN = /[\u2010-\u2012\uFE63\uFF0D]/g;

/** Folds every {@link PATH_DASH_PATTERN} character to ASCII `-`. */
function normalizePathDashes(value: string): string {
  return value.replace(PATH_DASH_PATTERN, '-');
}

/**
 * Matches the linkable tokens the linkifier recognises inside text. The leading
 * boundary group is kept so the character before the token (`<p>/content/x`
 * starts the node, but `(/content/x)` and `see /content/x` do not lose their
 * space or bracket) is re-emitted as text. The path character class deliberately
 * omits `()`, `,`, `;`, so a parenthesised or comma-terminated path does not
 * swallow its own punctuation; it includes the dash variants in
 * {@link PATH_DASH_PATTERN} so `custom‑skeleton` (U+2011) is one segment.
 *
 * The three alternatives are the three kinds of link the linkifier produces:
 *
 *  - an absolute `http(s)` **URL** - a configured host opens in the pane, any
 *    other origin in the system browser;
 *  - a **full** AEM-native path - a `/`-rooted path (`/content/...`);
 *  - a **page-relative** path - a `jcr:content/...` node inside the page the
 *    last full path named.
 *
 * A full path is tried before a partial, so `/content/a/jcr:content/x` is one
 * full match rather than a full match followed by a partial; the branch is
 * decided by the matched text's own leading character.
 */
const AEM_PATH_PATTERN =
  /(^|[\s([{])(https?:\/\/[^\s<>()[\]"']+|\/(?:content|apps|libs|conf|var|etc|home)(?:\/[A-Za-z0-9._~%:@!$&'*+=\u2010-\u2012\uFE63\uFF0D-]+)*\/?|jcr:content(?:\/[A-Za-z0-9._~%:@!$&'*+=\u2010-\u2012\uFE63\uFF0D-]+)+)/g;

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
 * The single AEM linkifier. Splits `text` into text and link segments, in
 * reading order, and returns the state to hand to the next string:
 *
 *  - an absolute `http(s)` URL becomes a navigable link - a configured host
 *    opens in the pane, any other origin in the system browser - and does **not**
 *    become the carry-over (a page-relative node hangs off a page path, not a
 *    URL);
 *  - a full AEM-native path becomes a navigable link to its classified target,
 *    and becomes the new carry-over;
 *  - a page-relative `jcr:content/...` path becomes a non-navigable link whose
 *    only action is its node's CRX, resolved against the carry-over.
 *
 * Both surfaces call this: `renderMarkdown.ts` over an assistant message's text
 * nodes (in DOM order), and `transcriptView.ts` over a `format_table` run's
 * cells (left to right, row to row). There is no header or column vocabulary
 * here - what a piece of text is decides whether it links, exactly as in prose.
 *
 * A bare AEM path resolves only against `context.activeOrigin` (the pane's
 * current host), and a page-relative path additionally needs a carry-over; with
 * neither, they stay text. An absolute URL needs no active host, so it links
 * whenever its origin resolves.
 */
export function splitAemPathLinks(
  text: string,
  context: LinkContext,
  state: AemLinkifyState = EMPTY_AEM_LINKIFY_STATE,
): AemLinkifyResult {
  if (text.length === 0) {
    return { segments: [{ kind: 'text', value: text }], state };
  }

  const pattern = new RegExp(AEM_PATH_PATTERN.source, 'g');
  const segments: MessageSegment[] = [];
  let lastFullPath = state.lastFullPath;
  let consumed = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const boundary = match[1]!;
    const raw = match[2]!;
    const valueStart = match.index + boundary.length;

    let value: string;
    let resolved: ResolvedLink;
    let navigable: boolean;
    if (raw.startsWith('/')) {
      // A full AEM path: needs the active host, and becomes the carry-over.
      if (context.activeOrigin === undefined) continue;
      const path = trimTrailingSentencePunctuation(raw);
      if (path.length <= 1) continue;
      value = path;
      resolved = classifyAemPath(context.activeOrigin, path);
      navigable = true;
      lastFullPath = path;
    } else if (raw.startsWith(PAGE_RELATIVE_PREFIX)) {
      // A page-relative node against the last full path (and the active host).
      if (context.activeOrigin === undefined || lastFullPath === undefined) continue;
      const path = trimTrailingSentencePunctuation(raw);
      const actions = resolvePartialPathActions(lastFullPath, path, context.activeOrigin);
      if (actions.length === 0) continue;
      value = path;
      resolved = { openIn: 'pane', href: actions[0]!.href, actions };
      navigable = false;
    } else {
      // An absolute http(s) URL: a configured host opens in the pane, any other
      // origin in the system browser. Never the carry-over.
      const url = trimTrailingSentencePunctuation(raw);
      const absolute = resolveAbsoluteLink(url, context);
      if (absolute === undefined) continue;
      value = url;
      resolved = absolute;
      navigable = true;
    }

    pushText(segments, text.slice(consumed, valueStart));
    segments.push({ kind: 'link', value, resolved, navigable });
    consumed = valueStart + value.length;
  }

  pushText(segments, text.slice(consumed));
  return { segments, state: { lastFullPath } };
}
