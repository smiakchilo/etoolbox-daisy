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
 * listConversations`); the panel keeps no state of its own beyond the rows it
 * painted. Each row is a title, the chat's start date, and the host it is bound
 * to, with a **Resume** action (open the conversation, switching the browser to
 * its host - the shell does that part) and a **Delete** action that confirms in
 * the pane's message alert banner (the shared one-button prompt the Settings
 * panel uses) before calling back.
 *
 * Resume and delete are callbacks, not IPC calls made here: the shell owns the
 * chat pane (which repaints the resumed transcript) and the browser pane (which
 * switches hosts), so the panel only reports what the reader chose.
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
   * sink the Settings panel is handed. A destructive confirmation, and the
   * outcome the shell reports for it, live in the pane's message alert banner,
   * never in the row: one shared confirmation method for every surface that
   * destroys something, and feedback that outlives the panel.
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
}

export function createHistoryPanel(options: HistoryPanelOptions): HistoryPanel {
  const status = options.status;
  let servers: readonly HostOption[] = [];
  /** True while a confirmed deletion is in flight, so a second press is inert. */
  let deleting = false;

  const list = el('div', {
    attrs: { class: 'history-panel__list', role: 'list', 'aria-label': 'Stored conversations' },
  });

  const panel = createPanel({
    title: 'History',
    closeAriaLabel: 'Close history',
    surfaceClassName: 'history-panel',
    closeButtonClassName: 'history-panel__close',
    autofocusSelector: '.history-item__resume',
    content: list,
    onDismiss(): void {
      options.onDismiss();
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

  /**
   * The row's two actions. Resume opens the conversation; Delete asks for
   * confirmation in the pane's shared one-button alert-banner prompt (the same
   * method Settings uses to remove a host/project/proxy), so a stray click can
   * never remove a conversation and the confirmation is the same control
   * everywhere - never a second, row-local dialog.
   */
  function buildActions(entry: AgentChatHistoryEntry): HTMLElement {
    const area = el('div', { attrs: { class: 'history-item__actions' } });

    // Both actions are quiet icon buttons; the icons carry the meaning and the
    // `aria-label`/`title` name them for assistive tech and the mouse tooltip.
    const resume = el('sp-action-button', {
      attrs: {
        quiet: '',
        class: 'history-item__resume',
        title: 'Resume conversation',
        'aria-label': 'Resume conversation',
      },
    });
    const resumeIcon = document.createElement('sp-icon-replay');
    resumeIcon.setAttribute('slot', 'icon');
    resume.append(resumeIcon);
    resume.addEventListener('click', () => {
      options.onResume(entry);
    });

    const remove = el('sp-action-button', {
      attrs: {
        quiet: '',
        class: 'history-item__delete',
        title: 'Delete conversation',
        'aria-label': 'Delete conversation',
      },
    });
    const removeIcon = document.createElement('sp-icon-delete-outline');
    removeIcon.setAttribute('slot', 'icon');
    remove.append(removeIcon);
    remove.addEventListener('click', () => requestDelete(entry));

    area.replaceChildren(resume, remove);
    return area;
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
    return el('div', {
      attrs: { class: 'history-item', role: 'listitem', 'data-chat-id': entry.chatId },
      children: [main, buildActions(entry)],
    });
  }

  function showMessage(text: string, className: string): void {
    list.replaceChildren(el('p', { attrs: { class: className }, text }));
  }

  async function reload(): Promise<void> {
    const result = await window.daisy.agentChat.listConversations();
    if (!result.ok) {
      showMessage(`History is unavailable: ${result.error.message}`, 'history-panel__empty');
      return;
    }
    if (result.entries.length === 0) {
      showMessage('No stored conversations yet', 'history-panel__empty');
      return;
    }
    list.replaceChildren(...result.entries.map(buildItem));
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
