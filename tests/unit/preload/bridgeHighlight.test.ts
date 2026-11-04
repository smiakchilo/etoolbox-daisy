import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { performBridgeHighlight } from '../../../src/preload/bridgeHighlight';

/**
 * The report's element highlight: the selector is handed to `querySelector`
 * only (never script), the first match is scrolled into view and outlined, and
 * a second call moves the outline to the new element. The outline persists on
 * the element; a navigation clears it by replacing the document.
 */

const dom = new JSDOM();

beforeAll(() => {
  if (typeof dom.window.HTMLElement.prototype.scrollIntoView !== 'function') {
    Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  }
});

afterAll(() => {
  dom.window.close();
});

function pageWith(body: string): Document {
  const doc = dom.window.document;
  doc.body.innerHTML = body;
  return doc;
}

/** Gives one element a real box, so the viewport preference can be exercised. */
function defineRect(
  element: Element,
  rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }),
  });
}

describe('performBridgeHighlight', () => {
  it('outlines the first match and reports it found', () => {
    const doc = pageWith('<div id="a"></div><div id="b"></div>');

    expect(performBridgeHighlight('#b', doc)).toBe(true);
    const target = doc.querySelector('#b') as HTMLElement;
    expect(target.style.outline).toContain('solid');
    // A page's `outline: none` reset must not be able to suppress it.
    expect(target.style.getPropertyPriority('outline')).toBe('important');
  });

  it('reports not-found for a selector that matches nothing', () => {
    expect(performBridgeHighlight('#missing', pageWith('<div id="a"></div>'))).toBe(false);
  });

  it('reports not-found for an invalid selector', () => {
    expect(performBridgeHighlight(':not(:not(:not(', pageWith('<div></div>'))).toBe(false);
  });

  it('moves the outline to the newly chosen element', () => {
    const doc = pageWith('<div id="a"></div><div id="b"></div>');
    performBridgeHighlight('#a', doc);
    performBridgeHighlight('#b', doc);

    expect((doc.querySelector('#a') as HTMLElement).style.outline).toBe('');
    expect((doc.querySelector('#b') as HTMLElement).style.outline).toContain('solid');
  });

  it('refuses a document that is not the page the report was about', () => {
    const other = new JSDOM('<div id="a"></div>', {
      url: 'https://author.example/content/a.html',
    });
    Object.defineProperty(other.window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    try {
      const doc = other.window.document;
      expect(performBridgeHighlight('#a', doc, 'https://author.example/content/other.html')).toBe(
        false,
      );
      expect((doc.querySelector('#a') as HTMLElement).style.outline).toBe('');
      // A trailing hash names the same document; the page is highlighted.
      expect(performBridgeHighlight('#a', doc, 'https://author.example/content/a.html#frag')).toBe(
        true,
      );
    } finally {
      other.window.close();
    }
  });

  it('prefers a match already on screen over an off-screen one', () => {
    const doc = pageWith('<div class="item" id="first"></div><div class="item" id="second"></div>');
    const first = doc.querySelector('#first') as HTMLElement;
    const second = doc.querySelector('#second') as HTMLElement;
    defineRect(first, { left: 0, top: -500, width: 100, height: 100 });
    defineRect(second, { left: 10, top: 10, width: 100, height: 100 });
    const scroll = vi.fn();
    Object.defineProperty(second, 'scrollIntoView', { configurable: true, value: scroll });

    expect(performBridgeHighlight('.item', doc)).toBe(true);
    expect(first.style.outline).toBe('');
    expect(second.style.outline).toContain('solid');
    // An element already visible is not scrolled.
    expect(scroll).not.toHaveBeenCalled();
  });

  it('uses the snippet to disambiguate several matches', () => {
    const doc = pageWith(
      '<button class="cta" aria-label="First" data-id="1"></button>' +
        '<button class="cta" aria-label="Second" data-id="2"></button>',
    );
    const first = doc.querySelector('[data-id="1"]') as HTMLElement;
    const second = doc.querySelector('[data-id="2"]') as HTMLElement;

    expect(
      performBridgeHighlight(
        'button.cta',
        doc,
        undefined,
        '<button class="cta" aria-label="Second" data-id="2">',
      ),
    ).toBe(true);

    expect(first.style.outline).toBe('');
    expect(second.style.outline).toContain('solid');
  });

  it('finds an element inside an open shadow root', () => {
    const other = new JSDOM('<div id="host"></div>', {
      url: 'https://author.example/content/a.html',
    });
    Object.defineProperty(other.window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    try {
      const doc = other.window.document;
      const host = doc.querySelector('#host') as HTMLElement;
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<div class="bg-wrapper"><img class="bg-image" alt="" /></div>';

      expect(
        performBridgeHighlight(
          '#host > div.bg-wrapper > img.bg-image',
          doc,
          'https://author.example/content/a.html',
        ),
      ).toBe(true);

      const image = shadow.querySelector('.bg-image') as HTMLElement;
      expect(image.style.outline).toContain('solid');
      expect(image.style.getPropertyPriority('outline')).toBe('important');
      // A fixed ring is drawn above the page as well, so a covered element still
      // shows a frame.
      expect(doc.querySelector('[data-daisy-highlight]')).not.toBeNull();
    } finally {
      other.window.close();
    }
  });
});
