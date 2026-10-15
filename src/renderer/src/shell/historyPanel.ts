import { el } from '../lib/dom';
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
 * place before calling back.
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

export interface HistoryPanelCallbacks {
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

export function createHistoryPanel(callbacks: HistoryPanelCallbacks): HistoryPanel {
  let servers: readonly HostOption[] = [];

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
      callbacks.onDismiss();
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
   * The row's two actions. Delete is a deliberate two-step: its first click
   * swaps this area for a confirm prompt, so a stray click can never remove a
   * conversation. Cancel restores the actions; Delete runs the deletion (which
   * the panel then reloads around).
   */
  function buildActions(entry: AgentChatHistoryEntry): HTMLElement {
    const area = el('div', { attrs: { class: 'history-item__actions' } });

    function showActions(): void {
      // Both actions are quiet icon buttons; the icons carry the meaning and the
      // `aria-label`/`title` name them for assistive tech and the mouse
      // tooltip. Resume is the icon-only replacement of the former text button.
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
        callbacks.onResume(entry);
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
      remove.addEventListener('click', () => showConfirm());

      area.replaceChildren(resume, remove);
    }

    function showConfirm(): void {
      const prompt = el('span', {
        attrs: { class: 'history-item__confirm-text' },
        text: 'Delete this conversation?',
      });
      const confirm = el('sp-action-button', {
        attrs: {
          class: 'history-item__confirm-delete',
          title: 'Delete conversation permanently',
        },
        text: 'OK',
      });
      confirm.addEventListener('click', () => {
        confirm.setAttribute('disabled', '');
        void callbacks.onDelete(entry).then(() => reload());
      });
      const cancel = el('sp-action-button', {
        attrs: { quiet: '', class: 'history-item__confirm-cancel', title: 'Keep conversation' },
        text: 'Cancel',
      });
      cancel.addEventListener('click', () => showActions());
      area.replaceChildren(prompt, confirm, cancel);
    }

    showActions();
    return area;
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
