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

/**
 * Neither pane may be dragged below these; both stay usable rather than
 * becoming a sliver.
 *
 * The browser pane's floor is set by the Settings "Hosts" row (and the AEM page
 * benefits from it too): its colour tag (150px), its Label field and its Type
 * picker - the two sharing the same width, 116px - plus the row's gaps and the
 * panel's own padding need ~508px before the row has to wrap. 540 leaves room
 * for the tab panel's scrollbar. The row itself (`.host-field-row` in
 * `styles/settings.css`) carries the same relation in a comment and wraps as a
 * last resort, so a window squeezed below both minima degrades instead of
 * painting one field over its neighbour.
 */
export const MIN_BROWSER_PANE_PX = 540;
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
