import {
  DOM_READ_HTML_LIMIT,
  DOM_READ_TEXT_LIMIT,
  DOM_READ_TOTAL_LIMIT,
  type WebviewBridgeDomItem,
  type WebviewBridgeDomResult,
  type WebviewBridgeReadCommand,
} from '../shared/contracts/webviewBridge';

/**
 * The decision logic of the DOM read, extracted from `webview-preload.ts` for
 * the same reason `bridgeFetch.ts` is: the preload file stays wiring, and every
 * rule is stated once where it is enforced.
 *
 * - It only reads. `textContent`, `outerHTML` and `getAttribute` return strings;
 *   nothing from the page is evaluated, and the selector is handed to
 *   `querySelectorAll` and nowhere else.
 * - It reads the document the pane is showing. The one other document it will
 *   enter is a same-origin `iframe` named by the command's `frame` selector (the
 *   editor's content frame); a cross-origin frame has no `contentDocument`, so
 *   it is refused by the platform, not by a check here that could be wrong.
 * - Everything is bounded: items by `limit`, one item's text and markup by a
 *   per-item cap, and the whole reply by a total budget, so a page cannot make
 *   the reply arbitrarily large.
 */
export function performBridgeRead(
  command: WebviewBridgeReadCommand,
  doc: Document,
): WebviewBridgeDomResult {
  let scope: Document = doc;
  if (command.frame !== undefined) {
    const frame = findFrameDocument(doc, command.frame);
    if (frame === undefined) return { status: 'frame_unavailable' };
    scope = frame;
  }

  let matches: NodeListOf<Element>;
  try {
    matches = scope.querySelectorAll(command.selector);
  } catch {
    return { status: 'invalid_selector' };
  }

  const wantHtml = command.include === 'html';
  const textLimit = wantHtml ? DOM_READ_HTML_LIMIT : DOM_READ_TEXT_LIMIT;
  const items: WebviewBridgeDomItem[] = [];
  let truncated = matches.length > command.limit;
  let budget = DOM_READ_TOTAL_LIMIT;

  for (const element of Array.from(matches).slice(0, command.limit)) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const raw = wantHtml ? element.outerHTML : normalizeText(element.textContent ?? '');
    const cap = Math.min(textLimit, budget);
    const content = raw.length > cap ? raw.slice(0, cap) : raw;
    if (content.length < raw.length) truncated = true;
    budget -= content.length;

    const attributes = readAttributes(element, command.attributes);
    items.push({
      tag: element.tagName.toLowerCase(),
      ...(wantHtml ? { html: content } : { text: content }),
      ...(attributes === undefined ? {} : { attributes }),
    });
  }

  return {
    status: 'ok',
    url: doc.location?.href ?? '',
    title: doc.title,
    matched: matches.length,
    items,
    truncated,
  };
}

function findFrameDocument(doc: Document, selector: string): Document | undefined {
  let frame: Element | null;
  try {
    frame = doc.querySelector(selector);
  } catch {
    return undefined;
  }
  if (frame === null || frame.tagName.toLowerCase() !== 'iframe') return undefined;
  try {
    return (frame as HTMLIFrameElement).contentDocument ?? undefined;
  } catch {
    return undefined;
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function readAttributes(
  element: Element,
  names: readonly string[] | undefined,
): Record<string, string> | undefined {
  if (names === undefined || names.length === 0) return undefined;
  const found: Record<string, string> = {};
  for (const name of names) {
    const value = element.getAttribute(name);
    if (value !== null) found[name] = value;
  }
  return Object.keys(found).length === 0 ? undefined : found;
}
