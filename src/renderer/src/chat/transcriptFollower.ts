/*
 * The transcript's stick-to-bottom policy.
 *
 * The transcript should follow new entries only while the reader wants to be at
 * the bottom. A plain "is the scroller at the bottom?" check taken at repaint
 * time is not enough, because the scroller's geometry changes for reasons other
 * than the reader scrolling: the status banner appears and shrinks the
 * transcript, the composer grows to a second line, an image or a highlighted
 * code block finishes laying out. Each of those leaves a perfectly pinned
 * reader measuring "not at the bottom", so a geometry sample taken then misreads
 * them as having scrolled away and strands the newest entry off screen - the
 * reported "stuck" transcript. Worse, the banner appearing forces no repaint at
 * all, so it can stay stranded until the next event.
 *
 * The intent to follow is therefore held explicitly here and changed only by a
 * real `scroll` event (the browser reports every user scroll - wheel, scrollbar
 * drag, keyboard, touch - as one, and nothing else moves `scrollTop`). A layout
 * change cannot flip it, and a ResizeObserver re-pins the viewport whenever the
 * geometry changes while the reader is still following, so a banner or a
 * growing composer can no longer leave the newest entry clipped.
 *
 * Geometry itself (`isScrolledToBottom`) stays in `transcriptScroll.ts`, which
 * is DOM-free; this module owns only the stateful wiring.
 */

import { isScrolledToBottom, type Scrollable } from './transcriptScroll';

/** The scroll container and, optionally, the element whose size tracks its content. */
export interface TranscriptFollowerOptions {
  /** The element that scrolls (`.chat-transcript`). */
  readonly scroller: HTMLElement & Scrollable;
  /**
   * The element whose own size grows with the content (the transcript view's
   * messages element). Observed so that content growth *outside* a repaint - a
   * late-loading image, a code block - also re-pins. Optional.
   */
  readonly content?: HTMLElement;
}

export interface TranscriptFollower {
  /**
   * Repaints the transcript, then keeps the viewport on the newest entry if the
   * reader is still following. Unlike a pre-repaint geometry sample, the intent
   * is already known, so appending content cannot make a pinned reader look
   * scrolled away.
   */
  repaint(repaint: () => void): void;
  /**
   * Forces the viewport to the bottom and resumes following. For an action the
   * reader initiated - sending a prompt, starting a new session - where seeing
   * the newest entry is unambiguously what they want, even if they had scrolled
   * up to read history first.
   */
  pin(): void;
  dispose(): void;
}

export function createTranscriptFollower(options: TranscriptFollowerOptions): TranscriptFollower {
  const { scroller, content } = options;
  let following = true;

  // The one signal that the *reader* moved the viewport. Our own programmatic
  // scroll lands at the bottom, so it leaves `following` true either way.
  const onScroll = (): void => {
    following = isScrolledToBottom(scroller);
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });

  const scrollToBottom = (): void => {
    scroller.scrollTop = scroller.scrollHeight;
  };

  // Re-pin on any layout change while following: a banner appearing, the
  // composer growing, or a late-loading image moves the geometry, not the
  // reader. Guarded because jsdom (the renderer unit tests) has no
  // ResizeObserver.
  let resizeObserver: ResizeObserver | undefined;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      if (following) scrollToBottom();
    });
    resizeObserver.observe(scroller);
    if (content !== undefined) resizeObserver.observe(content);
  }

  return {
    repaint(repaint: () => void): void {
      repaint();
      if (following) scrollToBottom();
    },
    pin(): void {
      following = true;
      scrollToBottom();
    },
    dispose(): void {
      scroller.removeEventListener('scroll', onScroll);
      resizeObserver?.disconnect();
    },
  };
}
