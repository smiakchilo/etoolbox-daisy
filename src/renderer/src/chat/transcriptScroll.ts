/*
 * Keeping the transcript pinned to its newest entry.
 *
 * `transcriptView.ts` deliberately owns only the messages element, not the
 * scroller that clips it (`.chat-transcript`, see `chatPane.ts`): the view
 * re-renders its own children and has no business knowing how they are framed.
 * The policy for "when should the viewport follow the newest entry" therefore
 * lives here, as a pair of DOM-free functions over the scroller's geometry, so
 * it can be reasoned about and tested without a layout engine.
 *
 * The behaviour is sticky-to-bottom, not unconditional: the viewport follows
 * new entries (and the streaming growth of the current assistant message) only
 * while the reader is already at the bottom. The moment they scroll up to read
 * history, appended content must not yank them back down. The one subtlety
 * that makes this correct is that the check is taken BEFORE the repaint: after
 * a repaint appends content the scroller is momentarily "not at the bottom" for
 * a perfectly pinned reader, so measuring afterwards would misread every pinned
 * reader as having scrolled away.
 */

/**
 * How close to the bottom counts as "pinned". Non-zero because `scrollTop` is
 * not always integral (zoom, fractional line heights), so an exactly-at-bottom
 * reader can measure a sub-pixel gap; a couple of pixels also comfortably
 * absorbs a trackpad's imprecision.
 */
export const STICK_TO_BOTTOM_THRESHOLD_PX = 4;

/**
 * The slice of an element this module needs. `HTMLElement` satisfies it
 * structurally, so production passes the real scroller while tests pass a plain
 * object and need no layout engine at all.
 */
export interface Scrollable {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** Whether `scroller` is at (or within `thresholdPx` of) its bottom edge. */
export function isScrolledToBottom(
  scroller: Scrollable,
  thresholdPx: number = STICK_TO_BOTTOM_THRESHOLD_PX,
): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= thresholdPx;
}

/**
 * Repaints the transcript and re-pins the scroller to the bottom afterwards,
 * but only if it was already pinned before the repaint. See this module's
 * header for why the "was pinned" check must precede `repaint`.
 */
export function repaintAndFollow(scroller: Scrollable, repaint: () => void): void {
  const pinned = isScrolledToBottom(scroller);
  repaint();
  if (pinned) scroller.scrollTop = scroller.scrollHeight;
}
