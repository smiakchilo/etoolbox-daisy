import type { Input, WebContents } from 'electron';
import type { AppShortcutAction } from '../shared';
import { applyZoom, type ZoomDirection } from './zoom';

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
 *  - the browser pane is a `WebContentsView`, so its keystrokes land in a
 *    *different* `WebContents` from the shell's and never reach the shell
 *    document. A `document` keydown listener would therefore do nothing
 *    whenever the page has focus - i.e. most of the time while browsing.
 *    So the handler is attached to both, and the browser view's keystrokes are
 *    forwarded to the shell over IPC (`app:shortcut`).
 *  - a shortcut that acts on the page itself needs `webContents` access,
 *    which only main has. Zoom is applied in main to whichever view the
 *    keystroke landed on (`applyZoom`); it never crosses the boundary. Find
 *    only opens renderer UI, so it *is* pushed - see {@link resolveShortcut}.
 *
 * The one deliberate exception is Backspace-to-go-Back, which stays in the
 * renderer: whether the caret is in a text field is only knowable there, and it
 * must be known *before* the key is consumed, which is impossible across an
 * async IPC boundary.
 */

/**
 * Actions that are only bound while the *app shell* has focus. The page is
 * remote authoring UI: a bare `Ctrl+<letter>` there can be the page's own
 * editing shortcut (Ctrl+B is bold in AEM's rich-text editor), so those keys
 * are left to the page. The browser-navigation shortcuts (Back/Forward/Home,
 * Refresh, focus-address, find) and zoom are safe in either context, so they
 * bind everywhere.
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
 * What one keystroke resolves to.
 *
 *  - `action` - a semantic action pushed to the shell renderer over
 *    `app:shortcut`, which dispatches it onto its existing handlers.
 *  - `zoom` - applied to the view the keystroke landed on, in main, with no
 *    boundary crossing.
 *  - `find` - the app-wide find key. Which find bar it opens depends on the
 *    *source* view, which `resolveShortcut` cannot see (it is pure); the
 *    {@link attachShortcutHandling} wrapper resolves it to `browser.find` for
 *    the browser view or `app.find` for the shell.
 */
export type ShortcutResolution =
  | { readonly kind: 'action'; readonly action: AppShortcutAction }
  | { readonly kind: 'zoom'; readonly direction: ZoomDirection }
  | { readonly kind: 'find' };

/**
 * Resolves one `before-input-event` payload to what it requests, or `null` for
 * a keystroke the app does not claim. Pure, so the key map is unit-testable
 * without a `WebContents`.
 *
 * Matching accepts either `input.code` (the physical key - layout-independent,
 * the same choice `devTools.ts` makes) or `input.key` (the produced key). Both
 * are needed: a real OS keystroke can carry an **empty** `code` - measured live,
 * the numpad's `+`/`-` arrive as `code: ""`, `key: "+"`/`"-"`, which is exactly
 * why the numpad zoom keys did nothing while the letter shortcuts worked. The
 * `code` is the primary match; `key` is the fallback for those empty-code keys.
 *
 * Shift is deliberately excluded from every Ctrl binding, so the app never
 * claims a `Ctrl+Shift+<key>` combination (other conventions own those; the
 * DevTools toggle stays Ctrl+Shift+I) - with one exception: Shift is accepted
 * for the `+`, so the literal `Ctrl++` (`Ctrl+Shift+=`) zooms in. Zoom binds the
 * numpad's `+`/`-` (`NumpadAdd`/`NumpadSubtract`, unaffected by NumLock, and
 * their `+`/`-` keys) and `Ctrl+0` (`Digit0`/`Numpad0`).
 */
export function resolveShortcut(input: Input): ShortcutResolution | null {
  // A fresh key-down only: a key-up would double-fire, and an auto-repeat would
  // re-run a navigation - or a zoom step - for as long as the key is held.
  if (input.type !== 'keyDown' || input.isAutoRepeat) return null;

  const { control, alt, shift, meta } = input;
  // Cmd is never an app modifier here; ignoring it keeps a Cmd+... keystroke
  // from being read as its Ctrl twin.
  if (meta) return null;

  /** The physical key (`code`) or, when that is empty, the produced key (`key`). */
  const is = (codes: readonly string[], keys: readonly string[]): boolean =>
    codes.includes(input.code) || keys.includes(input.key.toLowerCase());

  // Alt is location navigation, matching Windows browsers: Alt+Left/Right are
  // Back/Forward and Alt+Home is Home.
  if (alt && !control && !shift) {
    if (is(['ArrowLeft'], ['arrowleft'])) return { kind: 'action', action: 'browser.back' };
    if (is(['ArrowRight'], ['arrowright'])) return { kind: 'action', action: 'browser.forward' };
    if (is(['Home'], ['home'])) return { kind: 'action', action: 'browser.home' };
    return null;
  }

  // F5, unmodified - the browser Refresh key.
  if (!control && !alt && !shift && is(['F5'], ['f5'])) {
    return { kind: 'action', action: 'browser.refresh' };
  }

  if (!control || alt) return null;

  // Zoom: the numpad's own `+`/`-` (and, on the main row, the literal `+` that
  // is Shift+=) in/out, `Ctrl+0` back to 100%. Shift is accepted only for the
  // `+`, so the "never claim Ctrl+Shift" rule still holds everywhere else.
  if (is(['NumpadAdd'], ['+'])) return { kind: 'zoom', direction: 'in' };
  if (!shift && is(['NumpadSubtract'], ['-'])) return { kind: 'zoom', direction: 'out' };
  if (!shift && is(['Digit0', 'Numpad0'], ['0'])) return { kind: 'zoom', direction: 'reset' };

  if (shift) return null;
  if (is(['KeyR'], ['r'])) return { kind: 'action', action: 'browser.refresh' };
  if (is(['KeyL'], ['l'])) return { kind: 'action', action: 'browser.focusAddress' };
  if (is(['KeyF'], ['f'])) return { kind: 'find' };
  if (is(['KeyH'], ['h'])) return { kind: 'action', action: 'chat.history' };
  if (is(['KeyN'], ['n'])) return { kind: 'action', action: 'chat.newSession' };
  if (is(['Comma'], [','])) return { kind: 'action', action: 'chat.settings' };
  return null;
}

export interface ShortcutHandlingOptions {
  /**
   * Whether the chat-pane actions are bound for this source. Only the app
   * shell passes `true`; the browser view passes `false` so the remote page keeps
   * its own `Ctrl+<letter>` editing shortcuts (see {@link CHAT_SHORTCUT_ACTIONS}).
   * It also resolves the find key: the shell pushes `app.find`, the browser view
   * pushes `browser.find`.
   */
  readonly allowChatShortcuts: boolean;
  /** Delivers a resolved action to the shell renderer. */
  readonly send: (action: AppShortcutAction) => void;
  /**
   * Moves keyboard focus to the shell, called just before an action whose
   * target lives in the shell document and can only take input once the
   * shell's `WebContents` owns the keyboard - the address bar
   * (`browser.focusAddress`) and the find bar's field (`browser.find` /
   * `app.find`). It is a no-op when the shell already has focus.
   */
  readonly focusShell: () => void;
  /** Called after a zoom step was applied to `source`, so the level can be remembered. */
  readonly onZoomChanged?: () => void;
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
    const resolved = resolveShortcut(input);
    if (resolved === null) return;
    if (resolved.kind === 'zoom') {
      event.preventDefault();
      applyZoom(source, resolved.direction);
      options.onZoomChanged?.();
      return;
    }
    const action: AppShortcutAction =
      resolved.kind === 'find'
        ? options.allowChatShortcuts
          ? 'app.find'
          : 'browser.find'
        : resolved.action;
    if (!options.allowChatShortcuts && isChatShortcutAction(action)) return;
    event.preventDefault();
    if (action === 'browser.focusAddress' || action === 'browser.find' || action === 'app.find') {
      options.focusShell();
    }
    options.send(action);
  });
}
