import { el } from '../lib/dom';
import { reportNotWired } from '../lib/notWired';

/**
 * The chat pane's toolbar (requirements-decisions.md section 8). Chat
 * transcript rendering lands in a later implementation-plan step, so New
 * chat and History remain stubs until their agent-session/window-opening
 * IPC surfaces exist; Settings opens the in-shell Settings panel provided by
 * the caller (see `chatPane.ts` -> `shell/mainShell.ts`).
 */
export interface ChatToolbarCallbacks {
  readonly onOpenSettings: () => void;
}

export function createChatToolbar(callbacks: ChatToolbarCallbacks): HTMLElement {
  const toolbar = el('div', { attrs: { class: 'toolbar chat-toolbar', role: 'toolbar' } });

  const newChatButton = el('sp-action-button', { attrs: { quiet: '' } });
  const newChatIcon = document.createElement('sp-icon-chat-add');
  newChatIcon.setAttribute('slot', 'icon');
  newChatButton.append(newChatIcon, document.createTextNode('New chat'));
  newChatButton.addEventListener('click', () => {
    reportNotWired('New chat (no agent-session IPC channel exists yet)');
  });

  const historyButton = el('sp-action-button', { attrs: { quiet: '' } });
  const historyIcon = document.createElement('sp-icon-history');
  historyIcon.setAttribute('slot', 'icon');
  historyButton.append(historyIcon, document.createTextNode('History'));
  historyButton.addEventListener('click', () => {
    reportNotWired(
      'Opening the History child window (no window-opening IPC channel exists yet; ' +
        'requirements-decisions.md section 8 requires History as a separate local child window)',
    );
  });

  const settingsButton = el('sp-action-button', { attrs: { quiet: '' } });
  const settingsIcon = document.createElement('sp-icon-settings');
  settingsIcon.setAttribute('slot', 'icon');
  settingsButton.append(settingsIcon, document.createTextNode('Settings'));
  settingsButton.addEventListener('click', () => {
    callbacks.onOpenSettings();
  });

  toolbar.append(newChatButton, historyButton, settingsButton);
  return toolbar;
}
