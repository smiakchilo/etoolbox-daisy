import { describe, expect, it } from 'vitest';
import {
  isScrolledToBottom,
  STICK_TO_BOTTOM_THRESHOLD_PX,
  type Scrollable,
} from '../../../../src/renderer/src/chat/transcriptScroll';

/**
 * The transcript scroll policy's geometry predicate. `transcriptScroll.ts`
 * takes only the geometry it reads, so these tests need no jsdom: a scroller is
 * just a plain object. The stateful policy built on top of it is tested in
 * `transcriptFollower.test.ts`.
 */
function scroller(scrollHeight: number, clientHeight = 400, scrollTop = 0): Scrollable {
  return { scrollHeight, clientHeight, scrollTop };
}

describe('isScrolledToBottom', () => {
  it('is true exactly at the bottom', () => {
    // scrollHeight - scrollTop - clientHeight === 0
    expect(isScrolledToBottom(scroller(1000, 400, 600))).toBe(true);
  });

  it('is true within the threshold, to absorb sub-pixel and trackpad gaps', () => {
    expect(isScrolledToBottom(scroller(1000, 400, 600 - STICK_TO_BOTTOM_THRESHOLD_PX))).toBe(true);
  });

  it('is false once scrolled up past the threshold', () => {
    expect(isScrolledToBottom(scroller(1000, 400, 600 - STICK_TO_BOTTOM_THRESHOLD_PX - 1))).toBe(
      false,
    );
  });

  it('honours an explicit threshold', () => {
    expect(isScrolledToBottom(scroller(1000, 400, 590), 10)).toBe(true);
    expect(isScrolledToBottom(scroller(1000, 400, 589), 10)).toBe(false);
  });
});
