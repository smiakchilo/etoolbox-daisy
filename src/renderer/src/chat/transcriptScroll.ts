/*
 * Keeping the transcript pinned to its newest entry: the geometry half.
 *
 * This module is deliberately DOM-free and state-free - just the one predicate
 * over the scroller's geometry - so it can be reasoned about and tested without
 * a layout engine. The stateful policy that decides *when* to apply it, and
 * that survives layout changes the reader did not cause, lives next door in
 * `transcriptFollower.ts`.
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
