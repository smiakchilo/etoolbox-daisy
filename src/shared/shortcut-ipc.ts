import { z } from 'zod';

/**
 * Wire contract for the application-wide keyboard shortcut layer.
 *
 * The app has no native menu bar (`index.ts` clears the application menu), so
 * a keyboard shortcut cannot be an accelerator. It is instead matched on the
 * relevant `WebContents` via `before-input-event` (`src/main/shortcuts.ts`) -
 * on the shell's and on the browser view's, because the browser pane is a
 * `WebContentsView` whose keystrokes never reach the shell's document.
 *
 * Main resolves a keystroke to one of these *semantic* actions and pushes it to
 * the shell renderer, which dispatches it onto the very handlers its toolbar
 * buttons already use. Keeping the vocabulary semantic (not "key X was
 * pressed") is what lets the renderer reuse the existing navigation paths -
 * with their guards, banners and reveal-over-panel behaviour - instead of
 * re-implementing a second navigation path.
 */

/**
 * Every action a shortcut can request. Deliberately small and closed. Zoom is
 * *not* here: it needs no renderer state, so it is acted on in main directly
 * and never crosses the boundary (`src/main/zoom.ts`). Find-in-page does cross
 * it - the find bar is renderer UI - so it has two entries, because the
 * renderer cannot tell which pane the keystroke came from on its own:
 * `browser.find` is pushed when the browser view had focus (find the page) and
 * `app.find` when the shell did (the renderer picks the focused surface).
 */
export const APP_SHORTCUT_ACTIONS = [
  /** Refresh the browser pane (the toolbar's Refresh control). */
  'browser.refresh',
  /** Back (the toolbar's Back control). */
  'browser.back',
  /** Forward (the toolbar's Forward control). */
  'browser.forward',
  /** Reveal the pane's home (welcome) screen. */
  'browser.home',
  /** Focus and select the address bar. */
  'browser.focusAddress',
  /** Open the page's find bar. Sent when the keystroke came from the browser view. */
  'browser.find',
  /** Open the focused shell surface's find bar. Sent when the keystroke came from the app shell. */
  'app.find',
  /** Open the History panel. */
  'chat.history',
  /** Open the Settings panel. */
  'chat.settings',
  /** Start a new conversation (the chat toolbar's "New session"). */
  'chat.newSession',
] as const;

export type AppShortcutAction = (typeof APP_SHORTCUT_ACTIONS)[number];

export const appShortcutActionSchema = z.enum(APP_SHORTCUT_ACTIONS);

export function parseAppShortcutAction(candidate: unknown): AppShortcutAction {
  return appShortcutActionSchema.parse(candidate);
}
