import type { WebContents } from 'electron';

/**
 * Keyboard and context-menu access to Chromium DevTools.
 *
 * The app clears the native application menu (`index.ts`), and with it the
 * default menu's "Toggle Developer Tools" accelerator. A key cannot be bound
 * without an application menu, so the accelerator is restored by listening for
 * the keystroke itself on the relevant `WebContents` (`before-input-event`)
 * rather than by bringing any menu back.
 *
 * The shortcut always targets the *app shell's* `WebContents` - the same target
 * the old menu role used (`focusedWindow.webContents`) - so it behaves
 * identically no matter which half of the window has focus. The page's own
 * DevTools are reached through that pane's right-click "Inspect" item instead
 * (`contextMenu.ts`), which is why this module offers both.
 */

/** Whether `input` is the `Ctrl+Shift+I` toggle: a fresh key-down, not a repeat. */
export function isToggleDevToolsShortcut(input: Electron.Input): boolean {
  return (
    input.type === 'keyDown' &&
    !input.isAutoRepeat &&
    input.control &&
    input.shift &&
    !input.alt &&
    !input.meta &&
    input.code === 'KeyI'
  );
}

/**
 * Binds `Ctrl+Shift+I` on `source` to toggle `target`'s DevTools.
 *
 * `source` and `target` are separate arguments because the browser pane's
 * `WebContentsView` is where the keystroke lands while the shortcut still means
 * the shell's DevTools: the view attaches with `target` = its window's own
 * `WebContents`, the shell with `source === target`.
 */
export function attachDevToolsShortcut(source: WebContents, target: WebContents): void {
  source.on('before-input-event', (event, input) => {
    if (!isToggleDevToolsShortcut(input)) {
      return;
    }
    // Consume the key exactly as a menu accelerator would, so the page never
    // also sees it.
    event.preventDefault();
    target.toggleDevTools();
  });
}

/**
 * Opens `webContents`' DevTools in their own window, unless already open.
 *
 * Detached is explicit on purpose: this is used for the browser pane, whose remote
 * page must not reflow or cover the app's two-pane layout. The caller can then
 * `inspectElement(x, y)` to select the element the menu was invoked on.
 */
export function openDetachedDevTools(webContents: WebContents): void {
  if (webContents.isDevToolsOpened()) {
    return;
  }
  webContents.openDevTools({ mode: 'detach' });
}
