import { Marked } from 'marked';
import createDOMPurify from 'dompurify';
import type { Config as DomPurifyConfig } from 'dompurify';
import {
  EMPTY_AEM_LINKIFY_STATE,
  EMPTY_LINK_CONTEXT,
  absoluteMessageHref,
  resolveMessageLink,
  splitAemPathLinks,
  type LinkContext,
} from './linkTargets';
import { renderLinkSegment, stampResolvedLink } from './linkSegmentDom';

/**
 * Turns assistant Markdown into safe HTML for direct insertion into the
 * chat transcript.
 *
 * Why this exists (requirements-decisions.md section 8 and
 * implementation-plan.md step 05): "The user sees rendered HTML, including
 * actual tables inside the chat, not Markdown source. Convert Markdown to
 * HTML and sanitize it; the proposed pipeline is `marked` + `DOMPurify`" and
 * "Disallow active scripts, inline event handlers, `javascript:` URLs, and
 * automatic remote images in messages. Preserve ordinary rendered HTML
 * tables." Assistant text is remote/model output and therefore untrusted
 * (requirements-decisions.md section 2): it may itself contain adversarial
 * Markdown or raw HTML (whether authored by a compromised/confused model or
 * quoted verbatim from an AEM page it read), so this module is the one and
 * only place that untrusted text is allowed to become live DOM.
 *
 * ---
 *
 * The sanitization policy below is written as one explicit, readable
 * configuration object rather than by leaning on DOMPurify's built-in
 * defaults, because the defaults are considerably more permissive than this
 * chat surface needs: out of the box DOMPurify allows `form`, `input`,
 * `button`, and `style` tags, several non-http(s)/mailto URL schemes
 * (`tel:`, `callto:`, `sms:`, `cid:`, `xmpp:`, `matrix:`), and - easy to miss
 * - `data-*`/`aria-*` attributes on *any* allowed tag regardless of what is
 * listed in `ALLOWED_ATTR` (see `ALLOW_DATA_ATTR`/`ALLOW_ARIA_ATTR` below).
 * Every one of those is switched off explicitly here so the actual allowed
 * surface is exactly what is written in this file, not "the defaults, minus
 * whatever we remembered to forbid".
 *
 * DOMPurify version currently in this repo is 3.4.15 - if pinned versions
 * change, re-verify assumptions marked "DOMPurify-version-specific" below.
 */
export interface MarkdownRenderer {
  /**
   * Renders `markdown` to a sanitized HTML string, safe to assign to
   * `innerHTML`.
   *
   * `context` says which links the reader may open (`linkTargets.ts`):
   * an absolute link on a configured AEM host, or an AEM-native relative path
   * resolved against the pane's active host, is rewritten to its edit-mode URL
   * and stamped with `MESSAGE_LINK_ATTRIBUTE`; every other link is left as it
   * was (still rendered, but inert). Omitted entirely it behaves as
   * {@link EMPTY_LINK_CONTEXT}: nothing is clickable, and this module's output
   * is byte-for-byte what it was before link rewriting existed.
   */
  render(markdown: string, context?: LinkContext): string;
}

/**
 * Tags this chat surface renders. Deliberately an allow-list built from
 * scratch (not `ADD_TAGS` on top of DOMPurify's defaults) so every tag that
 * can appear is named here and nowhere else:
 *
 * - Headings, `p`, `strong`/`em`, `ul`/`ol`/`li`, `blockquote`, `code`/`pre`,
 *   `hr`/`br`, `a`, `del` are ordinary Markdown prose output from `marked`.
 * - `table`/`thead`/`tbody`/`tfoot`/`tr`/`th`/`td` are the GFM table
 *   elements the plan calls out by name as a required, real-DOM rendering
 *   (never a literal `|---|` string).
 * - `img` is kept, but made inert - see `ALLOWED_ATTR` below - rather than
 *   dropped outright; either choice was acceptable, this is the one
 *   implemented here.
 *
 * Everything else that can appear in Markdown-adjacent HTML - `script`,
 * `style`, `iframe`, `object`, `embed`, `form`, `input`, `button`, `link`,
 * `meta`, `base`, `svg`, `math` - is not merely omitted from this list but
 * additionally named in `FORBID_TAGS` below, so an allow-list typo (adding a
 * tag here by accident) cannot silently reintroduce one of them.
 */
const ALLOWED_TAGS: readonly string[] = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'strong',
  'em',
  'ul',
  'ol',
  'li',
  'blockquote',
  'code',
  'pre',
  'hr',
  'br',
  'a',
  'del',
  'img',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
];

/**
 * Attributes this chat surface renders, again a from-scratch allow-list:
 *
 * - `href` on `a`, gated to `http:`/`https:`/`mailto:` by
 *   `ALLOWED_URI_REGEXP` below.
 * - `alt` on `img`, the only thing an `img` is allowed to carry (see
 *   `src`'s absence below).
 * - `colspan`/`rowspan`/`align` on `th`/`td`, the attributes `marked`
 *   actually emits for merged cells and column alignment in a GFM table -
 *   without them a table renders as plain, unmerged, unaligned cells, which
 *   is not "rendered intact".
 *
 * `src` is pointedly NOT in this list, on `img` or anywhere else: an `<img>`
 * with no `src` cannot perform the automatic network fetch the plan
 * disallows ("no automatic remote image ... loading"), while its `alt` text
 * still tells the user what image was meant. This is simpler and more
 * robust than a hook that strips `src` after the fact - there is no
 * attribute-name typo or later config edit that can accidentally
 * reintroduce it, because it is never in the allowed set to begin with.
 */
const ALLOWED_ATTR: readonly string[] = ['href', 'alt', 'colspan', 'rowspan', 'align'];

/**
 * `colspan`/`rowspan`/`align` hold plain tokens ("2", "left"), never URLs,
 * but DOMPurify's default attribute check still runs every allowed
 * attribute's value through `ALLOWED_URI_REGEXP` unless the attribute name
 * is registered as "URI-safe" (DOMPurify-version-specific: see
 * `DEFAULT_URI_SAFE_ATTRIBUTES` in `dompurify/src/purify.ts`, which does not
 * include these three). Without this, the strict scheme-only regex below
 * would reject `colspan="2"` for not starting with `http:`/`https:`/
 * `mailto:` and silently break every merged or aligned table cell.
 */
const URI_SAFE_ATTRIBUTES: readonly string[] = ['colspan', 'rowspan', 'align'];

/**
 * The only URL schemes an `href` may use. Deliberately narrower than
 * DOMPurify's own default `ALLOWED_URI_REGEXP` (which also accepts `tel:`,
 * `callto:`, `sms:`, `cid:`, `xmpp:`, `matrix:`, and - critically - treats
 * any value that does not *look* like `scheme:...` as automatically safe,
 * so as to permit ordinary relative links).
 *
 * That last part is exactly what this policy must NOT do: "an href is
 * allowed ONLY when its scheme is http:, https:, or mailto:" rules out
 * `javascript:`/`vbscript:`/`data:`/`file:` (obviously), but also relative
 * and scheme-relative URLs (`#anchor`, `/path`, `//attacker.example/x`) -
 * the last of these is exactly the kind of "scheme-relative trickery" the
 * plan warns about, since it silently inherits whatever origin the chat
 * pane happens to be hosted at. Anchors/relative paths make sense for a
 * page linking to itself; they do not make sense for a chat message about
 * AEM content, so nothing is lost by being this strict.
 *
 * Case-insensitive (`JaVaScRiPt:` must be rejected exactly like
 * `javascript:`) and applied, by DOMPurify itself, to the attribute value
 * only *after* it has stripped ASCII whitespace/control characters from the
 * whole string (`java\tscript:`, leading/trailing control characters), and
 * only after the HTML parser has already decoded any character references
 * in the attribute value (`java&#115;cript:` arrives here as
 * `javascript:`, because that decoding is part of parsing the attribute in
 * the first place, not something this module has to redo).
 */
const ALLOWED_URI_REGEXP = /^(?:https?|mailto):/i;

/**
 * Tags actively forbidden, on top of being absent from `ALLOWED_TAGS`
 * above, so that no future edit to the allow-list (typo, well-meaning
 * `ADD_TAGS`) can silently let one of these back in. Grouped by why each is
 * dangerous rather than left as a flat list:
 */
const FORBID_TAGS: readonly string[] = [
  // Direct code execution.
  'script',
  // Not executable by itself, but can exfiltrate via CSS (`background:
  // url(...)`, attribute selectors) and is never legitimate chat prose.
  'style',
  // Load and render another origin's document inside ours.
  'iframe',
  'object',
  'embed',
  // Form/controls: nothing in a read-only chat transcript should be able to
  // submit data anywhere or accept interactive input.
  'form',
  'input',
  'button',
  // Document-metadata tags: irrelevant to a fragment of chat HTML, and
  // capable of things like `<base href>` rewriting how every other relative
  // reference on the page resolves, or `<link rel=prefetch/stylesheet>`
  // fetching a remote resource.
  'link',
  'meta',
  'base',
  // SVG and MathML are excluded wholesale, not attribute-by-attribute:
  // both are well-documented mutation-XSS (mXSS) and namespace-confusion
  // vectors in DOMPurify's own security history (foreignObject/annotation-
  // xml tricks that smuggle HTML through a "safe" SVG/MathML subtree), and
  // neither has any place in an assistant chat transcript.
  'svg',
  'math',
];

/**
 * `target` is stripped outright rather than being paired with
 * `rel="noopener noreferrer"`: this chat surface has no requirement that
 * links open in a new tab/window, and removing the attribute entirely is
 * one thing to verify (an attribute that is simply never allowed) instead
 * of two (an attribute that is allowed, plus a second attribute that must
 * always accompany it, forever, everywhere `target` is set).
 */
const FORBID_ATTR: readonly string[] = ['target'];

/**
 * The DOMPurify configuration implementing every rule documented above, in
 * one place so the whole policy can be read (and diffed) as a single unit.
 */
const SANITIZER_CONFIG: DomPurifyConfig = {
  ALLOWED_TAGS: [...ALLOWED_TAGS],
  ALLOWED_ATTR: [...ALLOWED_ATTR],
  ADD_URI_SAFE_ATTR: [...URI_SAFE_ATTRIBUTES],
  ALLOWED_URI_REGEXP,
  FORBID_TAGS: [...FORBID_TAGS],
  FORBID_ATTR: [...FORBID_ATTR],
  // `data-*`/`aria-*` bypass `ALLOWED_ATTR` entirely unless turned off (see
  // the file-level comment): neither is in this chat surface's allowed
  // attribute set, so both are switched off rather than left to DOMPurify's
  // permissive defaults.
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  // Explicit even though it is DOMPurify's own default: a tag that is
  // removed (an unknown custom element, or one of the `FORBID_TAGS` above)
  // still leaves its text content behind, which is what lets a stripped
  // `<button>Cancel</button>` read as plain text "Cancel" instead of
  // vanishing along with the markup that is actually dangerous.
  KEEP_CONTENT: true,
};

/**
 * Options passed to `marked` on every call, spelled out in full rather than
 * relying on its built-in defaults for anything: `marked`'s default options
 * live on a shared, mutable, module-level object (`Marked#setOptions`
 * mutates it for every consumer of that instance), so leaving any option
 * unspecified would make this module's output depend on whatever any other
 * code elsewhere in the process has done to that shared instance. Passing a
 * fully-specified object to a *dedicated* `Marked` instance (created below,
 * used by no one else) removes that dependency entirely.
 *
 * `gfm: true` is what makes `marked` emit real `<table>` markup for GFM
 * table syntax - required, since a plain-CommonMark parser leaves a
 * `|---|` table as an unparsed paragraph of pipes and dashes, not the real
 * DOM table element the plan requires.
 *
 * `async: false` pins `marked.parse` to its synchronous overload, so this
 * function can return a plain `string` rather than a `string | Promise
 * <string>` union - correct, because nothing in this pipeline (no async
 * extensions, no async `walkTokens` hook) is registered on this instance to
 * ever need the asynchronous path.
 */
const markdown = new Marked({ gfm: true, breaks: false, pedantic: false, async: false });

/**
 * A cheap prefix probe for "does this rendered HTML mention an AEM-native
 * root at all?" - used only to skip the two DOM passes when nothing could be
 * linkified.
 *
 * It must be a strict *superset* of what `splitAemPathLinks` can match: a
 * false negative here takes the fast path and silently disables linkification
 * for the whole message, while a false positive only costs the two DOM passes
 * (the real links still come from `splitAemPathLinks`, never from this probe).
 * The real matcher's boundary cannot be reproduced against raw HTML - a path at
 * a paragraph start is preceded by a tag close (`<p>/content/...`) rather than
 * the text-node start, an `&nbsp;`-style entity hides a decoded whitespace
 * boundary, and a root at the end of a text node is followed by `<` rather than
 * `$`. So this probe drops its boundaries entirely and matches any `/`-rooted
 * AEM path or a page-relative `jcr:content/...` path anywhere in the markup.
 * Deliberately non-global so repeated `.test` calls are stateless.
 */
const AEM_PATH_HINT = /\/(?:content|apps|libs|conf|var|etc|home)|jcr:content\//;

/**
 * A cheap probe for "does this rendered HTML mention an absolute URL?" - the
 * linkifier's other token (a configured host opens in the pane, any other
 * origin in the system browser), which unlike an AEM path needs no active host.
 */
const URL_HINT = /https?:\/\//;

/**
 * Creates a renderer bound to `windowRef`.
 *
 * Takes the window as a parameter, rather than reading the ambient global
 * `window`, for two reasons: it lets unit tests hand this factory a jsdom
 * window with no Electron/browser runtime involved, and it keeps this
 * module's only DOM dependency an explicit, injected one instead of an
 * implicit reference to whatever `window` happens to be in scope when it
 * runs.
 */
export function createMarkdownRenderer(windowRef: Window & typeof globalThis): MarkdownRenderer {
  const purify = createDOMPurify(windowRef);

  /**
   * Parses a rendered fragment into a detached document. `DOMParser` never
   * executes scripts, so running it over model output (before sanitization, in
   * `rewriteAnchors`) is safe; the sanitizer still runs afterwards as the net.
   */
  function parseFragment(html: string): Document {
    return new windowRef.DOMParser().parseFromString(html, 'text/html');
  }

  /**
   * Normalises a resolvable anchor's href to the absolute URL of the path the
   * message wrote, *before* sanitization. This is what lets a relative link
   * survive the sanitizer's scheme policy, which rejects relative hrefs
   * outright.
   *
   * It normalises to the absolute *source*, not the open target: the
   * post-sanitization pass re-classifies this href and applies the open target
   * itself, and for a `jcr:content` resource only the source preserves the exact
   * resource that **CRX** must target. Rewriting straight to the open target
   * here would trim the path before the actions could be computed. An external
   * absolute URL is normalised to the same string the click handler will see;
   * anything unresolvable is left untouched, so the sanitizer strips it.
   */
  function rewriteAnchors(doc: Document, context: LinkContext): void {
    for (const anchor of Array.from(doc.querySelectorAll('a[href]'))) {
      const href = anchor.getAttribute('href');
      if (href === null) continue;
      const absolute = absoluteMessageHref(href, context);
      if (absolute !== undefined) anchor.setAttribute('href', absolute);
    }
  }

  /**
   * Wraps every bare AEM path in a text node as a clickable anchor - and every
   * page-relative `jcr:content/...` path as a non-navigating hover target
   * offering its node's CRX.
   *
   * This is the markdown surface of the one linkifier (`splitAemPathLinks`):
   * text nodes are visited in document order and the linkifier's carry-over
   * (the last full path) is threaded from one to the next, so a relative path in
   * a later cell or paragraph hangs off the page before it. `transcriptView.ts`
   * threads the same state across a table's cells, and both turn the segments
   * into nodes through `linkSegmentDom.ts`.
   *
   * Inline code and fenced code blocks are linkified too (owner decision,
   * 2026-10-08): the model habitually writes a JCR path as `` `/content/...` ``
   * or inside a ``` block, and a path that matches the roots is a path wherever
   * it appears. The one exclusion is text already inside an anchor, where a
   * nested `<a>` is invalid and the outer anchor already carries its target.
   */
  function linkifyTextNodes(doc: Document, context: LinkContext): void {
    const filter = {
      acceptNode(node: Node): number {
        const parent = node.parentElement;
        if (parent === null) return windowRef.NodeFilter.FILTER_REJECT;
        return parent.closest('a') !== null
          ? windowRef.NodeFilter.FILTER_REJECT
          : windowRef.NodeFilter.FILTER_ACCEPT;
      },
    };
    const walker = doc.createTreeWalker(doc.body, windowRef.NodeFilter.SHOW_TEXT, filter);

    const textNodes: Text[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      textNodes.push(node as Text);
    }

    let state = EMPTY_AEM_LINKIFY_STATE;
    for (const text of textNodes) {
      const linked = splitAemPathLinks(text.data, context, state);
      state = linked.state;
      if (!linked.segments.some((segment) => segment.kind === 'link')) continue;

      const fragment = doc.createDocumentFragment();
      for (const segment of linked.segments) {
        fragment.append(renderLinkSegment(doc, segment));
      }
      text.replaceWith(fragment);
    }
  }

  /**
   * The post-sanitization pass: resolves and marks every anchor, then linkifies
   * bare paths. Only a link {@link resolveMessageLink} resolves (a configured
   * host, an external origin, or a relative path with an active host) is
   * stamped, and only a stamped anchor is intercepted on click
   * (`transcriptView.ts`).
   *
   * The anchor pass runs first, over the anchors that came from the message, and
   * `linkifyTextNodes` runs last, creating only *new* anchors. That order
   * matters: a linkified anchor's href is already its open target, so feeding it
   * back through `resolveMessageLink` would re-classify a trimmed
   * `jcr:content` page and lose its exact CRX resource.
   */
  function markOpenableLinks(doc: Document, context: LinkContext): void {
    for (const anchor of Array.from(doc.querySelectorAll('a'))) {
      const href = anchor.getAttribute('href');
      if (href === null) continue;
      const resolved = resolveMessageLink(href, context);
      if (resolved === undefined) continue;
      if (resolved.href !== href) anchor.setAttribute('href', resolved.href);
      stampResolvedLink(anchor, resolved);
    }

    linkifyTextNodes(doc, context);
  }

  return {
    render(markdownSource: string, context: LinkContext = EMPTY_LINK_CONTEXT): string {
      const html: string = markdown.parse(markdownSource, { async: false });

      // Fast path: with no anchor to resolve and nothing to linkify the two DOM
      // passes cannot change the output, so skip them and sanitize directly. A
      // bare AEM path needs the active host; an absolute URL does not, so a
      // message with either (or any anchor) forces the slow path.
      const hasAnchor = /<a[\s>]/i.test(html);
      const hasLinkable =
        URL_HINT.test(html) || (context.activeOrigin !== undefined && AEM_PATH_HINT.test(html));
      if (!hasAnchor && !hasLinkable) {
        return purify.sanitize(html, SANITIZER_CONFIG);
      }

      const preSanitize = parseFragment(html);
      rewriteAnchors(preSanitize, context);
      const cleaned = purify.sanitize(preSanitize.body.innerHTML, SANITIZER_CONFIG);

      const postSanitize = parseFragment(cleaned);
      markOpenableLinks(postSanitize, context);
      return postSanitize.body.innerHTML;
    },
  };
}
