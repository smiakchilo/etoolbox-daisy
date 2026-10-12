import type { JsonValue, ToolTableMessage } from '../../../shared';
import { el } from '../lib/dom';
import {
  EMPTY_LINK_CONTEXT,
  MESSAGE_ACTIONS_ATTRIBUTE,
  MESSAGE_EXTERNAL_ATTRIBUTE,
  MESSAGE_LINK_ATTRIBUTE,
  parseLinkActions,
  resolveMessageLink,
  serializeLinkActions,
  type LinkContext,
} from './linkTargets';
import { createLinkActionPopover, type LinkActionPopover } from './linkActionPopover';
import { createMarkdownRenderer, type MarkdownRenderer } from './renderMarkdown';
import {
  describeInterruption,
  describeRequiredAction,
  describeToolCallStatus,
  latestReasoningLine,
  splitLeadingSkill,
} from './transcriptViewModel';
import { describeToolCall } from './toolCallDetails';
import { toolRendererRegistry } from './toolRegistry';
import type {
  ToolCallStatus,
  ToolCallView,
  TranscriptItem,
  TranscriptStore,
} from './transcriptStore';

export interface TranscriptView {
  readonly element: HTMLElement;
  /**
   * Repaints the transcript from `store`'s current items and text. Call when
   * `store.takeDirty()` is true.
   *
   * Returns the elements of any **message the application just updated in
   * place** - an already-rendered `presentation: 'message'` run whose
   * accumulated content changed (a search table gaining a `Load more` page).
   * The pane reveals the last of these, so an update stays visible even for a
   * reader who scrolled up to read history. It is empty when nothing was
   * updated, in which case the ordinary stick-to-bottom rule applies. Streaming
   * assistant text is deliberately excluded: that is new content being written,
   * not a settled message changed under the reader.
   */
  repaint(store: TranscriptStore): readonly HTMLElement[];
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
  /**
   * The bundled skill names a prompt may invoke with a leading `/name`, read
   * on every repaint so a prompt recorded before the catalogue loaded is
   * re-rendered with a bold skill name once the catalogue is known - see
   * `chatPane.ts`'s `loadSkills`. Absent (a unit test) means no token is
   * treated as a skill.
   */
  readonly getKnownSkillNames?: () => readonly string[];
  /**
   * Invoked when the reader presses the Resume action on a "Session stopped"
   * notice: the pane sends `Resume` as an ordinary prompt, exactly as if it had
   * been typed. Only offered for a *live* notice (one this session recorded) and
   * only while it is the transcript's newest item; a notice replayed from the
   * journal, or one the conversation has since moved past, is historical and
   * shows no action. Absent (a unit test) means no notice offers an action.
   */
  readonly onResume?: () => void;
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
    case 'interruption':
      return `interruption:${item.interruptionId}`;
    default: {
      return item;
    }
  }
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
/**
 * The succeeded call's payload, handed to `describeCall` so a tool whose detail
 * lives in its result (rather than its arguments) can compose the collapsed
 * summary and the expansion rows. `undefined` while pending, and on failure -
 * a failure's message/action are rendered outside the disclosure regardless.
 */
function succeededData(view: ToolCallView): JsonValue | undefined {
  return view.status.kind === 'succeeded' ? view.status.data : undefined;
}

/**
 * The rendered content of a table message as one comparable string: everything
 * `renderTableMessage` depends on - the mode, total, columns and rows, plus the
 * link context (a `Path` cell's href is resolved against the active host). Used
 * to skip rebuilding a table that has not changed - see
 * `createTranscriptView`'s `renderedTableSignatures`.
 */
function tableMessageSignature(message: ToolTableMessage, context: LinkContext): string {
  return [
    message.mode,
    message.total ?? '',
    context.activeOrigin ?? '',
    context.hostOrigins.join(','),
    message.table.columns.join('\u0001'),
    message.table.rows.map((row) => row.join('\u0001')).join('\u0002'),
  ].join('\u0000');
}

/**
 * The *content* of a rendered table run - mode, total, columns and rows - with
 * no link context. This is the signature `repaint` compares across repaints to
 * decide a run was **updated by code** (a `Load more` page appended to it): a
 * `Path` cell whose href merely re-resolved against a new host is a re-render,
 * not an update, and must not force the transcript to reveal the table.
 */
function tableRunContentSignature(message: ToolTableMessage): string {
  return [
    message.mode,
    message.total ?? '',
    message.table.columns.join('\u0001'),
    message.table.rows.map((row) => row.join('\u0001')).join('\u0002'),
  ].join('\u0000');
}

/**
 * Whether `item` is a running tool call whose billet must be hidden because the
 * turn is blocked on an interactive question. Nothing is actively working while
 * the user is being asked, so a running *billet* is hidden exactly as the
 * "Thinking" item is. A call that renders as a conversation or a message (an
 * `ask_user` question, a `format_table` result) is never hidden - its rendering
 * is the very thing the user is answering or reading.
 */
function hiddenWhileAwaitingInput(store: TranscriptStore, item: TranscriptItem): boolean {
  if (item.kind !== 'toolCall' || !store.isAwaitingUserInput()) return false;
  const view = store.toolCallFor(item.toolCallId);
  if (view === undefined) return false;
  if (view.status.kind !== 'requested' && view.status.kind !== 'approved') return false;
  return toolRendererRegistry.presentationOf(view.toolName) === 'billet';
}

function renderToolCallToggle(
  view: ToolCallView,
  toolCallId: string,
  expanded: boolean,
): HTMLButtonElement {
  const { summary } = describeToolCall(view.toolName, view.args, succeededData(view));
  const toggle = el('button', {
    attrs: {
      type: 'button',
      class: 'chat-tool-call__toggle',
      'data-tool-call-toggle': toolCallId,
      'aria-expanded': String(expanded),
      title: expanded ? 'Hide call details' : 'Show call details',
    },
  });
  // A call that has been requested but not yet settled shows an indeterminate
  // spinner where the static tool icon otherwise sits, so a long call (a
  // semantic search reading every hit's content) is visibly working rather than
  // apparently stalled.
  const running = view.status.kind === 'requested' || view.status.kind === 'approved';
  toggle.append(
    running
      ? el('sp-progress-circle', {
          attrs: { class: 'chat-tool-call__icon', size: 's', indeterminate: '', label: 'Working' },
        })
      : el('sp-icon-actions', { attrs: { class: 'chat-tool-call__icon', size: 's' } }),
    el('span', {
      attrs: { class: 'chat-tool-call__header' },
      text: `${view.toolName} \u2014 ${describeToolCallStatus(view.status)}`,
    }),
  );
  if (summary !== undefined && summary !== '') {
    toggle.append(el('span', { attrs: { class: 'chat-tool-call__summary' }, text: summary }));
  }
  // Always present, even when empty: `updateShell` updates this span's text in
  // place on each progress tick rather than rebuilding the toggle, so the
  // running spinner's animation is never restarted (see `applyToolCallProgress`).
  const progressText = running ? (view.progress ?? '') : '';
  const progress = el('span', {
    attrs: { class: 'chat-tool-call__progress' },
    text: progressText,
  });
  progress.hidden = progressText === '';
  toggle.append(progress);
  toggle.append(
    el('sp-icon-chevron-down', { attrs: { class: 'chat-tool-call__chevron', size: 's' } }),
  );
  return toggle;
}

/**
 * The facts a tool-call billet's *body* is drawn from, apart from progress.
 * Compared by reference (the store keeps `args`/`status` objects stable across a
 * progress-only update) so a progress tick is recognised as "body unchanged"
 * without re-serialising large payloads - and so the toggle is not rebuilt,
 * which would restart the running spinner's CSS animation (the stutter the
 * "Thinking" billet was cured of). Progress is applied in place by
 * {@link applyToolCallProgress} instead.
 */
interface ToolCallBodyState {
  readonly toolName: string;
  readonly statusKind: ToolCallStatus['kind'];
  readonly expanded: boolean;
  readonly args: Readonly<Record<string, JsonValue>>;
  /** The status object (succeeded data / failed error / rejected reason), by reference. */
  readonly detail: unknown;
}

function toolCallBodyState(view: ToolCallView, expanded: boolean): ToolCallBodyState {
  const { status } = view;
  return {
    toolName: view.toolName,
    statusKind: status.kind,
    expanded,
    args: view.args,
    detail:
      status.kind === 'succeeded'
        ? status.data
        : status.kind === 'failed'
          ? status.error
          : status.kind === 'rejected'
            ? status.reason
            : undefined,
  };
}

function sameToolCallBody(
  previous: ToolCallBodyState | undefined,
  next: ToolCallBodyState,
): boolean {
  return (
    previous !== undefined &&
    previous.toolName === next.toolName &&
    previous.statusKind === next.statusKind &&
    previous.expanded === next.expanded &&
    previous.args === next.args &&
    previous.detail === next.detail
  );
}

/**
 * Writes a running call's progress line into its already-rendered billet without
 * rebuilding it. A settled call shows no progress; the span stays in the DOM but
 * hidden (see `renderToolCallToggle`).
 */
function applyToolCallProgress(shell: HTMLElement, view: ToolCallView): void {
  const progress = shell.querySelector<HTMLElement>('.chat-tool-call__progress');
  if (progress === null) return;
  const running = view.status.kind === 'requested' || view.status.kind === 'approved';
  const text = running ? (view.progress ?? '') : '';
  if (progress.textContent === text) return;
  progress.textContent = text;
  progress.hidden = text === '';
}

/**
 * The label/value rows revealed when a billet is expanded. Every value is set
 * through `textContent`: these are model-authored strings, so this is a
 * hard text boundary and must never be parsed as markup.
 */
function renderToolCallParameters(view: ToolCallView, expanded: boolean): HTMLElement {
  const { parameters } = describeToolCall(view.toolName, view.args, succeededData(view));
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
  const getKnownSkillNames = options.getKnownSkillNames ?? (() => []);

  // The content signature of the table last rendered into each message shell.
  // `updateShell` runs for every item on every repaint (a streaming delta
  // repaints the whole transcript), and rebuilding an unchanged `sp-table` is
  // not free: a freshly-created custom element has no height until it upgrades,
  // so the transcript momentarily collapses and the stick-to-bottom follower can
  // pin to the wrong place - the reported "the whole table was re-rendered and
  // the transcript jumped up to its top". A table is rebuilt only when its
  // rows, columns, total, or link context actually change.
  const renderedTableSignatures = new WeakMap<HTMLElement, string>();

  // The body state of the tool-call billet last rendered into each shell. A
  // repaint that changes only a running call's progress line must NOT rebuild
  // the billet: recreating the spinner element restarts its animation, which is
  // exactly the stutter the "Thinking" billet already fixed by updating in
  // place. See `ToolCallBodyState`.
  const renderedToolCallBodies = new WeakMap<HTMLElement, ToolCallBodyState>();

  // The content signature of each rendered table run as of the previous repaint,
  // keyed by the run's **stable start** (`runIds`), not by the call that happens
  // to render it now. A run whose signature changes between repaints is one the
  // application updated in place - a `Load more` page appended - so its message
  // is reported from `repaint` for the pane to reveal. Keying by the start, not
  // the rendered call, is what lets an append (which moves the rendered call)
  // read as the same run changing rather than a new one appearing.
  let renderedRunSignatures = new Map<string, string>();

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
    // The actions are read from the anchor, not re-derived from its href: a
    // `jcr:content` link's href is trimmed to the owning page, so re-classifying
    // it would retarget CRX at that page (see `MESSAGE_ACTIONS_ATTRIBUTE`).
    const actions = parseLinkActions(anchor.getAttribute(MESSAGE_ACTIONS_ATTRIBUTE));
    if (actions.length === 0) return;
    hoveredLink = anchor;
    popover.show(anchor, actions);
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
    const resume = target?.closest?.('[data-interruption-resume]') ?? null;
    if (resume !== null) {
      event.preventDefault();
      options.onResume?.();
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

  /**
   * One message node for a `'conversation'` tool's question/answer pair. The
   * question is model-authored and goes through the markdown renderer (which
   * sanitises); the answer is user-authored and is set as plain text.
   */
  function conversationMessage(kind: 'assistant' | 'user', text: string): HTMLElement {
    if (kind === 'assistant') {
      const node = el('div', { attrs: { class: 'chat-message chat-message--assistant' } });
      node.innerHTML = markdownRenderer.render(text, getLinkContext());
      return node;
    }
    return el('p', { attrs: { class: 'chat-message chat-message--user' }, text });
  }

  /**
   * Paints a `'conversation'` tool (`ask_user`) as messages instead of a
   * billet: the question as the agent's own message, then the user's answer as
   * a user message. Deliberately nothing is shown until the answer exists - a
   * pending question lives in the composer, not the transcript. A failed or
   * rejected call still shows the question, followed by the reason, so an
   * error is not hidden by the no-billet presentation.
   */
  function renderConversationShell(shell: HTMLElement, view: ToolCallView): void {
    shell.className = 'chat-ask-user';
    const conversation = toolRendererRegistry.readConversation(
      view.toolName,
      view.args,
      succeededData(view),
    );
    if (conversation === undefined) {
      shell.replaceChildren();
      return;
    }
    const children: HTMLElement[] = [];
    if (conversation.answer !== undefined) {
      children.push(conversationMessage('assistant', conversation.question));
      children.push(conversationMessage('user', conversation.answer));
    } else if (view.status.kind === 'failed' || view.status.kind === 'rejected') {
      children.push(conversationMessage('assistant', conversation.question));
      const reason = view.status.kind === 'failed' ? view.status.error.message : view.status.reason;
      children.push(el('p', { attrs: { class: 'chat-tool-call__detail' }, text: reason }));
    }
    shell.replaceChildren(...children);
  }

  /**
   * One table cell. A `Path` cell that resolves against the active host becomes
   * an anchor carrying the same link stamps the markdown renderer uses, so the
   * transcript's existing click/hover handling treats it exactly like a bare
   * path in a message. Every other cell is plain text (`textContent`), never
   * parsed as markup: these strings came from AEM and an author can put
   * anything in a `jcr:title`.
   */
  function renderMessageCell(value: string, header: string): HTMLElement {
    if (header === 'Path') {
      const resolved = resolveMessageLink(value, getLinkContext());
      if (resolved !== undefined) {
        const anchor = el('a', { attrs: { href: resolved.href }, text: value });
        anchor.setAttribute(
          resolved.openIn === 'external' ? MESSAGE_EXTERNAL_ATTRIBUTE : MESSAGE_LINK_ATTRIBUTE,
          '',
        );
        if (resolved.openIn === 'external') anchor.setAttribute('title', 'Opens in your browser');
        if (resolved.actions.length > 0) {
          anchor.setAttribute(MESSAGE_ACTIONS_ATTRIBUTE, serializeLinkActions(resolved.actions));
        }
        return anchor;
      }
    }
    const span = el('span', { text: value });
    // The Value/Citation column is clamped to a readable number of lines rather
    // than letting one long quote grow its row without bound (see chat.css).
    if (header === 'Value' || header === 'Citation') {
      span.className = 'chat-table-message__clamp';
    } else if (header === 'Property') {
      // A property name wraps at any character, exactly like the Path column's
      // link, so a long name cannot widen the table.
      span.className = 'chat-table-message__wrap';
    }
    return span;
  }

  /**
   * Renders one run's table as the assistant **message**: a Spectrum `<sp-table>`
   * with a leading `#` row-number column and, beneath it, an optional total line.
   * The columns come from the accumulated `format_table` calls; a zero-row run
   * renders only its total line (no empty table).
   */
  function renderTableMessage(message: ToolTableMessage): readonly HTMLElement[] {
    const nodes: HTMLElement[] = [];
    const { columns, rows } = message.table;
    if (rows.length > 0) {
      const head = el('sp-table-head', {});
      head.append(el('sp-table-head-cell', { attrs: {}, text: '#' }));
      for (const column of columns) {
        head.append(el('sp-table-head-cell', { attrs: {}, text: column }));
      }

      const body = el('sp-table-body', {});
      rows.forEach((row, index) => {
        const rowEl = el('sp-table-row', {});
        rowEl.append(
          el('sp-table-cell', {
            attrs: { class: 'chat-table-message__index' },
            text: String(index + 1),
          }),
        );
        columns.forEach((column, columnIndex) => {
          const cell = el('sp-table-cell', {});
          cell.append(renderMessageCell(row[columnIndex] ?? '', column));
          rowEl.append(cell);
        });
        body.append(rowEl);
      });

      const tableEl = el('sp-table', {
        attrs: { class: 'chat-table-message__table', size: 's' },
      });
      tableEl.append(head, body);
      nodes.push(tableEl);
    }
    if (message.total !== undefined) {
      nodes.push(el('p', { attrs: { class: 'chat-table-message__total' }, text: message.total }));
    }
    return nodes;
  }

  /**
   * Groups the transcript's `presentation: 'message'` tool calls into runs (a
   * `mode: 'new'` call starts one, `mode: 'append'` adds to it) and returns, for
   * each item, whether it renders nothing and which run-message it renders.
   *
   * Stateless and recomputed on every repaint: only the run's **last** call
   * renders the accumulated table (so a page's table replaces the previous one
   * and stays at the end), and every earlier call in the run renders nothing.
   * Columns are unioned across the run's pages, with each page's rows remapped
   * to the union so a later page cannot shift a cell under the wrong header.
   */
  function planTableRuns(
    store: TranscriptStore,
    items: readonly TranscriptItem[],
  ): {
    readonly skip: ReadonlySet<string>;
    readonly messages: ReadonlyMap<string, ToolTableMessage>;
    readonly runIds: ReadonlyMap<string, string>;
  } {
    const skip = new Set<string>();
    const messages = new Map<string, ToolTableMessage>();
    // The rendered message key -> the run's stable start key (its first call).
    // The rendered key moves as an append arrives; the start key does not, so
    // `repaint` can recognise the same run changing rather than a new one.
    const runIds = new Map<string, string>();
    interface Run {
      readonly keys: string[];
      readonly columns: string[];
      readonly pages: {
        readonly columns: readonly string[];
        readonly rows: readonly (readonly string[])[];
      }[];
      total: string | undefined;
    }
    let current: Run | undefined;

    const flush = (): void => {
      if (current === undefined) return;
      const run = current;
      current = undefined;
      const lastKey = run.keys[run.keys.length - 1];
      const firstKey = run.keys[0];
      if (lastKey !== undefined && firstKey !== undefined) {
        const rows = run.pages.flatMap((page) =>
          page.rows.map((row) =>
            run.columns.map((column) => {
              const index = page.columns.indexOf(column);
              return index === -1 ? '' : (row[index] ?? '');
            }),
          ),
        );
        messages.set(lastKey, {
          mode: 'new',
          total: run.total,
          table: { columns: run.columns, rows, status: '', mayHaveMore: false },
        });
        runIds.set(lastKey, firstKey);
      }
      // Everything before the last call of the run is hidden.
      for (let index = 0; index < run.keys.length - 1; index += 1) skip.add(run.keys[index]!);
    };

    for (const item of items) {
      if (item.kind !== 'toolCall') continue;
      const key = keyFor(item);
      const view = store.toolCallFor(item.toolCallId);
      if (view === undefined || toolRendererRegistry.presentationOf(view.toolName) !== 'message') {
        continue;
      }
      const message = toolRendererRegistry.readTableMessage(
        view.toolName,
        view.args,
        succeededData(view),
      );
      if (message === undefined) {
        // An unrecognised message call shows nothing - never a billet.
        skip.add(key);
        continue;
      }
      if (message.mode === 'new' || current === undefined) {
        flush();
        current = { keys: [key], columns: [], pages: [], total: undefined };
      } else {
        current.keys.push(key);
      }
      for (const column of message.table.columns) {
        if (!current.columns.includes(column)) current.columns.push(column);
      }
      current.pages.push({ columns: message.table.columns, rows: message.table.rows });
      current.total = message.total ?? current.total;
    }
    flush();
    return { skip, messages, runIds };
  }

  function createShell(item: TranscriptItem): HTMLElement {
    switch (item.kind) {
      case 'userPrompt':
        return el('p', { attrs: { class: 'chat-message chat-message--user' } });
      case 'message':
        return el('div', { attrs: { class: 'chat-message chat-message--assistant' } });
      case 'toolCall':
        return el('div', { attrs: { class: 'chat-tool-call' } });
      case 'interruption':
        // A borderless one-line notice, laid out like the thinking/tool billets
        // (icon + label) so it reads as transcript metadata rather than a
        // message bubble. The Resume action is appended by `updateShell` only
        // when the notice is live and still newest.
        return el('div', {
          attrs: { class: 'chat-message chat-message--interruption' },
          children: [
            el('sp-icon-cross600', {
              attrs: { class: 'chat-message__interruption-icon', size: 's' },
            }),
            el('span', { attrs: { class: 'chat-message__interruption-label' } }),
          ],
        });
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

  function updateShell(
    store: TranscriptStore,
    item: TranscriptItem,
    shell: HTMLElement,
    isLast: boolean,
    tableMessage?: ToolTableMessage,
  ): void {
    switch (item.kind) {
      case 'userPrompt': {
        const text = store.textForUserPrompt(item.turnId);
        const segments = splitLeadingSkill(text, getKnownSkillNames());
        // A leading `/skillname` that names a bundled skill reads bold, so the
        // reader can tell a skill invocation from ordinary prose. Everything
        // else is the user's plain text; `replaceChildren` (not innerHTML)
        // keeps this a text boundary.
        if (!segments.skill) {
          shell.textContent = text;
          return;
        }
        shell.replaceChildren(
          el('strong', { attrs: { class: 'chat-message__skill' }, text: segments.leading }),
          segments.trailing,
        );
        return;
      }
      case 'interruption': {
        const label = shell.querySelector<HTMLElement>('.chat-message__interruption-label');
        if (label !== null) label.textContent = describeInterruption(item.reason);
        // The Resume action is offered only for a live "Session stopped" notice
        // that is still the transcript's newest item, and only when the host
        // wired a handler. A navigation notice names an app-initiated abort, and
        // anything replayed from the journal or since moved past is history -
        // neither offers the action.
        const showResume =
          item.reason === 'stopped' && item.resumable && isLast && options.onResume !== undefined;
        const existing = shell.querySelector<HTMLElement>('[data-interruption-resume]');
        if (showResume && existing === null) {
          shell.append(
            el('sp-action-button', {
              attrs: {
                class: 'chat-message__interruption-resume',
                quiet: '',
                'data-interruption-resume': '',
              },
              text: 'Resume',
            }),
          );
        } else if (!showResume && existing !== null) {
          existing.remove();
        }
        return;
      }
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
        if (tableMessage !== undefined) {
          // A `presentation: 'message'` tool (format_table): its call paints an
          // assistant message - the accumulated table - not a billet. Rebuilt
          // only when its content changed (see `renderedTableSignatures`).
          shell.className = 'chat-message chat-message--assistant chat-table-message';
          const signature = tableMessageSignature(tableMessage, getLinkContext());
          if (renderedTableSignatures.get(shell) !== signature) {
            renderedTableSignatures.set(shell, signature);
            shell.replaceChildren(...renderTableMessage(tableMessage));
          }
          return;
        }
        const view = store.toolCallFor(item.toolCallId);
        if (
          view !== undefined &&
          toolRendererRegistry.presentationOf(view.toolName) === 'conversation'
        ) {
          renderConversationShell(shell, view);
          return;
        }
        const expanded = expandedToolCalls.has(item.toolCallId);
        shell.className =
          view === undefined
            ? 'chat-tool-call'
            : `chat-tool-call chat-tool-call--${view.status.kind}`;
        if (expanded) shell.classList.add('chat-tool-call--expanded');
        // Rebuild the billet only when its non-progress content changed; a
        // progress tick updates the existing line in place so the spinner keeps
        // spinning (see `renderedToolCallBodies`).
        if (view === undefined) {
          shell.replaceChildren(...renderToolCallBody(view, item.toolCallId, expanded));
          return;
        }
        const bodyState = toolCallBodyState(view, expanded);
        if (!sameToolCallBody(renderedToolCallBodies.get(shell), bodyState)) {
          renderedToolCallBodies.set(shell, bodyState);
          shell.replaceChildren(...renderToolCallBody(view, item.toolCallId, expanded));
        }
        applyToolCallProgress(shell, view);
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
      const { skip, messages, runIds } = planTableRuns(store, items);
      const lastItem = items[items.length - 1];
      const seenKeys = new Set<string>();
      const nodes: HTMLElement[] = [];
      // Messages the application updated in place this repaint - see the
      // `repaint` doc on `TranscriptView` and `renderedRunSignatures`.
      const updatedMessages: HTMLElement[] = [];
      const nextRunSignatures = new Map<string, string>();
      let sawThinking = false;

      for (const item of items) {
        const key = keyFor(item);
        if (item.kind === 'thinking') sawThinking = true;
        // An intermediate `format_table` call (everything but a run's last)
        // renders nothing; leaving it out of `seenKeys` also evicts any node it
        // owned when it stopped being the run's last call.
        if (skip.has(key)) continue;
        // A running billet is hidden while the turn waits on a question, so at
        // most one "unfinished process" indicator is ever on screen.
        if (hiddenWhileAwaitingInput(store, item)) continue;
        seenKeys.add(key);
        let shell = cache.get(key);
        if (shell === undefined) {
          shell = createShell(item);
          cache.set(key, shell);
        }
        const tableMessage = messages.get(key);
        updateShell(store, item, shell, item === lastItem, tableMessage);
        if (tableMessage !== undefined) {
          const runId = runIds.get(key);
          if (runId !== undefined) {
            const signature = tableRunContentSignature(tableMessage);
            const previous = renderedRunSignatures.get(runId);
            if (previous !== undefined && previous !== signature) updatedMessages.push(shell);
            nextRunSignatures.set(runId, signature);
          }
        }
        nodes.push(shell);
      }
      renderedRunSignatures = nextRunSignatures;

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

      return updatedMessages;
    },
    dispose() {
      popover?.dispose();
    },
  };
}
