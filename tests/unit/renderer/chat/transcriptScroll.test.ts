import { describe, expect, it, vi } from 'vitest';
import {
  isScrolledToBottom,
  repaintAndFollow,
  STICK_TO_BOTTOM_THRESHOLD_PX,
  type Scrollable,
} from '../../../../src/renderer/src/chat/transcriptScroll';

/**
 * A stand-in for the `.chat-transcript` scroller. `transcriptScroll.ts` takes
 * only the geometry it reads, so these tests need no jsdom: a repaint here is
 * simply a callback that changes `scrollHeight`, which is exactly what a real
 * repaint does when it appends an entry.
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

describe('repaintAndFollow', () => {
  it('pins a reader who was at the bottom to the new bottom after the repaint', () => {
    const atBottom = scroller(1000, 400, 600);
    const repaint = vi.fn(() => {
      // The repaint appends an entry, growing the scrollable content.
      (atBottom as { scrollHeight: number }).scrollHeight = 1200;
    });

    repaintAndFollow(atBottom, repaint);

    expect(repaint).toHaveBeenCalledTimes(1);
    expect(atBottom.scrollTop).toBe(1200);
  });

  it('leaves a reader who had scrolled up exactly where they were', () => {
    const scrolledUp = scroller(1000, 400, 100);
    const repaint = vi.fn(() => {
      (scrolledUp as { scrollHeight: number }).scrollHeight = 1200;
    });

    repaintAndFollow(scrolledUp, repaint);

    // The repaint still happens - only the viewport is left alone.
    expect(repaint).toHaveBeenCalledTimes(1);
    expect(scrolledUp.scrollTop).toBe(100);
  });

  it('measures pinned-ness BEFORE the repaint, so appending content does not look like scrolling away', () => {
    // Anti-regression: measuring after the repaint would see the freshly grown
    // scrollHeight and misclassify every pinned reader as having scrolled up.
    const atBottom = scroller(1000, 400, 600);
    const repaint = vi.fn(() => {
      (atBottom as { scrollHeight: number }).scrollHeight = 5000;
    });

    repaintAndFollow(atBottom, repaint);

    expect(atBottom.scrollTop).toBe(5000);
  });

  it('keeps a reader pinned across repeated streaming repaints', () => {
    const atBottom = scroller(400, 400, 0);
    for (let tick = 0; tick < 3; tick += 1) {
      repaintAndFollow(atBottom, () => {
        (atBottom as { scrollHeight: number }).scrollHeight += 20;
      });
    }

    expect(atBottom.scrollTop).toBe(460);
  });
});
