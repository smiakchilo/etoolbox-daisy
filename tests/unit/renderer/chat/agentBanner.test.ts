import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentBanner } from '../../../../src/renderer/src/chat/agentBanner';

/**
 * The chat pane's standing "no usable agent" row. It must reuse the shared
 * `banner-row` factory/base (`lib/alertBanner.ts`, `banner.css`) while owning
 * its own `chat-banner` surface class - the class split is what keeps
 * Playwright strict-mode locators from matching more than one banner.
 *
 * `agentBanner.ts` builds its DOM through `lib/dom.ts`'s `el()` (ambient
 * `document`), so a jsdom document is installed for the suite, exactly as
 * `composer.test.ts` does.
 */
let dom: JSDOM;

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;

beforeEach(() => {
  dom = new JSDOM();
  // `lib/alertBanner.ts`'s `prefersReducedMotion` reads `window.matchMedia`,
  // so both globals must be installed (exactly as `statusBanner.test.ts` does).
  Reflect.set(globalThis, 'document', dom.window.document);
  Reflect.set(globalThis, 'window', dom.window);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
  Reflect.set(globalThis, 'window', previousWindow);
});

function query(root: HTMLElement, selector: string): HTMLElement {
  const found = root.querySelector(selector);
  if (found === null) throw new Error(`expected to find "${selector}"`);
  return found as HTMLElement;
}

describe('createAgentBanner', () => {
  it('builds a shared banner row with its own surface class and the agent copy', () => {
    const banner = createAgentBanner({ onOpenSettings: vi.fn() });

    expect(banner.element.classList.contains('banner-row')).toBe(true);
    expect(banner.element.classList.contains('chat-banner')).toBe(true);
    // A standing condition, not a dismissible error.
    expect(banner.element.hasAttribute('dismissible')).toBe(false);
    expect(banner.element.textContent).toContain('Activate an agent in');
    expect(banner.element.textContent).toContain('to send messages');
  });

  it('starts hidden and follows setVisible without rebuilding its content', () => {
    const banner = createAgentBanner({ onOpenSettings: vi.fn() });
    expect(banner.element.hasAttribute('open')).toBe(false);

    banner.setVisible(true);
    expect(banner.element.hasAttribute('open')).toBe(true);
    const copy = banner.element.textContent;

    banner.setVisible(false);
    vi.advanceTimersByTime(1000);
    expect(banner.element.hasAttribute('open')).toBe(false);
    // The copy survives the hide: showing it again reuses the same nodes.
    expect(banner.element.textContent).toBe(copy);

    banner.setVisible(true);
    expect(banner.element.hasAttribute('open')).toBe(true);
  });

  it('does not reopen while already visible (setVisible is idempotent)', () => {
    const banner = createAgentBanner({ onOpenSettings: vi.fn() });
    banner.setVisible(true);
    banner.setVisible(true);
    expect(banner.element.hasAttribute('open')).toBe(true);
  });

  it('wires the inline Settings control to onOpenSettings', () => {
    const onOpenSettings = vi.fn();
    const banner = createAgentBanner({ onOpenSettings });
    banner.setVisible(true);

    const button = query(banner.element, 'sp-action-button');
    expect(button.textContent).toBe('Settings');
    // Banner actions are always size "s" (createBannerActionButton).
    expect(button.getAttribute('size')).toBe('s');
    button.click();

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
