import {
  DOM_READ_HTML_LIMIT,
  DOM_READ_REDACTED_VALUE,
  DOM_READ_TEXT_LIMIT,
  DOM_READ_TIME_BUDGET_MS,
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
 *   the reply arbitrarily large. The loop also stops at a wall-clock budget, and
 *   a match that is never reached costs nothing - the list is walked by index
 *   and the text is cut as it is built, never materialised and then trimmed.
 * - **Secrets are withheld.** This reply reaches the model and the chat journal,
 *   and a signed-in page carries values no model should see: a CSRF hidden
 *   field, a password field, a token in a `data-` attribute, an inline script.
 *   An attribute whose name looks like a credential, and a hidden or password
 *   input's `value`, are replaced with a fixed placeholder (so a reader knows one
 *   was withheld, rather than believing the page had none); inline `script` and
 *   `style` elements are dropped from `html`; and the result says `redacted`.
 */

/** Attribute names whose value is withheld rather than returned. */
const SENSITIVE_ATTRIBUTE = /token|csrf|secret|password|auth|nonce/i;

function isPasswordOrHiddenInput(element: Element): boolean {
  const type = element.getAttribute('type')?.toLowerCase();
  return element.tagName.toLowerCase() === 'input' && (type === 'password' || type === 'hidden');
}

function withholdsAttribute(element: Element, name: string): boolean {
  if (SENSITIVE_ATTRIBUTE.test(name)) return true;
  return name.toLowerCase() === 'value' && isPasswordOrHiddenInput(element);
}

/** `outerHTML` with credentials masked and inline script/style removed. */
function readableHtml(element: Element): { readonly html: string; readonly redacted: boolean } {
  const clone = element.cloneNode(true) as Element;
  let redacted = false;
  for (const script of Array.from(clone.querySelectorAll('script, style'))) {
    script.remove();
  }
  for (const node of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
    for (const attribute of Array.from(node.attributes)) {
      if (!withholdsAttribute(node, attribute.name)) continue;
      node.setAttribute(attribute.name, DOM_READ_REDACTED_VALUE);
      redacted = true;
    }
  }
  return { html: clone.outerHTML, redacted };
}

/** Reads the whole document. */
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
  const matched = matches.length;
  let truncated = matched > command.limit;
  let redacted = false;
  let budget = DOM_READ_TOTAL_LIMIT;
  const deadline = Date.now() + DOM_READ_TIME_BUDGET_MS;

  for (let index = 0; index < matched && items.length < command.limit; index += 1) {
    if (budget <= 0 || Date.now() > deadline) {
      truncated = true;
      break;
    }
    const element = matches[index];
    if (element === undefined) continue;
    const cap = Math.min(textLimit, budget);
    let content: string;
    let fullLength: number;
    if (wantHtml) {
      const readable = readableHtml(element);
      redacted ||= readable.redacted;
      fullLength = readable.html.length;
      content = fullLength > cap ? readable.html.slice(0, cap) : readable.html;
    } else {
      const raw = normalizeText(element.textContent ?? '');
      fullLength = raw.length;
      content = fullLength > cap ? raw.slice(0, cap) : raw;
    }
    if (content.length < fullLength) truncated = true;
    budget -= content.length;

    const attributes = readAttributes(element, command.attributes);
    if (attributes?.redacted === true) redacted = true;
    items.push({
      tag: element.tagName.toLowerCase(),
      ...(wantHtml ? { html: content } : { text: content }),
      ...(attributes?.values === undefined ? {} : { attributes: attributes.values }),
    });
  }

  return {
    status: 'ok',
    url: doc.location?.href ?? '',
    title: doc.title,
    matched,
    items,
    truncated,
    ...(redacted ? { redacted: true } : {}),
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

interface ReadAttributes {
  readonly values?: Record<string, string>;
  readonly redacted: boolean;
}

function readAttributes(
  element: Element,
  names: readonly string[] | undefined,
): ReadAttributes | undefined {
  if (names === undefined || names.length === 0) return undefined;
  const found: Record<string, string> = {};
  let redacted = false;
  for (const name of names) {
    const value = element.getAttribute(name);
    if (value === null) continue;
    if (withholdsAttribute(element, name)) {
      found[name] = DOM_READ_REDACTED_VALUE;
      redacted = true;
    } else {
      found[name] = value;
    }
  }
  return { ...(Object.keys(found).length === 0 ? {} : { values: found }), redacted };
}
