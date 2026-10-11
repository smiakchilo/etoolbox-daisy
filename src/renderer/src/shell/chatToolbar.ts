import { el } from '../lib/dom';
import { reportNotWired } from '../lib/notWired';

/**
 * The chat pane's toolbar (requirements-decisions.md section 8). New session
 * starts a fresh conversation - the current one is torn down and the
 * transcript emptied (see `chatPane.ts`'s `startNewSession`); History remains
 * a stub until its window-opening IPC surface exists; Settings opens the
 * in-shell Settings panel provided by the caller (see `chatPane.ts` ->
 * `shell/mainShell.ts`).
 */
export interface ChatToolbarCallbacks {
  readonly onOpenSettings: () => void;
  /**
   * Starts a brand-new conversation: current conversation context and the
   * on-screen transcript are both discarded.
   */
  readonly onNewSession: () => void;
}

export interface ChatToolbar {
  readonly element: HTMLElement;
  /**
   * Enables or disables "New session". The pane disables it while a
   * conversation open is still resolving, so a second conversation cannot be
   * started over one that is not finished opening (see `chatPane.ts`'s
   * `openConversation`).
   */
  setNewSessionEnabled(enabled: boolean): void;
}

export function createChatToolbar(callbacks: ChatToolbarCallbacks): ChatToolbar {
  const toolbar = el('div', { attrs: { class: 'toolbar chat-toolbar', role: 'toolbar' } });

  const newSessionButton = el('sp-action-button', {
    attrs: { quiet: '', title: 'New session' },
  });
  const newChatIcon = document.createElement('sp-icon-chat-add');
  newChatIcon.setAttribute('slot', 'icon');
  newSessionButton.append(newChatIcon, document.createTextNode('New session'));
  newSessionButton.addEventListener('click', () => {
    callbacks.onNewSession();
  });

  // History and Settings are icon-only and pinned to the right edge by the
  // `chat-toolbar__end` auto margin; `title`/`aria-label` carry the name for
  // sighted mouse users (native tooltip) and assistive tech alike.
  const historyButton = el('sp-action-button', {
    attrs: { quiet: '', class: 'chat-toolbar__end', title: 'History', 'aria-label': 'History' },
  });
  const historyIcon = document.createElement('sp-icon-history');
  historyIcon.setAttribute('slot', 'icon');
  historyButton.append(historyIcon);
  historyButton.addEventListener('click', () => {
    reportNotWired(
      'Opening the History child window (no window-opening IPC channel exists yet; ' +
        'requirements-decisions.md section 8 requires History as a separate local child window)',
    );
  });

  const settingsButton = el('sp-action-button', {
    attrs: { quiet: '', title: 'Settings', 'aria-label': 'Settings' },
  });
  const settingsIcon = document.createElement('sp-icon-settings');
  settingsIcon.setAttribute('slot', 'icon');
  settingsButton.append(settingsIcon);
  settingsButton.addEventListener('click', () => {
    callbacks.onOpenSettings();
  });

  toolbar.append(newSessionButton, historyButton, settingsButton);
  return {
    element: toolbar,
    setNewSessionEnabled(enabled: boolean): void {
      if (enabled) newSessionButton.removeAttribute('disabled');
      else newSessionButton.setAttribute('disabled', '');
    },
  };
}
