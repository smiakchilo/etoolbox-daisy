import type { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installTextfieldPlaceholderColor } from '../../../src/renderer/src/lib/textfieldPlaceholder';
import { installJsdomGlobals } from '../../support/jsdomGlobals';

let dom: JSDOM;
let restoreGlobals: () => void;

function makeField(): HTMLElement {
  const field = dom.window.document.createElement('sp-textfield');
  field.attachShadow({ mode: 'open' });
  dom.window.document.body.append(field);
  return field;
}

function hasPlaceholderStyle(field: HTMLElement): boolean {
  return field.shadowRoot?.querySelector('style[data-daisy-placeholder]') !== null;
}

async function flushObserver(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  ({ dom, restore: restoreGlobals } = installJsdomGlobals({ windowGlobals: ['MutationObserver'] }));
});

afterEach(() => {
  restoreGlobals();
});

describe('installTextfieldPlaceholderColor', () => {
  it('styles fields that already exist', () => {
    const field = makeField();
    installTextfieldPlaceholderColor();
    expect(hasPlaceholderStyle(field)).toBe(true);
  });

  it('styles fields created later', async () => {
    installTextfieldPlaceholderColor();
    const field = makeField();
    await flushObserver();
    expect(hasPlaceholderStyle(field)).toBe(true);
  });

  it('is idempotent: a field never gets a second style element', async () => {
    const field = makeField();
    installTextfieldPlaceholderColor();
    const extra = makeField();
    await flushObserver();
    installTextfieldPlaceholderColor();
    await flushObserver();
    expect(field.shadowRoot?.querySelectorAll('style[data-daisy-placeholder]').length).toBe(1);
    expect(extra.shadowRoot?.querySelectorAll('style[data-daisy-placeholder]').length).toBe(1);
  });

  it('stops observing after dispose', async () => {
    const dispose = installTextfieldPlaceholderColor();
    dispose();
    const field = makeField();
    await flushObserver();
    expect(hasPlaceholderStyle(field)).toBe(false);
  });
});
