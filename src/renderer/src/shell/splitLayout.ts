/**
 * Shared constants for the main window's draggable pane boundary
 * (`mainSplitView.ts`, backed by `sp-split-view`) and its persisted-fraction
 * storage (`paneLayoutStore.ts`).
 *
 * The persisted quantity is a *fraction* of the resizable width, not a pixel
 * width: the window is resizable, and a stored pixel width would either leave
 * the chat pane stranded at its old size in a much wider window, or overflow
 * a narrower one.
 */

/** Neither pane may be dragged below these; both stay usable rather than becoming a sliver. */
export const MIN_BROWSER_PANE_PX = 320;
export const MIN_CHAT_PANE_PX = 280;

/** Matches the split `sp-split-view` falls back to before any drag has happened. */
export const DEFAULT_BROWSER_PANE_FRACTION = 2 / 3;

/**
 * Whether a value read back from storage is usable as a pane fraction. The
 * open interval is deliberate: a stored `0` or `1` would restore the app with
 * one pane fully collapsed, which is indistinguishable from a broken layout.
 */
export function isBrowserPaneFraction(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1;
}
