import { el } from '../lib/dom';
import { createMarkdownRenderer, type MarkdownRenderer } from './renderMarkdown';
import { describeToolCallStatus, describeRequiredAction } from './transcriptViewModel';
import { readQueryResultTable, type QueryResultTable } from './queryResultViewModel';
import type { TranscriptItem, TranscriptStore, ToolCallView } from './transcriptStore';

export interface TranscriptView {
  readonly element: HTMLElement;
  /** Repaints the transcript from `store`'s current items and text. Call when `store.takeDirty()` is true. */
  repaint(store: TranscriptStore): void;
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
    default: {
      const exhaustive: never = item;
      return exhaustive;
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
): TranscriptView {
  const element = el('div', { attrs: { class: 'chat-transcript__messages' } });
  const cache = new Map<string, HTMLElement>();

  function createShell(item: TranscriptItem): HTMLElement {
    switch (item.kind) {
      case 'userPrompt':
        return el('p', { attrs: { class: 'chat-message chat-message--user' } });
      case 'message':
        return el('div', { attrs: { class: 'chat-message chat-message--assistant' } });
      case 'toolCall':
        return el('div', { attrs: { class: 'chat-tool-call' } });
      default: {
        const exhaustive: never = item;
        return exhaustive;
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
        shell.innerHTML = markdownRenderer.render(store.textForMessage(item.messageId));
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
      default: {
        const exhaustive: never = item;
        return exhaustive;
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
