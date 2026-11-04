/**
 * The decision logic of the report's element highlight, extracted from
 * `webview-preload.ts` for the same reason `bridgeFetch.ts` and `bridgeRead.ts`
 * are: the preload file stays wiring, and every rule is stated once where it is
 * enforced.
 *
 * - It only reads and decorates. The selector is handed to `querySelector` and
 *   nowhere else (a CSS selector, never script), and the decoration is an
 *   inline `outline` on the matched element - nothing from the page is
 *   evaluated.
 * - The highlight is **persistent**: it stays until the page navigates (the
 *   document is replaced) or a different selector is clicked, which moves it.
 * - Exactly one element is highlighted at a time, tracked in this module's own
 *   state, so a new click clears the previous outline before applying the next.
 */

const HIGHLIGHT_OUTLINE = '3px solid #0d66d0';

let highlighted: Element | undefined;

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

/** Removes the outline from the element previously highlighted, if any. */
function clearHighlight(): void {
  if (highlighted === undefined) return;
  (highlighted as HTMLElement).style.outline = '';
  (highlighted as HTMLElement).style.outlineOffset = '';
  highlighted = undefined;
}

/**
 * Scrolls `selector`'s first match into view and outlines it. Returns `false`
 * when the selector is invalid, matches nothing on the shown document, or the
 * document is not `expectedUrl` (the page the report was about) - so a late
 * command can never decorate a document the reader has since navigated to.
 */
export function performBridgeHighlight(
  selector: string,
  doc: Document,
  expectedUrl?: string,
): boolean {
  if (expectedUrl !== undefined && !isSameDocument(doc.location.href, expectedUrl)) return false;
  let element: Element | null;
  try {
    element = doc.querySelector(selector);
  } catch {
    return false;
  }
  if (element === null) return false;
  clearHighlight();
  highlighted = element;
  const target = element as HTMLElement;
  target.style.outline = HIGHLIGHT_OUTLINE;
  target.style.outlineOffset = '2px';
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}
