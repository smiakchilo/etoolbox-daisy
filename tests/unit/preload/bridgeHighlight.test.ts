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

describe('performBridgeHighlight', () => {
  it('outlines the first match and reports it found', () => {
    const doc = pageWith('<div id="a"></div><div id="b"></div>');

    expect(performBridgeHighlight('#b', doc)).toBe(true);
    const target = doc.querySelector('#b') as HTMLElement;
    expect(target.style.outline).toContain('solid');
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
});
