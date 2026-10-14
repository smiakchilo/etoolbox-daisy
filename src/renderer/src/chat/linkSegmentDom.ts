import {
  MESSAGE_ACTIONS_ATTRIBUTE,
  MESSAGE_EXTERNAL_ATTRIBUTE,
  MESSAGE_LINK_ATTRIBUTE,
  MESSAGE_PARTIAL_CLASS,
  serializeLinkActions,
  type MessageSegment,
  type ResolvedLink,
} from './linkTargets';

/**
 * The DOM rendering of the one AEM linkifier's output.
 *
 * `linkTargets.ts` decides *what* is a link (a full AEM path, a page-relative
 * CRX target, or text) and returns segments; this module is the single place
 * those segments become nodes. Both surfaces call it - `renderMarkdown.ts`
 * (with the window it was constructed from) and `transcriptView.ts` (with the
 * transcript document) - so an anchor or a partial looks and behaves
 * identically wherever a path appears: in prose, in a markdown table, or in a
 * `format_table` cell.
 *
 * It touches no globals: the `Document` is passed in, so the markdown renderer
 * keeps its injected-window contract and the table renderer can use the ambient
 * one.
 */

/**
 * Stamps a resolved link onto an existing anchor - the marker for where it
 * opens, the external-link title, and any popover actions. Used for the anchors
 * a message already contained (which `renderMarkdown.ts` classifies) as well as
 * the ones {@link renderLinkSegment} creates, so both carry identical stamps.
 */
export function stampResolvedLink(anchor: HTMLElement, resolved: ResolvedLink): void {
  anchor.setAttribute(
    resolved.openIn === 'external' ? MESSAGE_EXTERNAL_ATTRIBUTE : MESSAGE_LINK_ATTRIBUTE,
    '',
  );
  if (resolved.openIn === 'external') {
    anchor.setAttribute('title', 'Opens in your browser');
  }
  if (resolved.actions.length > 0) {
    anchor.setAttribute(MESSAGE_ACTIONS_ATTRIBUTE, serializeLinkActions(resolved.actions));
  }
}

/**
 * One linkifier segment as a DOM node: text is a text node; a full path is an
 * anchor stamped by {@link stampResolvedLink}; a page-relative partial is a
 * plain, non-navigating `<span>` whose only affordance is its node's CRX
 * popover (no `data-daisy-link`, no `href`, no hover styling).
 */
export function renderLinkSegment(doc: Document, segment: MessageSegment): Node {
  if (segment.kind === 'text') return doc.createTextNode(segment.value);

  if (!segment.navigable) {
    const span = doc.createElement('span');
    span.className = MESSAGE_PARTIAL_CLASS;
    span.textContent = segment.value;
    span.setAttribute(MESSAGE_ACTIONS_ATTRIBUTE, serializeLinkActions(segment.resolved.actions));
    return span;
  }

  const anchor = doc.createElement('a');
  anchor.setAttribute('href', segment.resolved.href);
  stampResolvedLink(anchor, segment.resolved);
  anchor.textContent = segment.value;
  return anchor;
}
