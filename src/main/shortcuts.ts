import type { Input, WebContents } from 'electron';
import type { AppShortcutAction } from '../shared';

/**
 * Application-wide keyboard shortcuts, without a menu bar.
 *
 * The app clears the native application menu (`index.ts`), so a shortcut cannot
 * be an accelerator - exactly the situation `devTools.ts` already solves for
 * Ctrl+Shift+I. This module generalises that pattern: it matches a keystroke in
 * `before-input-event` and routes it as a *semantic* action.
 *
 * Two things make this main-process work rather than a renderer key listener:
 *
 *  - the AEM pane is a `WebContentsView`, so its keystrokes land in a
 *    *different* `WebContents` from the shell's and never reach the shell
 *    document. A `document` keydown listener would therefore do nothing
 *    whenever the AEM page has focus - i.e. most of the time while browsing.
 *    So the handler is attached to both, and the AEM view's keystrokes are
 *    forwarded to the shell over IPC (`app:shortcut`).
 *  - a shortcut that acts on the AEM page itself (not implemented in this pass)
 *    would need `webContents` access, which only main has.
 *
 * The one deliberate exception is Backspace-to-go-Back, which stays in the
 * renderer: whether the caret is in a text field is only knowable there, and it
 * must be known *before* the key is consumed, which is impossible across an
 * async IPC boundary.
 */

/**
 * Actions that are only bound while the *app shell* has focus. The AEM page is
 * remote authoring UI: a bare `Ctrl+<letter>` there can be the page's own
 * editing shortcut (Ctrl+B is bold in AEM's rich-text editor), so those keys
 * are left to the page. The browser-navigation shortcuts (Back/Forward/Home,
 * Refresh, focus-address) are safe in either context, so they bind everywhere.
 */
const CHAT_SHORTCUT_ACTIONS: ReadonlySet<AppShortcutAction> = new Set([
  'chat.history',
  'chat.settings',
  'chat.newSession',
]);

export function isChatShortcutAction(action: AppShortcutAction): boolean {
  return CHAT_SHORTCUT_ACTIONS.has(action);
}

/**
 * Resolves one `before-input-event` payload to the action it requests, or
 * `null` for a keystroke the app does not claim. Pure, so the key map is
 * unit-testable without a `WebContents`.
 *
 * Matching is on `input.code` (the physical key), not `input.key`, so it is
 * layout-independent - the same choice `devTools.ts` makes. Shift is
 * deliberately excluded from every Ctrl binding, so the app never claims a
 * `Ctrl+Shift+<key>` combination (other conventions own those; the DevTools
 * toggle stays Ctrl+Shift+I).
 */
export function resolveShortcut(input: Input): AppShortcutAction | null {
  // A fresh key-down only: a key-up would double-fire, and an auto-repeat would
  // re-run a navigation for as long as the key is held.
  if (input.type !== 'keyDown' || input.isAutoRepeat) return null;

  const { control, alt, shift, meta, code } = input;
  // Cmd is never an app modifier here; ignoring it keeps a Cmd+... keystroke
  // from being read as its Ctrl twin.
  if (meta) return null;

  // Alt is location navigation, matching Windows browsers: Alt+Left/Right are
  // Back/Forward and Alt+Home is Home.
  if (alt && !control && !shift) {
    switch (code) {
      case 'ArrowLeft':
        return 'browser.back';
      case 'ArrowRight':
        return 'browser.forward';
      case 'Home':
        return 'browser.home';
      default:
        return null;
    }
  }

  // F5, unmodified - the browser Refresh key.
  if (!control && !alt && !shift && code === 'F5') return 'browser.refresh';

  if (!control || alt || shift) return null;
  switch (code) {
    case 'KeyR':
      return 'browser.refresh';
    case 'KeyL':
      return 'browser.focusAddress';
    case 'KeyH':
      return 'chat.history';
    case 'KeyN':
      return 'chat.newSession';
    case 'Comma':
      return 'chat.settings';
    default:
      return null;
  }
}

export interface ShortcutHandlingOptions {
  /**
   * Whether the chat-pane actions are bound for this source. Only the app
   * shell passes `true`; the AEM view passes `false` so the remote page keeps
   * its own `Ctrl+<letter>` editing shortcuts (see {@link CHAT_SHORTCUT_ACTIONS}).
   */
  readonly allowChatShortcuts: boolean;
  /** Delivers a resolved action to the shell renderer. */
  readonly send: (action: AppShortcutAction) => void;
  /**
   * Moves keyboard focus to the shell, called just before a
   * `browser.focusAddress` action - the address bar can only take typing once
   * the shell's `WebContents` owns the keyboard, which it does not while the
   * AEM pane has focus.
   */
  readonly focusShell: () => void;
}

/**
 * Binds the app's shortcuts on `source`, consuming a claimed key exactly as a
 * menu accelerator would (`preventDefault`, so the page never also sees it).
 * Returns nothing: the listeners live for the `WebContents`' lifetime, as they
 * do in `devTools.ts`.
 */
export function attachShortcutHandling(
  source: WebContents,
  options: ShortcutHandlingOptions,
): void {
  source.on('before-input-event', (event, input) => {
    const action = resolveShortcut(input);
    if (action === null) return;
    if (!options.allowChatShortcuts && isChatShortcutAction(action)) return;
    event.preventDefault();
    if (action === 'browser.focusAddress') options.focusShell();
    options.send(action);
  });
}
