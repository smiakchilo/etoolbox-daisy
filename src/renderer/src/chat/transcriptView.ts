import { el } from '../lib/dom';
import { EMPTY_LINK_CONTEXT, MESSAGE_LINK_ATTRIBUTE, type LinkContext } from './aemLinkTargets';
import { createMarkdownRenderer, type MarkdownRenderer } from './renderMarkdown';
import { describeRequiredAction, describeToolCallStatus } from './transcriptViewModel';
import { type QueryResultTable, readQueryResultTable } from './queryResultViewModel';
import type { ToolCallView, TranscriptItem, TranscriptStore } from './transcriptStore';

export interface TranscriptView {
  readonly element: HTMLElement;
  /** Repaints the transcript from `store`'s current items and text. Call when `store.takeDirty()` is true. */
  repaint(store: TranscriptStore): void;
}

export interface TranscriptViewOptions {
  /**
   * The live link context (host origins + active AEM origin) each message is
   * rendered against. Read on every repaint, so a navigation or a settings
   * change is reflected as soon as the caller re-renders (see `chatPane.ts`).
   */
  readonly getLinkContext?: () => LinkContext;
  /**
   * Invoked with the resolved URL of a message link the reader clicked. Only
   * anchors `renderMarkdown.ts` stamped as openable are routed here; every
   * other link is left to the browser's own (blocked) default.
   */
  readonly onOpenLink?: (url: string) => void;
}

/** Stable identity for an item's cached DOM node - see `createTranscriptView`'s doc comment for why this matters. */
function keyFor(item: TranscriptItem): string {
  switch (item.kind) {
    case 'userPrompt':
      return `userPrompt:${item.turnId}`;
    case 'message':
      return `message:${item.messageId}`;
    case 'toolCall':
      return `toolCall:${item.toolCallId}`;
    case 'thinking':
      return 'thinking';
    default: {
      return item;
    }
  }
}

/**
 * Renders a query result as a Spectrum `<sp-table>` plus its pagination
 * status line.
 *
 * Every cell is set through `text:` (i.e. `textContent`), never through
 * `innerHTML`: these strings are JCR property values that came from an AEM
 * instance, and an author can put anything in a `jcr:title`. Assistant
 * message text goes through the markdown renderer, which sanitises; tool
 * result data has no such pass and must never be parsed as HTML here.
 */
function renderQueryResultTable(table: QueryResultTable): readonly HTMLElement[] {
  const status = el('p', {
    attrs: { class: 'chat-tool-call__pagination' },
    text: table.status,
  });

  if (table.rows.length === 0) return [status];

  const head = el('sp-table-head', {});
  head.append(
    ...table.columns.map((column) => el('sp-table-head-cell', { attrs: {}, text: column })),
  );

  const body = el('sp-table-body', {});
  for (const row of table.rows) {
    const rowEl = el('sp-table-row', {});
    rowEl.append(...row.map((cell) => el('sp-table-cell', { attrs: {}, text: cell })));
    body.append(rowEl);
  }

  const tableEl = el('sp-table', {
    attrs: { class: 'chat-tool-call__table', size: 's' },
  });
  tableEl.append(head, body);
  return [tableEl, status];
}

function renderToolCallBody(view: ToolCallView | undefined): readonly HTMLElement[] {
  if (view === undefined) {
    // A tool call this store never recorded `requested` for - see
    // `transcriptStore.ts`'s `updateToolCallStatus` doc comment for why this
    // can only happen if the event stream violates its own ordering
    // guarantee. Rendered as an honest "unknown" placeholder rather than
    // throwing, since a rendering bug should not take down the whole
    // transcript.
    return [el('p', { attrs: { class: 'chat-tool-call__header' }, text: 'Unknown tool call' })];
  }

  const nodes: HTMLElement[] = [
    el('p', {
      attrs: { class: 'chat-tool-call__header' },
      text: `${view.toolName} \u2014 ${describeToolCallStatus(view.status)}`,
    }),
  ];

  if (view.status.kind === 'succeeded') {
    const table = readQueryResultTable(view.toolName, view.status.data);
    if (table !== undefined) nodes.push(...renderQueryResultTable(table));
  }

  if (view.status.kind === 'rejected') {
    nodes.push(el('p', { attrs: { class: 'chat-tool-call__detail' }, text: view.status.reason }));
  }

  if (view.status.kind === 'failed') {
    // The explicit, mandatory case (implementation-plan.md step 07): a
    // failed tool call must show the error message and the suggested
    // action, and must be structurally distinguishable from a completed
    // one - see this function's caller, which puts a
    // `chat-tool-call--failed` class on the whole card, not just this text.
    nodes.push(
      el('p', { attrs: { class: 'chat-tool-call__detail' }, text: view.status.error.message }),
    );
    const action = describeRequiredAction(view.status.error.requiredAction);
    if (action !== undefined) {
      nodes.push(el('p', { attrs: { class: 'chat-tool-call__action' }, text: action }));
    }
  }

  return nodes;
}

/**
 * Renders a `TranscriptStore`'s items into `element`.
 *
 * Each item gets one persistent DOM node, cached by `keyFor` and reused
 * across repaints rather than rebuilt from scratch every tick. This matters
 * for exactly one correctness property: an assistant message's node's
 * `innerHTML` must be REPLACED on every repaint (mirroring
 * `messageStream.ts`'s "`assistant.message.completed` replaces
 * delta-accumulated text" rule at the DOM layer), never appended to - a
 * rebuild-from-scratch design would hide an append-instead-of-replace bug,
 * because a fresh node starts empty and one `+=` onto `""` looks identical
 * to one `=`. Reusing the same node across the "streaming" and "completed"
 * repaints is what actually exercises that rule.
 */
export function createTranscriptView(
  markdownRenderer: MarkdownRenderer = createMarkdownRenderer(window),
  options: TranscriptViewOptions = {},
): TranscriptView {
  const element = el('div', { attrs: { class: 'chat-transcript__messages' } });
  const cache = new Map<string, HTMLElement>();
  const getLinkContext = options.getLinkContext ?? (() => EMPTY_LINK_CONTEXT);

  // One delegated listener, attached for the view's lifetime. It only acts on
  // anchors the markdown renderer stamped as openable (`data-daisy-link`), so
  // an external or unrecognised link falls through to the browser's default -
  // which the app's own `will-navigate` guard then refuses. `closest` is read
  // defensively because a click's target may be a text node.
  element.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const anchor = target?.closest?.(`a[${MESSAGE_LINK_ATTRIBUTE}]`) ?? null;
    const href = anchor?.getAttribute('href') ?? null;
    if (href === null) return;
    event.preventDefault();
    options.onOpenLink?.(href);
  });

  function createShell(item: TranscriptItem): HTMLElement {
    switch (item.kind) {
      case 'userPrompt':
        return el('p', { attrs: { class: 'chat-message chat-message--user' } });
      case 'message':
        return el('div', { attrs: { class: 'chat-message chat-message--assistant' } });
      case 'toolCall':
        return el('div', { attrs: { class: 'chat-tool-call' } });
      case 'thinking':
        // Static content (spinner + label), built once here rather than in
        // `updateShell`, so a repaint triggered by an unrelated tool event
        // does not recreate the spinner and restart its animation.
        return el('div', {
          attrs: { class: 'chat-message chat-message--thinking' },
          children: [
            // `label` is screen-reader-only here (the component renders only
            // its track/fills plus a deprecated label slot); the visible text
            // is the sibling span, so the two cannot duplicate.
            el('sp-progress-circle', {
              attrs: { size: 's', indeterminate: '', label: 'Thinking' },
            }),
            el('span', {
              attrs: { class: 'chat-message__thinking-label' },
              text: 'Thinking\u2026',
            }),
          ],
        });
      default: {
        return item;
      }
    }
  }

  function updateShell(store: TranscriptStore, item: TranscriptItem, shell: HTMLElement): void {
    switch (item.kind) {
      case 'userPrompt':
        shell.textContent = store.textForUserPrompt(item.turnId);
        return;
      case 'message':
        // Must fully REPLACE the node's content on every call, never append
        // to it - see this function's doc comment for why reusing the same
        // node across repaints is what makes this assignment meaningful.
        shell.innerHTML = markdownRenderer.render(
          store.textForMessage(item.messageId),
          getLinkContext(),
        );
        return;
      case 'toolCall': {
        const view = store.toolCallFor(item.toolCallId);
        shell.className =
          view === undefined
            ? 'chat-tool-call'
            : `chat-tool-call chat-tool-call--${view.status.kind}`;
        shell.replaceChildren(...renderToolCallBody(view));
        return;
      }
      case 'thinking':
        // Nothing to update - see `createShell`'s thinking case.
        return;
      default: {
        return item;
      }
    }
  }

  return {
    element,
    repaint(store) {
      const items = store.items();
      const seenKeys = new Set<string>();
      const nodes: HTMLElement[] = [];

      for (const item of items) {
        const key = keyFor(item);
        seenKeys.add(key);
        let shell = cache.get(key);
        if (shell === undefined) {
          shell = createShell(item);
          cache.set(key, shell);
        }
        updateShell(store, item, shell);
        nodes.push(shell);
      }

      // Bounds the cache to the chat currently displayed - a stale node from
      // a since-closed/replaced conversation must not linger and be
      // resurrected if a future item happens to reuse its key.
      for (const key of cache.keys()) {
        if (!seenKeys.has(key)) cache.delete(key);
      }

      element.replaceChildren(...nodes);
    },
  };
}
