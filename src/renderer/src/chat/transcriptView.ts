import type { JsonValue, ToolTableMessage } from '../../../shared';
import { el } from '../lib/dom';
import {
  EMPTY_AEM_LINKIFY_STATE,
  EMPTY_LINK_CONTEXT,
  MESSAGE_ACTIONS_ATTRIBUTE,
  MESSAGE_EXTERNAL_ATTRIBUTE,
  MESSAGE_LINK_ATTRIBUTE,
  parseLinkActions,
  splitAemPathLinks,
  type AemLinkifyState,
  type LinkContext,
  type MessageSegment,
} from './linkTargets';
import { renderLinkSegment } from './linkSegmentDom';
import {
  createHoverActionPopover,
  type HoverAction,
  type HoverActionAlignment,
  type HoverActionPopover,
} from './hoverActionPopover';
import { tableGutterFrom, tableHoverActions } from './tableHover';
import { type TableExportData } from './tableExport';
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
  /**
   * Invoked with a `format_table` run's table when the reader activates the
   * gutter's **Copy** action. The host turns it into clipboard content (see
   * `tableExport.ts`). Absent (a unit test) means the Copy button is inert.
   */
  readonly onCopyTable?: (data: TableExportData) => void;
  /**
   * Invoked with a `format_table` run's table when the reader activates the
   * gutter's **Export** action. The host turns it into a CSV file and asks the
   * user where to save it. Absent (a unit test) means the Export button is
   * inert.
   */
  readonly onExportTable?: (data: TableExportData) => void;
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
 * What a table message's shell currently renders, so a repaint can tell an
 * unchanged table (touching nothing), a run that merely grew a page (appending
 * rows to the SAME `<sp-table>`), and a genuine re-render (a new run, changed
 * columns, or a link-context switch) apart. Held per shell in
 * `createTranscriptView`'s `renderedTables`.
 *
 * The row-reference members are what let an append avoid recreating the table:
 * a fresh `sp-table` has no height until its Lit shadow DOM renders (a
 * microtask later), so replacing it momentarily collapses the transcript and
 * the stick-to-bottom follower pins to the wrong place - the reported
 * "stutter".
 */
interface RenderedTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly total: string | undefined;
  /** Whether the total line currently wears its "counting" spinner. */
  readonly totalPending: boolean;
  /** `linkContextSignature` of the context the current hrefs resolved against. */
  readonly context: string;
  /** The rendered `<sp-table>`, when the run has at least one row. */
  readonly table: HTMLElement | undefined;
  /** Its `<sp-table-body>`, the element a growth appends rows to. */
  readonly body: HTMLElement | undefined;
  /** The total line, when one is shown, so a growth can rewrite its text. */
  readonly totalEl: HTMLElement | undefined;
  /**
   * The linkifier state the rows ended on (the last full AEM path), so a growth
   * (a `Load more` page) continues the same carry-over the previous rows left -
   * see `renderTableRow` and `splitAemPathLinks`.
   */
  readonly linkState: AemLinkifyState;
}

/**
 * The link context a rendered table's `Path` cells were resolved against, as
 * one comparable string. A change (the active host switching) makes every href
 * stale, so the table must be fully re-rendered rather than grown in place -
 * see `applyTableMessage`.
 */
function linkContextSignature(context: LinkContext): string {
  return [context.activeOrigin ?? '', context.hostOrigins.join(',')].join('\u0000');
}

/** Positional string-array equality, used to compare table columns and rows. */
function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * The *rows* of a rendered run - its columns and rows, with neither the total
 * line nor the spinner. This is the signature `repaint` compares to decide a
 * run was grown by a `Load more` page, and so must be **revealed** to a reader.
 * A late count only changes the total line/`totalPending`; that must not yank a
 * reader who has scrolled up (a UX decision recorded in docs/accurate-search-total.md
 * section 3.4).
 */
function tableRunRowsSignature(message: ToolTableMessage): string {
  return [
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

/**
 * Whether `item` is an assistant message with nothing to show. Such a message
 * paints nothing rather than an empty bubble: a `.chat-message--assistant` is a
 * gray box, and with no text it is an empty one. A turn whose whole answer is a
 * tool call (a search turn, whose answer is the `format_table` message; the model
 * itself ends with `content: ""`) is the case that produces one.
 *
 * The item is deliberately NOT dropped from the store (or the journal): it stays
 * in `items()` for debugging and for the record, and only the painting is
 * skipped. That is also why a message which has *started* but has not produced
 * its first delta yet is skipped here - it appears the moment it has text.
 *
 * Text that is only whitespace renders to nothing too (`marked` emits no element
 * for it), so it counts as empty.
 */
function isEmptyMessage(store: TranscriptStore, item: TranscriptItem): boolean {
  return item.kind === 'message' && store.textForMessage(item.messageId).trim() === '';
}

/**
 * Whether `item` is a `presentation: 'conversation'` tool call (`ask_user`) with
 * nothing to paint. Three shapes paint nothing: an `actions`-mode prompt (its
 * buttons are self-explanatory and live in the composer), a question still
 * awaiting its answer (a pending question lives in the composer, not the
 * transcript - see `renderConversationShell`), and a call this build does not
 * recognise.
 *
 * Like an empty assistant message (see `isEmptyMessage`), such a call must
 * leave no empty `.chat-ask-user` shell in the transcript - so a search's
 * `Load more` prompt (an `actions` call with no question) no longer sits as a
 * blank div between two billets. The call stays in the store and the journal;
 * only the painting is skipped.
 */
function isEmptyConversation(store: TranscriptStore, item: TranscriptItem): boolean {
  if (item.kind !== 'toolCall') return false;
  const view = store.toolCallFor(item.toolCallId);
  if (view === undefined) return false;
  if (toolRendererRegistry.presentationOf(view.toolName) !== 'conversation') return false;
  const conversation = toolRendererRegistry.readConversation(
    view.toolName,
    view.args,
    succeededData(view),
  );
  if (conversation === undefined) return true;
  if (conversation.answer !== undefined) return false;
  // No answer yet: only a failed/rejected call still paints the question (with
  // the reason); a pending question has nothing to show.
  return view.status.kind !== 'failed' && view.status.kind !== 'rejected';
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
  // A status may deliberately carry no word (a replayed call the turn was
  // waiting on the user for - see `describeToolCallStatus`): then the header is
  // the tool name alone, with no ` - status` suffix.
  const statusLabel = describeToolCallStatus(view.status);
  toggle.append(
    running
      ? el('sp-progress-circle', {
          attrs: { class: 'chat-tool-call__icon', size: 's', indeterminate: '', label: 'Working' },
        })
      : el('sp-icon-actions', { attrs: { class: 'chat-tool-call__icon', size: 's' } }),
    el('span', {
      attrs: { class: 'chat-tool-call__header' },
      text: statusLabel === undefined ? view.toolName : `${view.toolName} \u2014 ${statusLabel}`,
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
 * Makes `parent`'s children exactly `nodes`, in order, moving or inserting only
 * the nodes that are out of place rather than replaying the whole list.
 *
 * This is the same concern `hasSameChildren` guards, taken a step further: a
 * repaint that *reorders* entries - a search table moving down to the run's new
 * last call when a `Load more` page arrives, displacing the billets and the
 * `ask_user` exchange before it - used to call `replaceChildren`, detaching and
 * re-attaching every node. Re-inserting a mounted node restarts any CSS
 * animation it contains and forces a full relayout, which is the "neighboring
 * containers jump" half of the reported stutter. Moving only the misplaced
 * nodes leaves settled entries - and the table itself - attached and untouched.
 */
function reconcileChildren(parent: HTMLElement, nodes: readonly HTMLElement[]): void {
  if (hasSameChildren(parent, nodes)) return;
  let index = 0;
  for (const node of nodes) {
    const current = parent.children[index] ?? null;
    if (current !== node) parent.insertBefore(node, current);
    index += 1;
  }
  while (parent.children.length > nodes.length) {
    parent.lastElementChild?.remove();
  }
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

  // The rendered table state of the message shell each run currently owns.
  // `updateShell` runs for every item on every repaint (a streaming delta
  // repaints the whole transcript), and rebuilding an unchanged `sp-table` is
  // not free: a freshly-created custom element has no height until its Lit
  // shadow DOM renders, so the transcript momentarily collapses and the
  // stick-to-bottom follower can pin to the wrong place - the reported "the
  // whole table was re-rendered and the transcript jumped up to its top". A
  // table is touched only when its columns, rows, total or link context
  // actually change, and a page appended to a run grows the same `<sp-table>`
  // in place - see `applyTableMessage`.
  const renderedTables = new WeakMap<HTMLElement, RenderedTable>();

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

  // The one travelling hover popover for transcript affordances that offer icon
  // actions: a pane link (Edit/CRX) or a `format_table` run's gutter
  // (Copy/Export). It is undefined in a jsdom unit test (the Spectrum overlay is
  // not registered there) and in any environment where it is;
  // `show`/`scheduleHide`/`hideNow` below are then simply inert.
  const popover: HoverActionPopover | undefined = createHoverActionPopover({
    getContainer: () => element.closest('sp-theme') ?? document.body,
  });
  // The element the popover is currently shown for, so repeated `pointerover`
  // events over one of them do not rebuild its buttons.
  let hoveredAnchor: HTMLElement | undefined;

  /** The icon a pane link's popover action wears - Edit or CRX. */
  function linkActionIcon(id: 'edit' | 'crx'): keyof HTMLElementTagNameMap {
    return id === 'edit' ? 'sp-icon-edit' : 'sp-icon-journey-voyager';
  }

  /**
   * The element under the pointer that carries a hover popover: a pane link, or
   * a page-relative table cell (a non-anchored span stamped with
   * `data-daisy-actions` but no `data-daisy-link`, so a click never navigates).
   */
  function paneLinkFrom(target: EventTarget | null): HTMLElement | null {
    return (
      (target as Element | null)?.closest?.(
        `a[${MESSAGE_LINK_ATTRIBUTE}], [${MESSAGE_ACTIONS_ATTRIBUTE}]`,
      ) ?? null
    );
  }

  /**
   * Every pointer-reactive affordance: a pane link/partial, or a
   * `format_table` gutter - the header row or the total line, never an ordinary
   * data row (`tableHover.ts`). The two can never be the same element. The
   * alignment differs: a link keeps the popover centred above it, while the
   * gutter (whose anchor spans the table) right-aligns it to the table's edge.
   */
  function hoverTargetFrom(
    target: EventTarget | null,
  ): { anchor: HTMLElement; align: HoverActionAlignment } | undefined {
    const link = paneLinkFrom(target);
    if (link !== null) return { anchor: link, align: 'center' };
    const gutter = tableGutterFrom(target);
    return gutter === undefined ? undefined : { anchor: gutter.anchor, align: 'end' };
  }

  /**
   * The actions the popover should show for `anchor`: a link's own Edit/CRX, or
   * a table gutter's Copy/Export. A link's actions are read from the element,
   * never re-derived from its href: a `jcr:content` link's href is trimmed to
   * the owning page, so re-classifying it would retarget CRX at that page (see
   * `MESSAGE_ACTIONS_ATTRIBUTE`). Empty when there is nothing to offer, so the
   * caller shows nothing.
   */
  function hoverActionsFor(anchor: HTMLElement): readonly HoverAction[] {
    const linkActions = parseLinkActions(anchor.getAttribute(MESSAGE_ACTIONS_ATTRIBUTE));
    if (linkActions.length > 0) {
      return linkActions.map((action) => ({
        id: action.id,
        title: action.title,
        icon: linkActionIcon(action.id),
        onActivate: () => options.onOpenLink?.(action.href),
      }));
    }
    const shell = anchor.closest<HTMLElement>('.chat-table-message');
    const table = shell === null ? undefined : renderedTables.get(shell);
    if (table === undefined) return [];
    return tableHoverActions(
      { columns: table.columns, rows: table.rows, total: table.total },
      {
        onCopy: (data) => options.onCopyTable?.(data),
        onExport: (data) => options.onExportTable?.(data),
      },
    );
  }

  element.addEventListener('pointerover', (event) => {
    if (popover === undefined) return;
    const target = hoverTargetFrom(event.target);
    if (target === undefined || target.anchor === hoveredAnchor) return;
    const actions = hoverActionsFor(target.anchor);
    if (actions.length === 0) return;
    hoveredAnchor = target.anchor;
    popover.show(target.anchor, actions, target.align);
  });

  element.addEventListener('pointerout', (event) => {
    if (popover === undefined || hoveredAnchor === undefined) return;
    if (hoverTargetFrom(event.target)?.anchor !== hoveredAnchor) return;
    const related = event.relatedTarget as Node | null;
    // Moving to a child of the same anchor (or into the popover) must not hide it.
    if (related !== null && hoveredAnchor.contains(related)) return;
    hoveredAnchor = undefined;
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
    hoveredAnchor = undefined;
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
   * Fills a table cell from the linkifier's segments for its value. A cell with
   * no link is plain text (`textContent`), wrapped in its column's presentation
   * class - clamped for `Value`/`Citation`, wrapped-at-any-character for
   * `Property`/`Node`/`Component`. A cell that is (or contains) a path renders
   * its segments through the shared `renderLinkSegment`, so the anchor or the
   * partial span is the cell's own content: the **value** decides whether it
   * links, never the column header - exactly as in prose.
   */
  function appendCellContent(
    cell: HTMLElement,
    value: string,
    header: string,
    segments: readonly MessageSegment[],
  ): void {
    if (!segments.some((segment) => segment.kind === 'link')) {
      const span = el('span', { text: value });
      if (header === 'Value' || header === 'Citation') {
        span.className = 'chat-table-message__clamp';
      } else if (header === 'Property' || header === 'Node' || header === 'Component') {
        span.className = 'chat-table-message__wrap';
      }
      cell.append(span);
      return;
    }
    for (const segment of segments) cell.append(renderLinkSegment(cell.ownerDocument, segment));
  }

  /**
   * One row of a run's table: the leading `#` index cell and one cell per
   * column. Cells are visited left to right and the linkifier's state (the last
   * full path) is threaded from one to the next, so a page-relative
   * `jcr:content/...` cell resolves against the page that precedes it -
   * including when a repeated page path was blanked out of the cell above (see
   * `createComponentNodeDisplay` in `aemQueryFormatAsk.ts`). The state is
   * returned so the caller can thread it to the next row, or hold it for a later
   * `Load more` append.
   *
   * Extracted so a `Load more` growth can append a row to the existing table
   * without recreating it (see `applyTableMessage`).
   */
  function renderTableRow(
    row: readonly string[],
    columns: readonly string[],
    rowIndex: number,
    state: AemLinkifyState,
    context: LinkContext,
  ): { readonly element: HTMLElement; readonly linkState: AemLinkifyState } {
    const rowEl = el('sp-table-row', {});
    rowEl.append(
      el('sp-table-cell', {
        attrs: { class: 'chat-table-message__index' },
        text: String(rowIndex + 1),
      }),
    );
    let currentState = state;
    columns.forEach((column, columnIndex) => {
      const value = row[columnIndex] ?? '';
      const cell = el('sp-table-cell', {});
      const linked = splitAemPathLinks(value, context, currentState);
      currentState = linked.state;
      appendCellContent(cell, value, column, linked.segments);
      rowEl.append(cell);
    });
    return { element: rowEl, linkState: currentState };
  }

  /** The `sp-progress-circle` a counting total line wears in front of its text. */
  function createTotalSpinner(): HTMLElement {
    return el('sp-progress-circle', {
      attrs: {
        class: 'chat-table-message__total-spinner',
        size: 's',
        indeterminate: '',
        label: 'Counting all results',
      },
    });
  }

  /** The total line as first rendered: an optional spinner, then the optional text. */
  function createTotalLine(
    total: string | undefined,
    totalPending: boolean,
  ): HTMLElement | undefined {
    if (total === undefined && !totalPending) return undefined;
    const node = el('p', { attrs: { class: 'chat-table-message__total' } });
    if (totalPending) node.append(createTotalSpinner());
    if (total !== undefined) {
      node.append(el('span', { attrs: { class: 'chat-table-message__total-text' }, text: total }));
    }
    return node;
  }

  /**
   * Renders one run's table as the assistant **message**: a Spectrum `<sp-table>`
   * with a leading `#` row-number column and, beneath it, an optional total line
   * (with a spinner while an exact total is still being counted). The columns
   * come from the accumulated `format_table` calls; a zero-row run renders only
   * its total line (no empty table). Returns the linkifier state the rows ended
   * on, so an append continues the same carry-over.
   */
  function renderTableMessage(
    message: ToolTableMessage,
    context: LinkContext,
  ): { readonly nodes: readonly HTMLElement[]; readonly linkState: AemLinkifyState } {
    const nodes: HTMLElement[] = [];
    const { columns, rows } = message.table;
    let linkState = EMPTY_AEM_LINKIFY_STATE;
    if (rows.length > 0) {
      const head = el('sp-table-head', {});
      head.append(el('sp-table-head-cell', { attrs: {}, text: '#' }));
      for (const column of columns) {
        head.append(el('sp-table-head-cell', { attrs: {}, text: column }));
      }

      const body = el('sp-table-body', {});
      for (let index = 0; index < rows.length; index += 1) {
        const rendered = renderTableRow(rows[index] ?? [], columns, index, linkState, context);
        body.append(rendered.element);
        linkState = rendered.linkState;
      }

      const tableEl = el('sp-table', {
        attrs: { class: 'chat-table-message__table', size: 's' },
      });
      tableEl.append(head, body);
      nodes.push(tableEl);
    }
    const totalLine = createTotalLine(message.total, message.totalPending);
    if (totalLine !== undefined) nodes.push(totalLine);
    return { nodes, linkState };
  }

  /**
   * Writes a table message's total line into `shell`, reusing `existing` when
   * there is one and creating or removing the node as the message gains or
   * loses a total. The spinner is added or removed **in place** - the `<p>` and
   * its text node are never recreated, so the spinner's animation does not
   * restart on a repaint (the same rule as a running billet's progress line).
   * Returns the node now in place, for the next call to reuse.
   */
  function applyTableTotal(
    shell: HTMLElement,
    existing: HTMLElement | undefined,
    total: string | undefined,
    totalPending: boolean,
  ): HTMLElement | undefined {
    if (total === undefined && !totalPending) {
      existing?.remove();
      return undefined;
    }
    let node = existing;
    if (node === undefined) {
      node = el('p', { attrs: { class: 'chat-table-message__total' } });
      shell.append(node);
    }
    const spinner = node.querySelector<HTMLElement>('.chat-table-message__total-spinner');
    if (totalPending && spinner === null) {
      node.prepend(createTotalSpinner());
    } else if (!totalPending && spinner !== null) {
      spinner.remove();
    }
    const text = node.querySelector<HTMLElement>('.chat-table-message__total-text');
    if (total === undefined) {
      text?.remove();
    } else if (text === null) {
      node.append(el('span', { attrs: { class: 'chat-table-message__total-text' }, text: total }));
    } else if (text.textContent !== total) {
      text.textContent = total;
    }
    return node;
  }

  /**
   * Reconciles a shell's rendered table with the message `planTableRuns` now
   * computes for its run, in one of three ways:
   *
   * - **unchanged** (same columns, rows, total and link context) - touch
   *   nothing, so a repaint triggered for an unrelated reason never rebuilds it;
   * - **grown** (same columns and context, the previous rows a prefix of the new
   *   ones - a `Load more` page) - append only the new rows to the SAME
   *   `<sp-table>` and rewrite the total line, so the table never collapses;
   * - **otherwise** - a full re-render (a new run, changed columns, or a
   *   link-context switch that makes every href stale).
   */
  function applyTableMessage(shell: HTMLElement, message: ToolTableMessage): void {
    const linkContext = getLinkContext();
    const context = linkContextSignature(linkContext);
    const { columns, rows } = message.table;
    const previous = renderedTables.get(shell);
    if (
      previous !== undefined &&
      previous.context === context &&
      previous.total === message.total &&
      previous.totalPending === message.totalPending &&
      sameStrings(previous.columns, columns) &&
      previous.rows.length === rows.length &&
      previous.rows.every((row, index) => sameStrings(row, rows[index] ?? []))
    ) {
      return;
    }
    if (
      previous !== undefined &&
      previous.context === context &&
      previous.table !== undefined &&
      previous.body !== undefined &&
      sameStrings(previous.columns, columns) &&
      rows.length >= previous.rows.length &&
      previous.rows.every((row, index) => sameStrings(row, rows[index] ?? []))
    ) {
      // Continue the linkifier's carry-over from the state the already rendered
      // rows left, so a `Load more` page's first relative path still hangs off
      // the page above it.
      let linkState = previous.linkState;
      for (let index = previous.rows.length; index < rows.length; index += 1) {
        const rendered = renderTableRow(rows[index] ?? [], columns, index, linkState, linkContext);
        previous.body.append(rendered.element);
        linkState = rendered.linkState;
      }
      const totalEl = applyTableTotal(shell, previous.totalEl, message.total, message.totalPending);
      renderedTables.set(shell, {
        ...previous,
        rows,
        linkState,
        total: message.total,
        totalPending: message.totalPending,
        totalEl,
      });
      return;
    }
    const rendered = renderTableMessage(message, linkContext);
    shell.replaceChildren(...rendered.nodes);
    renderedTables.set(shell, {
      columns,
      rows,
      linkState: rendered.linkState,
      total: message.total,
      totalPending: message.totalPending,
      context,
      table: shell.querySelector<HTMLElement>('sp-table') ?? undefined,
      body: shell.querySelector<HTMLElement>('sp-table-body') ?? undefined,
      totalEl: shell.querySelector<HTMLElement>('.chat-table-message__total') ?? undefined,
    });
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
      totalPending: boolean;
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
          totalPending: run.totalPending,
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
        current = { keys: [key], columns: [], pages: [], total: undefined, totalPending: false };
      } else {
        current.keys.push(key);
      }
      for (const column of message.table.columns) {
        if (!current.columns.includes(column)) current.columns.push(column);
      }
      current.pages.push({ columns: message.table.columns, rows: message.table.rows });
      current.total = message.total ?? current.total;
      // The run's **last** call decides the flag, exactly as it decides the
      // total - so a page appended mid-count keeps the spinner and the settle
      // call clears it.
      current.totalPending = message.totalPending;
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
          // assistant message - the accumulated table - not a billet. Touched
          // only when its content changed, and a `Load more` page grows the
          // existing table in place (see `applyTableMessage`).
          shell.className = 'chat-message chat-message--assistant chat-table-message';
          applyTableMessage(shell, tableMessage);
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
      hoveredAnchor = undefined;
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
        // An assistant message with no text paints nothing - see `isEmptyMessage`.
        if (isEmptyMessage(store, item)) continue;
        // A `conversation` tool call that paints nothing (an `actions` prompt,
        // a pending question) leaves no empty shell - see `isEmptyConversation`.
        if (isEmptyConversation(store, item)) continue;
        const tableMessage = messages.get(key);
        // A table run's shell is cached under the run's **stable start** key
        // (`runIds`), not the call that happens to render it now: a `Load more`
        // page makes a later call the run's renderer, and re-keying the shell
        // would create a fresh one - and a fresh `<sp-table>` - on every append.
        const renderKey = tableMessage !== undefined ? (runIds.get(key) ?? key) : key;
        seenKeys.add(renderKey);
        let shell = cache.get(renderKey);
        if (shell === undefined) {
          shell = createShell(item);
          cache.set(renderKey, shell);
        }
        updateShell(store, item, shell, item === lastItem, tableMessage);
        if (tableMessage !== undefined) {
          const runId = runIds.get(key);
          if (runId !== undefined) {
            // Reveal only when the run gained *rows* (a Load more page): a
            // count's late total-line update must not move a reader who
            // scrolled up.
            const signature = tableRunRowsSignature(tableMessage);
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

      // Only touch the DOM when the ordered node list actually changed, and then
      // only the nodes that moved. See `reconcileChildren`: re-inserting
      // unchanged nodes restarts their CSS animations and relayouts everything,
      // which made the thinking spinner stutter on every delta and made a search
      // table's `Load more` jump its neighbors.
      reconcileChildren(element, nodes);

      return updatedMessages;
    },
    dispose() {
      popover?.dispose();
    },
  };
}
