import { isBrowserPaneFraction } from '../shell/splitLayout';

/**
 * Persistence for the main window's pane boundary.
 *
 * This deliberately does *not* go through `AppSettings`/`settings:*` IPC:
 * that document is a step-03 contract whose write path is restricted to the
 * Settings window, and a dragged pane divider is renderer-local view state,
 * not configuration the main process or the agent ever needs to read. Window
 * `localStorage` is scoped to this app's own partition and survives restarts,
 * which is exactly the required lifetime and no more.
 *
 * Every access is guarded: `localStorage` throws rather than returning null
 * when storage is unavailable or over quota, and a failure to remember a pane
 * width must never take the window down with it.
 */

const STORAGE_KEY = 'daisy.mainShell.browserPaneFraction';

/** The last committed fraction, or `undefined` when there is no usable stored value. */
export function loadBrowserPaneFraction(): number | undefined {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;

  // A value written by a different build, hand-edited, or truncated mid-write
  // is discarded rather than trusted: `Number.parseFloat("abc")` is NaN and
  // `"1.5"` would collapse the chat pane entirely.
  const parsed = Number.parseFloat(raw);
  return isBrowserPaneFraction(parsed) ? parsed : undefined;
}

/** Records a settled fraction. Called on drag end / key press, never per pointer move. */
export function saveBrowserPaneFraction(fraction: number): void {
  if (!isBrowserPaneFraction(fraction)) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(fraction));
  } catch {
    // Nothing actionable for the user here - the layout still works for this
    // run, it just will not be remembered for the next one.
  }
}
