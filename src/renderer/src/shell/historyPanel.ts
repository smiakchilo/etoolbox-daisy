import { el } from '../lib/dom';
import { type StatusBannerSink, confirmDestructiveAction } from '../settings/statusBanner';
import {
  formatHistoryTimestamp,
  historyEntryTitle,
  resolveHistoryServer,
} from '../chat/historyViewModel';
import { createPanel, type Panel } from './panel';
import type { HostOption } from './viewModel';
import type { AgentChatHistoryEntry } from '../../../shared';

/**
 * The browsable chat history, as a whole-size panel over the browser pane's
 * page-view region (`panel.ts`) - the same surface the Settings panel uses,
 * superseding `requirements-decisions.md` section 8's original "separate local
 * child window" for History on the same grounds Settings was moved (a native
 * `WebContentsView` composites above the renderer document, so a whole-size
 * panel that suspends it is both simpler and consistent).
 *
 * The list is derived on demand from the stored journals (`agentChat.
 * listConversations`), **one small page at a time**: the first page paints
 * immediately, so a history folder with many conversations - or one on a slow
 * disk, where every journal read is expensive - never leaves a blank panel for
 * the whole scan. The pages after it are appended together (see
 * {@link HISTORY_COALESCE_MS}) so the scrollbar does not shrink once per page.
 * A list already showing (a reopen, a delete's settle) is kept until its
 * replacement is ready and swapped in whole, never blanked and refilled.
 * A reload (open, or the settle of a delete) starts a fresh scan and
 * supersedes any still-running one.
 *
 * The rows carry no buttons of their own: **one set of actions travels**.
 * It is hidden only when its row is neither hovered nor focused, and it is
 * re-anchored into whichever row the reader points at or tabs to
 * (`mouseenter`/`focusin`), so hovering a row reveals
 * `Resume conversation` / `Reveal in folder` / `Delete conversation` for
 * exactly that row - and no other row reserves the space twice. (Anchoring on
 * focus keeps the buttons keyboard-reachable too: the row is a tab stop, and
 * the traveller follows it.)
 *
 * Delete asks for confirmation in the pane's message alert banner (the shared
 * one-button prompt the Settings panel uses) before calling back; the shell
 * owns the chat pane and the browser pane, so the panel only reports what the
 * reader chose.
 */
export interface HistoryPanel extends Panel {
  /** Rebuilds the list from the stored conversations; resolves when painted. */
  reload(): Promise<void>;
  /**
   * Updates the configured hosts used to label each row's server. The ids are
   * stable across renames, so a chat keeps resolving to the same host.
   */
  setServers(servers: readonly HostOption[]): void;
}

export interface HistoryPanelOptions {
  /**
   * The pane-owned status slot (the browser pane's `surfaceStatus`) - the same
   * sink the Settings panel is handed. A destructive confirmation, the delete
   * outcome the shell reports, and a failed reveal all live in the pane's
   * message alert banner, never in the row: one shared confirmation method for
   * every surface that destroys something, and feedback that outlives the
   * panel.
   */
  readonly status: StatusBannerSink;
  /** Opens `entry`'s conversation. The shell repaints it and switches the browser host. */
  readonly onResume: (entry: AgentChatHistoryEntry) => void;
  /**
   * Deletes `entry`'s stored conversation. The panel awaits this, then reloads
   * its list, so a failed deletion (the shell reports it) leaves the row.
   */
  readonly onDelete: (entry: AgentChatHistoryEntry) => Promise<void>;
  /** Fired when the close (cross) button or Escape dismisses the panel. */
  readonly onDismiss: () => void;
  /** Injectable clock (milliseconds), so tests can age the list deterministically. */
  readonly now?: () => number;
}

/**
 * How long the list must have stood still before pages that arrived after the
 * first are appended; until then they are held and appended together, so the
 * scrollbar changes once rather than once per page.
 */
export const HISTORY_COALESCE_MS = 500;

export function createHistoryPanel(options: HistoryPanelOptions): HistoryPanel {
  const status = options.status;
  const now = options.now ?? ((): number => performance.now());
  let servers: readonly HostOption[] = [];
  /** True while a confirmed deletion is in flight, so a second press is inert. */
  let deleting = false;
  /**
   * The reload generation. Each reload bumps it; a page that arrives after a
   * newer one started is dropped, so two overlapping reloads can never
   * interleave their appends.
   */
  let loadEpoch = 0;
  /** The row the travelling actions currently sit in, so placement is idempotent. */
  let anchoredRow: HTMLElement | undefined;
  /** The conversation the travelling actions act on - the anchored row's. */
  let anchoredEntry: AgentChatHistoryEntry | undefined;

  const list = el('div', {
    attrs: {
      class: 'history-panel__list',
      role: 'list',
      'aria-label': 'Stored conversations',
    },
  });

  const panel = createPanel({
    title: 'History',
    closeAriaLabel: 'Close history',
    surfaceClassName: 'history-panel',
    testId: 'history-panel',
    closeButtonClassName: 'history-panel__close',
    autofocusSelector: '.history-item__resume',
    content: list,
    onDismiss(): void {
      options.onDismiss();
    },
  });

  /**
   * The single travelling actions area. `buildItem` adds no buttons of its
   * own; `anchorActions` re-parents this one element into whichever row the
   * reader reaches. Whether it is *visible* is CSS - hidden by default,
   * visible on the anchored row's `:hover`/`:focus-within` - so one left the
   * list read consistently, and the DOM only carries the move.
   */
  const travelling = el('div', {
    attrs: {
      class: 'history-item__actions',
      'data-testid': 'history-actions',
    },
  });

  /**
   * The row's host chip - a swatch plus the host's label - or `undefined` when
   * the chat names no host (it opened before any host was selected) or names
   * one that is no longer configured. The chip is omitted entirely rather than
   * shown as a placeholder: a missing host is not worth a row of its own.
   */
  function buildServerMeta(entry: AgentChatHistoryEntry): HTMLElement | undefined {
    const server = resolveHistoryServer(entry, servers);
    if (server === undefined) return undefined;
    const swatch = el('span', {
      attrs: { class: 'server-swatch history-item__swatch', role: 'presentation' },
    });
    swatch.style.backgroundColor = server.colorCss;
    return el('span', {
      attrs: { class: 'history-item__server' },
      children: [
        swatch,
        el('span', { attrs: { class: 'history-item__server-label' }, text: server.label }),
      ],
    });
  }

  function buildResumeButton(): HTMLElement {
    const resume = el('sp-action-button', {
      attrs: {
        quiet: '',
        class: 'history-item__resume',
        title: 'Resume conversation',
        'aria-label': 'Resume conversation',
        'data-testid': 'history-resume',
      },
    });
    const resumeIcon = document.createElement('sp-icon-replay');
    resumeIcon.setAttribute('slot', 'icon');
    resume.append(resumeIcon);
    resume.addEventListener('click', () => {
      if (anchoredEntry !== undefined) options.onResume(anchoredEntry);
    });
    return resume;
  }

  /**
   * Reveals the conversation's journal file in the OS file manager - the same
   * call the chat pane's footer uses; the path is main's, derived from the id,
   * and a failure is reported in the pane's banner.
   */
  function buildRevealButton(): HTMLElement {
    const reveal = el('sp-action-button', {
      attrs: {
        quiet: '',
        class: 'history-item__reveal',
        title: 'Reveal in folder',
        'aria-label': 'Reveal in folder',
        'data-testid': 'history-reveal',
      },
    });
    const revealIcon = document.createElement('sp-icon-file-txt');
    revealIcon.setAttribute('slot', 'icon');
    reveal.append(revealIcon);
    reveal.addEventListener('click', () => {
      const entry = anchoredEntry;
      if (entry === undefined) return;
      void window.daisy.agentChat.revealJournal({ chatId: entry.chatId }).then((result) => {
        if (!result.ok) status.showError(result.error.message);
      });
    });
    return reveal;
  }

  function buildDeleteButton(): HTMLElement {
    const remove = el('sp-action-button', {
      attrs: {
        quiet: '',
        class: 'history-item__delete',
        title: 'Delete conversation',
        'aria-label': 'Delete conversation',
        'data-testid': 'history-delete',
      },
    });
    const removeIcon = document.createElement('sp-icon-delete-outline');
    removeIcon.setAttribute('slot', 'icon');
    remove.append(removeIcon);
    remove.addEventListener('click', () => {
      if (anchoredEntry !== undefined) requestDelete(anchoredEntry);
    });
    return remove;
  }

  // The three buttons are built once and merely re-parented: their handlers
  // read whatever row the traveller currently sits in, so a move never has to
  // rebuild them - and a button that held focus keeps it.
  travelling.replaceChildren(buildResumeButton(), buildRevealButton(), buildDeleteButton());

  /**
   * Moves the travelling actions into `row`, pointing them at `entry`. Called
   * on the row's `mouseenter`/`focusin` (and once after the first batch
   * paints, so the panel's autofocus finds a live button). A move detaches and
   * re-inserts the container, which drops focus to the body; if one of the
   * buttons held it, hand it back.
   */
  function anchorActions(row: HTMLElement, entry: AgentChatHistoryEntry): void {
    if (row === anchoredRow) return;
    const focused = document.activeElement;
    const keepFocus = focused !== null && travelling.contains(focused);
    row.append(travelling);
    anchoredRow = row;
    anchoredEntry = entry;
    if (keepFocus && focused !== document.activeElement) {
      (focused as HTMLElement).focus();
    }
  }

  /**
   * Moves focus onto the anchored row's Resume - the affordance the panel's
   * `autofocusSelector` names, which `panel.open()` cannot reach while the list
   * is still empty. The row is focused first: the actions are `visibility:
   * hidden` until their row is hovered or focused, and a hidden control cannot
   * take focus, so reaching the row is what reveals the button that then takes
   * the caret.
   */
  function focusAnchoredRowActions(): void {
    const row = anchoredRow;
    const resume = travelling.querySelector<HTMLElement>('.history-item__resume');
    if (row === undefined || resume === null) return;
    row.focus();
    resume.focus();
  }

  function buildItem(entry: AgentChatHistoryEntry): HTMLElement {
    const serverMeta = buildServerMeta(entry);
    const main = el('div', {
      attrs: { class: 'history-item__main' },
      children: [
        el('span', {
          attrs: { class: 'history-item__title' },
          text: historyEntryTitle(entry),
        }),
        el('span', {
          attrs: { class: 'history-item__meta' },
          children: [
            el('span', {
              attrs: { class: 'history-item__date' },
              text: formatHistoryTimestamp(entry.startedAt),
            }),
            // Omitted, not placeholder-filled, when the chat names no host.
            ...(serverMeta !== undefined ? [serverMeta] : []),
          ],
        }),
      ],
    });
    const row = el('div', {
      attrs: {
        class: 'history-item',
        role: 'listitem',
        tabindex: '0',
        'data-testid': 'history-item',
        'data-chat-id': entry.chatId,
      },
      children: [main],
    });
    row.addEventListener('mouseenter', () => {
      anchorActions(row, entry);
    });
    row.addEventListener('focusin', () => {
      anchorActions(row, entry);
    });
    return row;
  }

  function showMessage(text: string, className: string): void {
    list.replaceChildren(el('p', { attrs: { class: className }, text }));
  }

  function appendItems(entries: readonly AgentChatHistoryEntry[]): void {
    if (entries.length === 0) return;
    const fragment = document.createDocumentFragment();
    for (const entry of entries) fragment.append(buildItem(entry));
    list.append(fragment);
    // A fresh list (reload) or a full repaint has no anchored row yet: anchor
    // the traveller on the first row so the panel's autofocus and the next
    // hover both find a live button.
    if (anchoredRow === undefined || !travelling.isConnected) {
      const firstRow = list.querySelector<HTMLElement>('.history-item');
      const [firstEntry] = entries;
      if (firstRow !== null && firstEntry !== undefined) {
        anchorActions(firstRow, firstEntry);
      }
    }
  }

  async function reload(): Promise<void> {
    const epoch = ++loadEpoch;
    const startedAt = now();
    const firstPage = await window.daisy.agentChat.listConversations({});
    if (epoch !== loadEpoch) return;
    if (!firstPage.ok) {
      showMessage(`History is unavailable: ${firstPage.error.message}`, 'history-panel__empty');
      return;
    }

    // Every change to the list's height moves the scrollbar thumb, so the list
    // is changed as few times as possible. A list already on screen (a reopen,
    // or the settle of a delete) is kept - not blanked and refilled - until its
    // replacement is ready, and is then swapped in whole; only an empty list
    // paints its first page at once, so a cold open is never blank. Pages after
    // the first are held and appended together, once the scan ends or the list
    // has stood still for `HISTORY_COALESCE_MS` (a slow disk still shows
    // progress).
    const hasRowsOnScreen = list.querySelector('.history-item') !== null;
    let pending: AgentChatHistoryEntry[] = [...firstPage.entries];
    let committed = false;
    let lastPaint = startedAt;

    const commit = (): void => {
      if (pending.length === 0) return;
      if (!committed) {
        // Where focus sat before the repaint: on the close button (a first
        // open, where the panel's autofocus found no row yet), or on a row, or
        // on a button of the list about to be replaced. In every one of those
        // cases the repaint takes the position away, and the first row's
        // Resume picks it up - the affordance the panel's `autofocusSelector`
        // intends. A reader who focused something outside the panel keeps it.
        const focusedBefore = document.activeElement;
        const closeButton = panel.element.querySelector<HTMLElement>('.history-panel__close');
        const focusWillBeLost =
          focusedBefore === null ||
          focusedBefore === closeButton ||
          list.contains(focusedBefore) ||
          !panel.element.contains(focusedBefore);
        anchoredRow = undefined;
        anchoredEntry = undefined;
        list.replaceChildren();
        appendItems(pending);
        if (focusWillBeLost) focusAnchoredRowActions();
        committed = true;
      } else {
        appendItems(pending);
      }
      pending = [];
      lastPaint = now();
    };

    if (firstPage.next === undefined) {
      if (pending.length === 0) {
        showMessage('No stored conversations yet', 'history-panel__empty');
      } else {
        commit();
      }
      return;
    }
    if (!hasRowsOnScreen || now() - startedAt >= HISTORY_COALESCE_MS) commit();

    let next: string | undefined = firstPage.next;
    while (next !== undefined) {
      const page = await window.daisy.agentChat.listConversations({ next });
      if (epoch !== loadEpoch) return;
      if (!page.ok) {
        // Rows already gathered stay: one unreadable tail must not erase every
        // conversation. The failure is a note beneath them, where it survives
        // only as long as this panel's list does.
        commit();
        const note = el('p', {
          attrs: { class: 'history-panel__empty' },
          text: `History stopped loading early: ${page.error.message}`,
        });
        if (committed) list.append(note);
        else list.replaceChildren(note);
        return;
      }
      pending.push(...page.entries);
      next = page.next;
      if (next === undefined || now() - lastPaint >= HISTORY_COALESCE_MS) commit();
    }
    if (!committed) showMessage('No stored conversations yet', 'history-panel__empty');
  }

  /**
   * Raises the shared destructive-confirmation prompt - in the pane's message
   * alert banner, exactly as Settings does - and, on OK, deletes and reloads.
   * `deleting` makes the confirmation single-shot, so a second press while the
   * deletion is in flight is inert.
   */
  function requestDelete(entry: AgentChatHistoryEntry): void {
    confirmDestructiveAction(status, 'delete the conversation', () => {
      if (deleting) return;
      deleting = true;
      // Drop the prompt first: the shell reports the outcome ("Conversation
      // deleted" or the failure) through that same single row, which a live
      // prompt would outrank.
      status.clear();
      const settle = (): void => {
        deleting = false;
        void reload();
      };
      void options.onDelete(entry).then(settle, settle);
    });
  }

  return {
    get element() {
      return panel.element;
    },
    get isOpen() {
      return panel.isOpen;
    },
    open(): void {
      panel.open();
      void reload();
    },
    close: () => panel.close(),
    setCloseable: (closeable) => panel.setCloseable(closeable),
    reload,
    setServers(next: readonly HostOption[]): void {
      servers = next;
    },
    dispose: () => panel.dispose(),
  };
}
