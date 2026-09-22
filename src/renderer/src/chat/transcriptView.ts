import { el } from '../lib/dom';
import { EMPTY_LINK_CONTEXT, MESSAGE_LINK_ATTRIBUTE, type LinkContext } from './aemLinkTargets';
import { createMarkdownRenderer, type MarkdownRenderer } from './renderMarkdown';
import { describeRequiredAction, describeToolCallStatus } from './transcriptViewModel';
import { describeToolCall } from './toolCallDetails';
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

/**
 * The disclosure control of a tool-call billet: the requested icon, the
 * `name - status` label (kept as its own `.chat-tool-call__header` element
 * because the E2E asserts that exact text), an optional one-line summary of
 * the request, and a chevron whose rotation `chat.css` drives off the
 * `chat-tool-call--expanded` class.
 *
 * The whole row is the toggle, so the billet behaves like the tool-call
 * entries of other harnesses: a compact line that opens on click to show what
 * was sent. See `toggleToolCallExpansion` for the state transition.
 */
function renderToolCallToggle(
  view: ToolCallView,
  toolCallId: string,
  expanded: boolean,
): HTMLButtonElement {
  const { summary } = describeToolCall(view.toolName, view.args);
  const toggle = el('button', {
    attrs: {
      type: 'button',
      class: 'chat-tool-call__toggle',
      'data-tool-call-toggle': toolCallId,
      'aria-expanded': String(expanded),
      title: expanded ? 'Hide call details' : 'Show call details',
    },
  });
  toggle.append(
    el('sp-icon-actions', { attrs: { class: 'chat-tool-call__icon', size: 's' } }),
    el('span', {
      attrs: { class: 'chat-tool-call__header' },
      text: `${view.toolName} \u2014 ${describeToolCallStatus(view.status)}`,
    }),
  );
  if (summary !== undefined && summary !== '') {
    toggle.append(el('span', { attrs: { class: 'chat-tool-call__summary' }, text: summary }));
  }
  toggle.append(
    el('sp-icon-chevron-down', { attrs: { class: 'chat-tool-call__chevron', size: 's' } }),
  );
  return toggle;
}

/**
 * The label/value rows revealed when a billet is expanded. Every value is set
 * through `textContent`: these are model-authored strings, so this is a
 * second `queryResultViewModel.ts`-style boundary and must never be parsed as
 * markup.
 */
function renderToolCallParameters(view: ToolCallView, expanded: boolean): HTMLElement {
  const { parameters } = describeToolCall(view.toolName, view.args);
  const container = el('div', {
    attrs: { class: 'chat-tool-call__params' },
    children: parameters.map((parameter) =>
      el('div', {
        attrs: { class: 'chat-tool-call__param' },
        children: [
          el('span', {
            attrs: { class: 'chat-tool-call__param-label' },
            text: parameter.label,
          }),
          el('span', {
            attrs: { class: 'chat-tool-call__param-value' },
            text: parameter.value,
          }),
        ],
      }),
    ),
  });
  // `hidden` rather than removal: a repaint rebuilds these rows anyway, so
  // removal would buy nothing, while keeping one code path lets tests assert
  // on the rows' text regardless of expansion. `hidden` still removes them
  // from rendering and the accessibility tree while collapsed.
  container.hidden = !expanded;
  return container;
}

function renderToolCallBody(
  view: ToolCallView | undefined,
  toolCallId: string,
  expanded: boolean,
): readonly HTMLElement[] {
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
    renderToolCallToggle(view, toolCallId, expanded),
    renderToolCallParameters(view, expanded),
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
    // The error text stays outside the disclosure so a failure is never
    // hidden behind a collapsed billet.
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
  // Per-tool-call disclosure state, keyed by `toolCallId`. It lives here, not
  // on the DOM, because `updateShell` rebuilds a billet's children on every
  // repaint (a streaming delta repaints the whole transcript); DOM-held open
  // state would be discarded every tick. Only calls the reader has toggled
  // appear here - an absent entry means the default, collapsed.
  const expandedToolCalls = new Set<string>();
  const getLinkContext = options.getLinkContext ?? (() => EMPTY_LINK_CONTEXT);

  /** Applies an expansion state to an already-rendered billet, without a full repaint. */
  function applyToolCallExpansion(shell: HTMLElement, expanded: boolean): void {
    shell.classList.toggle('chat-tool-call--expanded', expanded);
    const toggle = shell.querySelector('.chat-tool-call__toggle');
    if (toggle !== null) {
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.setAttribute('title', expanded ? 'Hide call details' : 'Show call details');
    }
    const params = shell.querySelector<HTMLElement>('.chat-tool-call__params');
    if (params !== null) params.hidden = !expanded;
  }

  function toggleToolCallExpansion(toggle: Element): void {
    const toolCallId = toggle.getAttribute('data-tool-call-toggle');
    const shell = toggle.closest<HTMLElement>('.chat-tool-call');
    if (toolCallId === null || shell === null) return;
    const expanded = toggle.getAttribute('aria-expanded') !== 'true';
    if (expanded) {
      expandedToolCalls.add(toolCallId);
    } else {
      expandedToolCalls.delete(toolCallId);
    }
    applyToolCallExpansion(shell, expanded);
  }

  // One delegated listener, attached for the view's lifetime. A click on a
  // tool-call billet toggles its disclosure; otherwise it only acts on anchors
  // the markdown renderer stamped as openable (`data-daisy-link`), so an
  // external or unrecognised link falls through to the browser's default -
  // which the app's own `will-navigate` guard then refuses. `closest` is read
  // defensively because a click's target may be a text node (or shadow content
  // retargeted to its host).
  element.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const toggle = target?.closest?.('[data-tool-call-toggle]') ?? null;
    if (toggle !== null) {
      event.preventDefault();
      toggleToolCallExpansion(toggle);
      return;
    }
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
        const expanded = expandedToolCalls.has(item.toolCallId);
        shell.className =
          view === undefined
            ? 'chat-tool-call'
            : `chat-tool-call chat-tool-call--${view.status.kind}`;
        if (expanded) shell.classList.add('chat-tool-call--expanded');
        shell.replaceChildren(...renderToolCallBody(view, item.toolCallId, expanded));
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
