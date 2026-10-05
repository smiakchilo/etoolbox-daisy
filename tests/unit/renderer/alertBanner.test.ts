import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BANNER_ROW_ACTIONS_CLASS,
  BANNER_ROW_COPY_CLASS,
  BANNER_ROW_PROMPT_CLASS,
  buildBannerCopy,
  buildBannerPrompt,
  createBannerActionButton,
} from '../../../src/renderer/src/lib/alertBanner';

/**
 * The shared banner-row builders (lib/alertBanner.ts). These are pure DOM
 * composition, so jsdom can pin the *structure* that carries the layout -
 * notably that a prompt's copy and actions are grouped in the
 * `.banner-row__prompt` flex row (banner.css) instead of being left as inline
 * siblings, which is what used to push a wrapped message's actions onto a new,
 * indented line. The actual geometry (actions bottom-aligned with the copy's
 * last line) is proven against the built app in the Step 05 E2E, because jsdom
 * does not lay out.
 */

let dom: JSDOM;

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;

beforeEach(() => {
  dom = new JSDOM();
  Reflect.set(globalThis, 'document', dom.window.document);
  Reflect.set(globalThis, 'window', dom.window);
});

afterEach(() => {
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
  Reflect.set(globalThis, 'window', previousWindow);
});

describe('buildBannerPrompt', () => {
  it('groups the copy and the actions in one prompt flex row, in order', () => {
    const button = createBannerActionButton('Reload');
    const [wrapper] = buildBannerPrompt('Timed out. Check the address', [button]);

    expect(wrapper).toBeInstanceOf(dom.window.HTMLElement);
    expect(wrapper?.classList.contains(BANNER_ROW_PROMPT_CLASS)).toBe(true);
    // Exactly the two columns: copy then actions, no stray siblings.
    expect(wrapper?.children).toHaveLength(2);
    expect(wrapper?.children[0]?.classList.contains(BANNER_ROW_COPY_CLASS)).toBe(true);
    expect(wrapper?.children[0]?.textContent).toBe('Timed out. Check the address');
    expect(wrapper?.children[1]?.classList.contains(BANNER_ROW_ACTIONS_CLASS)).toBe(true);
    expect(wrapper?.querySelector('sp-action-button')).toBe(button);
  });
});

describe('buildBannerCopy', () => {
  it('returns a bare copy span (no prompt row), keeping inline parts in order', () => {
    const button = createBannerActionButton('Settings');
    const span = buildBannerCopy(['Activate an agent in ', button, ' to send messages']);

    expect(span.classList.contains(BANNER_ROW_COPY_CLASS)).toBe(true);
    expect(span.classList.contains(BANNER_ROW_PROMPT_CLASS)).toBe(false);
    expect(span.textContent).toBe('Activate an agent in Settings to send messages');
    expect(span.querySelector('sp-action-button')).toBe(button);
  });
});
