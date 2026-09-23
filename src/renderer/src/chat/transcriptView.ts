import { el } from '../lib/dom';
import {
  EMPTY_LINK_CONTEXT,
  MESSAGE_EXTERNAL_ATTRIBUTE,
  MESSAGE_LINK_ATTRIBUTE,
  resolveMessageLink,
  type LinkContext,
} from './linkTargets';
import { createLinkActionPopover, type LinkActionPopover } from './linkActionPopover';
import { createMarkdownRenderer, type MarkdownRenderer } from './renderMarkdown';
import {
  describeRequiredAction,
  describeToolCallStatus,
  latestReasoningLine,
} from './transcriptViewModel';
import { describeToolCall } from './toolCallDetails';
import { type QueryResultTable, readQueryResultTable } from './queryResultViewModel';
import type { ToolCallView, TranscriptItem, TranscriptStore } from './transcriptStore';

export interface TranscriptView {
  readonly element: HTMLElement;
  /** Repaints the transcript from `store`'s current items and text. Call when `store.takeDirty()` is true. */
  repaint(store: TranscriptStore): void;
  /** Removes the transcript's overlay and listeners. Call when the pane is torn down. */
  dispose(): void;
}

export interface TranscriptViewOptions {
  /**
   * The live link context (host origins + active AEM origin) each message is
   * rendered against. Read on every repaint, so a navigation or a settings
   * change is reflected as soon as the caller re-renders (see `chatPane.ts`).
   */
  readonly getLinkContext?: () => LinkContext;
  /**
   * Invoked with the resolved URL of a message link the reader clicked, for a
   * link the markdown renderer stamped as opening in the AEM pane.
   */
  readonly onOpenLink?: (url: string) => void;
  /**
   * Invoked with the URL of a message link whose origin is not a configured
   * AEM host, for the host to hand to the system browser. Only anchors stamped
   * as external are routed here; anything else is left to the browser's own
   * (blocked) default.
   */
  readonly onOpenExternal?: (url: string) => void;
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
 * Whether `element`'s children are exactly `nodes`, in order and by identity.
 *
 * A repaint reuses each item's cached node and applies content changes in place
 * (`updateShell`), so when the ordered list is unchanged there is nothing left
 * for the DOM to do. Skipping `replaceChildren` in that case is not just an
 * optimisation: re-inserting an already-mounted node detaches and re-attaches
 * it, which restarts any CSS animation it contains. The thinking spinner
 * visibly stuttered on every streamed reasoning delta because of exactly that.
 */
function hasSameChildren(element: HTMLElement, nodes: readonly HTMLElement[]): boolean {
  const children = element.children;
  if (children.length !== nodes.length) return false;
  for (let index = 0; index < nodes.length; index += 1) {
    if (children[index] !== nodes[index]) return false;
  }
  return true;
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
  // Whether the transient "Thinking" billet is expanded. A single boolean,
  // not a set: there is at most one such billet, it is erased when its
  // reasoning block ends, and `updateShell` resets this to `false` whenever
  // there is no reasoning text to expand - so a later block starts collapsed
  // again (the default the reader expects).
  let expandedThinking = false;
  const getLinkContext = options.getLinkContext ?? (() => EMPTY_LINK_CONTEXT);

  // The one travelling hover popover for pane links that offer actions. It is
  // undefined in a jsdom unit test (the Spectrum overlay is not registered
  // there) and in any environment where it is; `show`/`scheduleHide` below are
  // then simply inert.
  const popover: LinkActionPopover | undefined = createLinkActionPopover({
    onOpenLink: (url) => options.onOpenLink?.(url),
    getContainer: () => element.closest('sp-theme') ?? document.body,
  });
  // The link the popover is currently shown for, so repeated `pointerover`
  // events over one link do not rebuild its buttons.
  let hoveredLink: HTMLElement | undefined;

  function paneLinkFrom(target: EventTarget | null): HTMLAnchorElement | null {
    return (target as Element | null)?.closest?.(`a[${MESSAGE_LINK_ATTRIBUTE}]`) ?? null;
  }

  element.addEventListener('pointerover', (event) => {
    if (popover === undefined) return;
    const anchor = paneLinkFrom(event.target);
    if (anchor === null || anchor === hoveredLink) return;
    const href = anchor.getAttribute('href');
    if (href === null) return;
    const resolved = resolveMessageLink(href, getLinkContext());
    if (resolved === undefined || resolved.actions.length === 0) return;
    hoveredLink = anchor;
    popover.show(anchor, resolved.actions);
  });

  element.addEventListener('pointerout', (event) => {
    if (popover === undefined || hoveredLink === undefined) return;
    if (paneLinkFrom(event.target) !== hoveredLink) return;
    const related = event.relatedTarget as Node | null;
    // Moving to a child of the same link (or into the popover) must not hide it.
    if (related !== null && hoveredLink.contains(related)) return;
    hoveredLink = undefined;
    popover.scheduleHide();
  });

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

  /**
   * Applies the thinking billet's expansion state to an already-rendered shell.
   * Mirrors `applyToolCallExpansion`, with the extra "nothing to expand" case:
   * when the billet has no reasoning text the toggle is disabled and there is
   * no chevron, so the row cannot be opened onto an empty body.
   */
  function applyThinkingExpansion(shell: HTMLElement, expanded: boolean): void {
    shell.classList.toggle('chat-message--thinking--expanded', expanded);
    const toggle = shell.querySelector('.chat-message__thinking-toggle');
    if (toggle !== null) {
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.setAttribute('title', expanded ? 'Hide reasoning' : 'Show reasoning');
    }
    const body = shell.querySelector<HTMLElement>('.chat-message__thinking-body');
    if (body !== null) body.hidden = !expanded;
  }

  function toggleThinkingExpansion(toggle: Element): void {
    if (toggle.hasAttribute('disabled')) return;
    const shell = toggle.closest<HTMLElement>('.chat-message--thinking');
    if (shell === null) return;
    const expanded = toggle.getAttribute('aria-expanded') !== 'true';
    expandedThinking = expanded;
    applyThinkingExpansion(shell, expanded);
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
    const thinkingToggle = target?.closest?.('[data-thinking-toggle]') ?? null;
    if (thinkingToggle !== null) {
      event.preventDefault();
      toggleThinkingExpansion(thinkingToggle);
      return;
    }
    const anchor =
      target?.closest?.(`a[${MESSAGE_LINK_ATTRIBUTE}], a[${MESSAGE_EXTERNAL_ATTRIBUTE}]`) ?? null;
    const href = anchor?.getAttribute('href') ?? null;
    if (anchor === null || href === null) return;
    event.preventDefault();
    popover?.hideNow();
    hoveredLink = undefined;
    if (anchor.hasAttribute(MESSAGE_EXTERNAL_ATTRIBUTE)) {
      options.onOpenExternal?.(href);
    } else {
      options.onOpenLink?.(href);
    }
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
        // The whole structure (spinner, label, rolling line, chevron,
        // expandable body) is built once here rather than in `updateShell`, so
        // a repaint triggered by a streaming delta or an unrelated tool event
        // does not recreate the spinner and restart its animation. Only text
        // and visibility are updated per repaint.
        return el('div', {
          attrs: { class: 'chat-message chat-message--thinking' },
          children: [
            el('button', {
              attrs: {
                type: 'button',
                class: 'chat-message__thinking-toggle',
                'data-thinking-toggle': '',
                'aria-expanded': 'false',
              },
              children: [
                // `label` is screen-reader-only here (the component renders
                // only its track/fills plus a deprecated label slot); the
                // visible text is the sibling span, so the two cannot
                // duplicate.
                el('sp-progress-circle', {
                  attrs: { size: 's', indeterminate: '', label: 'Thinking' },
                }),
                el('span', {
                  attrs: { class: 'chat-message__thinking-label' },
                  text: 'Thinking',
                }),
                el('span', { attrs: { class: 'chat-message__thinking-line' } }),
                el('sp-icon-chevron-down', {
                  attrs: { class: 'chat-message__thinking-chevron', size: 's' },
                }),
              ],
            }),
            el('div', { attrs: { class: 'chat-message__thinking-body', hidden: '' } }),
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
      case 'thinking': {
        // The reasoning text is transient: `thinkingReasoning()` returns `""`
        // once the block ends, which empties the rolling line and the body and
        // collapses the billet - see `transcriptStore.ts`.
        const reasoning = store.thinkingReasoning();
        const line = shell.querySelector<HTMLElement>('.chat-message__thinking-line');
        if (line !== null) line.textContent = latestReasoningLine(reasoning);
        const body = shell.querySelector<HTMLElement>('.chat-message__thinking-body');
        if (body !== null) body.textContent = reasoning;
        const expandable = reasoning.length > 0;
        // Nothing to expand: the row is inert (disabled toggle, no chevron)
        // and any previous expansion is dropped so a later block starts
        // collapsed again.
        if (!expandable) expandedThinking = false;
        const toggle = shell.querySelector<HTMLButtonElement>('.chat-message__thinking-toggle');
        if (toggle !== null) toggle.disabled = !expandable;
        const chevron = shell.querySelector<HTMLElement>('.chat-message__thinking-chevron');
        if (chevron !== null) chevron.hidden = !expandable;
        applyThinkingExpansion(shell, expandable && expandedThinking);
        return;
      }
      default: {
        return item;
      }
    }
  }

  return {
    element,
    repaint(store) {
      // A repaint replaces the message nodes, so any open popover is now
      // anchored to a detached element - close it rather than leave it floating.
      popover?.hideNow();
      hoveredLink = undefined;
      const items = store.items();
      const seenKeys = new Set<string>();
      const nodes: HTMLElement[] = [];
      let sawThinking = false;

      for (const item of items) {
        const key = keyFor(item);
        seenKeys.add(key);
        if (item.kind === 'thinking') sawThinking = true;
        let shell = cache.get(key);
        if (shell === undefined) {
          shell = createShell(item);
          cache.set(key, shell);
        }
        updateShell(store, item, shell);
        nodes.push(shell);
      }

      // The billet is gone entirely (its turn ended): drop any expansion so
      // the next block starts collapsed. `updateShell` handles the case where
      // the item is still present but has no reasoning text.
      if (!sawThinking) expandedThinking = false;

      // Bounds the cache to the chat currently displayed - a stale node from
      // a since-closed/replaced conversation must not linger and be
      // resurrected if a future item happens to reuse its key.
      for (const key of cache.keys()) {
        if (!seenKeys.has(key)) cache.delete(key);
      }

      // Only touch the DOM when the ordered node list actually changed. See
      // `hasSameChildren`: re-inserting unchanged nodes restarts their CSS
      // animations, which made the thinking spinner stutter on every delta.
      if (!hasSameChildren(element, nodes)) element.replaceChildren(...nodes);
    },
    dispose() {
      popover?.dispose();
    },
  };
}
