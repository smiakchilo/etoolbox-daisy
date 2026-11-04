/**
 * The decision logic of the report's element highlight, extracted from
 * `webview-preload.ts` for the same reason `bridgeFetch.ts` and `bridgeRead.ts`
 * are: the preload file stays wiring, and every rule is stated once where it is
 * enforced.
 *
 * - It only reads and decorates. The selector is handed to `querySelector` and
 *   nowhere else (a CSS selector, never script), and the decoration is inline
 *   style on the matched element plus a fixed ring - nothing from the page is
 *   evaluated.
 * - It crosses **open shadow roots**: a report's node can live inside a web
 *   component's shadow tree (an LCP image inside `hpe-adaptive-marquee`), where
 *   a plain `querySelector` cannot see it. Each `>` step is searched in the
 *   current scope's light DOM, then in the open shadow roots reachable from it.
 * - The frame is both an inline outline (`!important`, so a page's
 *   `outline: none` reset cannot suppress it) and a fixed ring above the page,
 *   so an element the page paints under something else is still visible.
 * - The highlight is **persistent**: it stays until the page navigates (the
 *   document is replaced) or a different selector is clicked, which moves it.
 * - Exactly one element is highlighted at a time, tracked in this module's own
 *   state, so a new click clears the previous outline before applying the next.
 */

const HIGHLIGHT_OUTLINE = '3px solid #0d66d0';
const HIGHLIGHT_OFFSET = '2px';
const OVERLAY_ATTRIBUTE = 'data-daisy-highlight';
const OVERLAY_Z_INDEX = '2147483647';

/** One inline style property, as it was before the highlight. */
interface SavedStyle {
  readonly value: string;
  readonly priority: string;
}

let highlighted: Element | undefined;
let savedOutline: SavedStyle | undefined;
let savedOutlineOffset: SavedStyle | undefined;
let overlay: HTMLElement | undefined;
let overlayTarget: Element | undefined;
let stopTracking: (() => void) | undefined;

/** Whether two addresses name the same document, ignoring a trailing hash. */
function isSameDocument(current: string, expected: string): boolean {
  try {
    const a = new URL(current);
    const b = new URL(expected);
    a.hash = '';
    b.hash = '';
    return a.href === b.href;
  } catch {
    return false;
  }
}

/** Restores one inline property to the value (and priority) it had before. */
function restoreStyle(element: HTMLElement, property: string, saved: SavedStyle): void {
  if (saved.value === '') element.style.removeProperty(property);
  else element.style.setProperty(property, saved.value, saved.priority);
}

function removeOverlay(): void {
  stopTracking?.();
  stopTracking = undefined;
  overlayTarget = undefined;
  overlay?.remove();
  overlay = undefined;
}

/** Removes the frame from the element previously highlighted, if any. */
function clearHighlight(): void {
  if (highlighted !== undefined) {
    const element = highlighted as HTMLElement;
    if (savedOutline !== undefined) restoreStyle(element, 'outline', savedOutline);
    if (savedOutlineOffset !== undefined)
      restoreStyle(element, 'outline-offset', savedOutlineOffset);
    highlighted = undefined;
    savedOutline = undefined;
    savedOutlineOffset = undefined;
  }
  removeOverlay();
}

/**
 * The first match of `selector`, crossing open shadow roots. `querySelector`
 * alone cannot see into a web component's shadow tree; the direct query is
 * tried first so an ordinary selector behaves exactly as before.
 */
/**
 * Every match of `selector`, crossing open shadow roots. The direct query is
 * tried first, so an ordinary selector returns all of its matches in document
 * order; only when it finds none does the per-step walk search shadow trees.
 */
function queryAllDeep(doc: Document, selector: string): Element[] {
  try {
    const direct = Array.from(doc.querySelectorAll(selector));
    if (direct.length > 0) return direct;
  } catch {
    return [];
  }

  const parts = selector
    .split('>')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return [];

  let scope: ParentNode = doc;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const next = findInScope(scope, parts[index]!);
    if (next === null) return [];
    scope = next;
  }
  return findAllInScope(scope, parts[parts.length - 1]!);
}

function findInScope(scope: ParentNode, selector: string): Element | null {
  const direct = scope.querySelector(selector);
  if (direct !== null) return direct;
  const ownShadow = (scope as Partial<Element>).shadowRoot;
  if (ownShadow !== undefined && ownShadow !== null) {
    const inOwnShadow = ownShadow.querySelector(selector);
    if (inOwnShadow !== null) return inOwnShadow;
  }
  for (const element of scope.querySelectorAll('*')) {
    if (element.shadowRoot === null) continue;
    const inShadow = element.shadowRoot.querySelector(selector);
    if (inShadow !== null) return inShadow;
  }
  return null;
}

/** Every match of `selector` in `scope`'s light DOM and its open shadow trees. */
function findAllInScope(scope: ParentNode, selector: string): Element[] {
  const found = new Set<Element>();
  try {
    for (const element of scope.querySelectorAll(selector)) found.add(element);
  } catch {
    return [...found];
  }
  const ownShadow = (scope as Partial<Element>).shadowRoot;
  const roots: ShadowRoot[] = [];
  if (ownShadow !== undefined && ownShadow !== null) roots.push(ownShadow);
  for (const element of scope.querySelectorAll('*')) {
    if (element.shadowRoot !== null) roots.push(element.shadowRoot);
  }
  for (const root of roots) {
    for (const element of findAllInScope(root, selector)) found.add(element);
  }
  return [...found];
}

/** Attributes that change with the page's state, so they cannot identify an element. */
const UNSTABLE_ATTRIBUTES = new Set([
  'class',
  'style',
  'active',
  'current',
  'disabled',
  'inert',
  'hidden',
  'aria-hidden',
]);

interface SnippetSpec {
  readonly tagName: string;
  readonly attributes: ReadonlyMap<string, string>;
}

/** The tag and stable attributes of a snippet, parsed inertly (never attached). */
function parseSnippet(doc: Document, snippet: string): SnippetSpec | undefined {
  try {
    const template = doc.createElement('template');
    template.innerHTML = snippet;
    const element = template.content.firstElementChild;
    if (element === null) return undefined;
    const attributes = new Map<string, string>();
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      if (UNSTABLE_ATTRIBUTES.has(name)) continue;
      attributes.set(name, attribute.value);
    }
    return { tagName: element.tagName.toLowerCase(), attributes };
  } catch {
    return undefined;
  }
}

/** How many stable attributes of `spec` this element reproduces (0 when the tag differs). */
function snippetScore(element: Element, spec: SnippetSpec): number {
  if (element.tagName.toLowerCase() !== spec.tagName) return 0;
  let score = 0;
  for (const [name, value] of spec.attributes) {
    if (element.getAttribute(name) === value) score += 1;
  }
  return score;
}

/** True when the element has a non-zero box intersecting the viewport. */
function isVisibleInViewport(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const view = element.ownerDocument.defaultView;
  const width = view?.innerWidth ?? rect.right;
  const height = view?.innerHeight ?? rect.bottom;
  if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= width || rect.top >= height) {
    return false;
  }
  const style = view?.getComputedStyle(element);
  return style?.visibility !== 'hidden' && style?.display !== 'none';
}

/**
 * The element to frame: the best match for the snippet, then the first one
 * already on screen. A selector often matches several copies (a carousel's
 * slides, a card list); framing the first copy, which may sit off-screen in an
 * inactive slide, looks like nothing happened.
 */
function chooseTarget(
  candidates: readonly Element[],
  spec: SnippetSpec | undefined,
): Element | undefined {
  const first = candidates[0];
  if (first === undefined) return undefined;
  if (spec !== undefined && spec.attributes.size > 0) {
    let best = 0;
    for (const candidate of candidates) best = Math.max(best, snippetScore(candidate, spec));
    if (best > 0) {
      const matches = candidates.filter((candidate) => snippetScore(candidate, spec) === best);
      return matches.find(isVisibleInViewport) ?? matches[0];
    }
  }
  return candidates.find(isVisibleInViewport) ?? first;
}

/** Creates (once) or moves the fixed ring over `target`, above the page. */
function positionOverlay(target: Element): void {
  const doc = target.ownerDocument;
  const rect = target.getBoundingClientRect();
  const view = doc.defaultView;
  const viewportWidth = view?.innerWidth ?? rect.right;
  const viewportHeight = view?.innerHeight ?? rect.bottom;
  const left = Math.max(0, Math.min(rect.left, viewportWidth));
  const top = Math.max(0, Math.min(rect.top, viewportHeight));
  const right = Math.max(0, Math.min(rect.right, viewportWidth));
  const bottom = Math.max(0, Math.min(rect.bottom, viewportHeight));
  const width = right - left;
  const height = bottom - top;
  if (overlay === undefined) {
    overlay = doc.createElement('div');
    overlay.setAttribute(OVERLAY_ATTRIBUTE, '');
    overlay.setAttribute('aria-hidden', 'true');
    const styles: readonly (readonly [string, string])[] = [
      ['position', 'fixed'],
      ['pointer-events', 'none'],
      ['z-index', OVERLAY_Z_INDEX],
      ['box-sizing', 'border-box'],
      ['border', HIGHLIGHT_OUTLINE],
      ['border-radius', '2px'],
      ['box-shadow', '0 0 0 1px rgba(255, 255, 255, 0.9)'],
      ['margin', '0'],
      ['padding', '0'],
    ];
    for (const [property, value] of styles) {
      overlay.style.setProperty(property, value, 'important');
    }
    doc.documentElement.append(overlay);
  }
  overlay.style.setProperty('left', `${left}px`, 'important');
  overlay.style.setProperty('top', `${top}px`, 'important');
  overlay.style.setProperty('width', `${Math.max(0, width)}px`, 'important');
  overlay.style.setProperty('height', `${Math.max(0, height)}px`, 'important');
  overlay.style.setProperty('display', width > 0 && height > 0 ? 'block' : 'none', 'important');
}

/** Keeps the ring over `target` while the page (or a nested container) scrolls. */
function trackOverlay(target: Element): void {
  const view = target.ownerDocument.defaultView;
  if (view === null) return;
  stopTracking?.();
  const update = (): void => {
    if (overlayTarget !== undefined) positionOverlay(overlayTarget);
  };
  view.addEventListener('scroll', update, true);
  view.addEventListener('resize', update);
  overlayTarget = target;
  stopTracking = () => {
    view.removeEventListener('scroll', update, true);
    view.removeEventListener('resize', update);
  };
}

/**
 * Frames `selector`'s best match. When the selector matches several elements,
 * the element's own HTML `snippet` (parsed inertly) picks the one whose stable
 * attributes match, and an element already on screen wins over one that is not.
 * Returns `false` when the selector is invalid, matches nothing on the shown
 * document, or the document is not `expectedUrl` (the page the report was about)
 * - so a late command can never decorate a document the reader has navigated to.
 */
export function performBridgeHighlight(
  selector: string,
  doc: Document,
  expectedUrl?: string,
  snippet?: string,
): boolean {
  if (expectedUrl !== undefined && !isSameDocument(doc.location.href, expectedUrl)) return false;
  let candidates: Element[];
  try {
    candidates = queryAllDeep(doc, selector);
  } catch {
    return false;
  }
  const element = chooseTarget(
    candidates,
    snippet === undefined ? undefined : parseSnippet(doc, snippet),
  );
  if (element === undefined) return false;
  clearHighlight();
  highlighted = element;
  const target = element as HTMLElement;
  savedOutline = {
    value: target.style.getPropertyValue('outline'),
    priority: target.style.getPropertyPriority('outline'),
  };
  savedOutlineOffset = {
    value: target.style.getPropertyValue('outline-offset'),
    priority: target.style.getPropertyPriority('outline-offset'),
  };
  target.style.setProperty('outline', HIGHLIGHT_OUTLINE, 'important');
  target.style.setProperty('outline-offset', HIGHLIGHT_OFFSET, 'important');
  if (!isVisibleInViewport(target)) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  trackOverlay(target);
  positionOverlay(target);
  return true;
}
