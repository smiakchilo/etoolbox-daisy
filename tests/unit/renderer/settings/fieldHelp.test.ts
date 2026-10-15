import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createContextualHelp,
  helpAccessibleName,
  labelledField,
} from '../../../../src/renderer/src/settings/fieldHelp';

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM();
  Reflect.set(globalThis, 'document', dom.window.document);
});

afterEach(() => {
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
});

describe('contextual help badges', () => {
  it('builds a badge whose phrase is its content and whose accessible name is given', () => {
    const badge = createContextualHelp('Where to look for components', 'Help: Component roots');

    expect(badge.textContent).toBe('Where to look for components');
    expect(badge.getAttribute('label')).toBe('Help: Component roots');
    // The badge sits just after the label, so its popover opens rightward.
    expect(badge.getAttribute('placement')).toBe('bottom-start');
    expect(badge.classList.contains('field-help')).toBe(true);
  });

  it('derives the accessible name from the visible label, dropping "(required)"', () => {
    expect(helpAccessibleName('Address (required)')).toBe('Help: Address');
    expect(helpAccessibleName('Content priority paths')).toBe('Help: Content priority paths');
    // Only a trailing marker is dropped; an inner one is part of the name.
    expect(helpAccessibleName('Content (required) roots')).toBe('Help: Content (required) roots');
  });

  it('builds a labelled field: the label row holds the label then the badge, the control follows', () => {
    const control = dom.window.document.createElement('input');
    const field = labelledField('field-id', 'Content roots', control, 'Where to look for pages');

    const row = field.querySelector('.field-label-row');
    expect(row).not.toBeNull();
    expect(row?.querySelector('sp-field-label')?.getAttribute('for')).toBe('field-id');
    expect(row?.querySelector('sp-field-label')?.textContent).toBe('Content roots');
    expect(row?.querySelector('sp-contextual-help')?.textContent).toBe('Where to look for pages');
    // The control is a sibling of the label row, not inside it - the field's
    // `> sp-textfield` width rules depend on that.
    expect(field.lastElementChild).toBe(control);
  });

  it('omits the badge when no help text is given', () => {
    const control = dom.window.document.createElement('input');
    const field = labelledField('field-id', 'User name', control);

    expect(field.querySelector('sp-contextual-help')).toBeNull();
    expect(field.querySelectorAll('.field-label-row sp-field-label')).toHaveLength(1);
    expect(field.lastElementChild).toBe(control);
  });
});
