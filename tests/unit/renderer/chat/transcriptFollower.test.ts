import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTranscriptFollower } from '../../../../src/renderer/src/chat/transcriptFollower';

/**
 * The transcript's stick-to-bottom policy.
 *
 * The point of the follower (over a bare geometry sample) is that it tracks the
 * reader's *intent* from real `scroll` events, so a layout change - a banner
 * appearing, the composer growing, a late image - can neither look like
 * scrolling away nor leave the newest entry stranded. jsdom has no layout, so
 * the scroller's geometry is injected; jsdom also does not fire a `scroll`
 * event on a programmatic `scrollTop` change, so each simulated scroll
 * dispatches one, exactly as a browser would.
 */

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;
const previousResizeObserver = Reflect.get(globalThis, 'ResizeObserver') as unknown;

let dom: JSDOM;

interface ObserverRecord {
  readonly callback: ResizeObserverCallback;
  readonly targets: Element[];
  disconnected: boolean;
}

let observers: ObserverRecord[];

class StubResizeObserver {
  private readonly record: ObserverRecord;

  constructor(callback: ResizeObserverCallback) {
    this.record = { callback, targets: [], disconnected: false };
    observers.push(this.record);
  }

  observe(target: Element): void {
    this.record.targets.push(target);
  }

  unobserve(): void {
    // No-op: the follower only ever observes, never unobserves.
  }

  disconnect(): void {
    this.record.disconnected = true;
  }
}

/** A scroller whose `scrollHeight`/`clientHeight` the test can change to model layout. */
function scroller(
  scrollHeight: number,
  clientHeight: number,
): { element: HTMLElement; box: { scrollHeight: number; clientHeight: number } } {
  const box = { scrollHeight, clientHeight };
  const element = dom.window.document.createElement('div');
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => box.scrollHeight,
  });
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => box.clientHeight,
  });
  return { element, box };
}

/** Fires the most recently created observer, as a layout change would. */
function triggerLayoutChange(): void {
  const record = observers.at(-1);
  record?.callback([], record as unknown as ResizeObserver);
}

beforeEach(() => {
  dom = new JSDOM();
  Reflect.set(globalThis, 'document', dom.window.document);
  Reflect.set(globalThis, 'window', dom.window);
  observers = [];
  Reflect.set(globalThis, 'ResizeObserver', StubResizeObserver);
});

afterEach(() => {
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
  Reflect.set(globalThis, 'window', previousWindow);
  Reflect.set(globalThis, 'ResizeObserver', previousResizeObserver);
});

describe('createTranscriptFollower', () => {
  it('follows a repaint while the reader is at the bottom', () => {
    const { element, box } = scroller(1000, 400);
    const follower = createTranscriptFollower({ scroller: element });
    element.scrollTop = 600; // exactly at the bottom

    follower.repaint(() => {
      box.scrollHeight = 1200;
    });

    expect(element.scrollTop).toBe(1200);
    follower.dispose();
  });

  it('leaves a reader who deliberately scrolled up where they were', () => {
    const { element, box } = scroller(1000, 400);
    const follower = createTranscriptFollower({ scroller: element });
    element.scrollTop = 100;
    element.dispatchEvent(new dom.window.Event('scroll'));

    follower.repaint(() => {
      box.scrollHeight = 1200;
    });

    expect(element.scrollTop).toBe(100);
    follower.dispose();
  });

  it('re-pins on a layout change while the reader is following', () => {
    const { element, box } = scroller(1000, 400);
    const follower = createTranscriptFollower({ scroller: element });
    element.scrollTop = 600; // pinned

    // A banner appears: the scroller shrinks, but no scroll event fires.
    box.clientHeight = 300;
    triggerLayoutChange();

    expect(element.scrollTop).toBe(1000);
    follower.dispose();
  });

  it('does not re-pin on a layout change once the reader has scrolled up', () => {
    const { element, box } = scroller(1000, 400);
    const follower = createTranscriptFollower({ scroller: element });
    element.scrollTop = 100;
    element.dispatchEvent(new dom.window.Event('scroll'));

    box.clientHeight = 300;
    triggerLayoutChange();

    expect(element.scrollTop).toBe(100);
    follower.dispose();
  });

  it('pin forces the bottom and resumes following', () => {
    const { element, box } = scroller(1000, 400);
    const follower = createTranscriptFollower({ scroller: element });
    element.scrollTop = 100;
    element.dispatchEvent(new dom.window.Event('scroll'));

    follower.pin();
    expect(element.scrollTop).toBe(1000);

    // Following resumed: a later repaint keeps the viewport at the bottom.
    follower.repaint(() => {
      box.scrollHeight = 1200;
    });
    expect(element.scrollTop).toBe(1200);
    follower.dispose();
  });

  it('observes the content element as well as the scroller', () => {
    const { element } = scroller(1000, 400);
    const content = dom.window.document.createElement('div');
    const follower = createTranscriptFollower({ scroller: element, content });

    expect(observers[0]?.targets[0]).toBe(element);
    expect(observers[0]?.targets[1]).toBe(content);
    follower.dispose();
  });

  it('stops tracking scroll and layout once disposed', () => {
    const { element, box } = scroller(1000, 400);
    const follower = createTranscriptFollower({ scroller: element });
    follower.dispose();

    expect(observers[0]?.disconnected).toBe(true);

    // The scroll listener is gone, so a scroll that would have flipped the
    // intent is ignored and a repaint still follows.
    element.scrollTop = 100;
    element.dispatchEvent(new dom.window.Event('scroll'));
    follower.repaint(() => {
      box.scrollHeight = 1200;
    });

    expect(element.scrollTop).toBe(1200);
  });
});
