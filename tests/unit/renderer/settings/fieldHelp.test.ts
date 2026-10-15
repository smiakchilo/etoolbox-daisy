import type { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createContextualHelp,
  helpAccessibleName,
  labelledField,
} from '../../../../src/renderer/src/settings/fieldHelp';
import { installJsdomGlobals } from '../../../support/jsdomGlobals';

let dom: JSDOM;
let restoreGlobals: () => void;

beforeEach(() => {
  ({ dom, restore: restoreGlobals } = installJsdomGlobals({ exposeWindow: false }));
});

afterEach(() => {
  restoreGlobals();
});

describe('contextual help badges', () => {
  it('builds a badge whose phrase is its content and whose accessible name is given', () => {
    const badge = createContextualHelp('Where to look for components', 'Help: Component roots');

    expect(badge.textContent).toBe('Where to look for components');
    expect(badge.getAttribute('label')).toBe('Help: Component roots');
  });

  it('derives the accessible name from the visible label, dropping "(required)"', () => {
    const required = helpAccessibleName('Address (required)');
    expect(required).toContain('Address');
    expect(required).not.toContain('(required)');
    expect(helpAccessibleName('Content priority paths')).toContain('Content priority paths');
    // Only a trailing marker is dropped; an inner one is part of the name.
    expect(helpAccessibleName('Content (required) roots')).toContain('Content (required) roots');
  });

  it('builds a labelled field: the label and the badge come before the control', () => {
    const control = dom.window.document.createElement('input');
    const field = labelledField('field-id', 'Content roots', control, 'Where to look for pages');

    expect(field.querySelector('sp-field-label')?.getAttribute('for')).toBe('field-id');
    expect(field.querySelector('sp-field-label')?.textContent).toBe('Content roots');
    expect(field.querySelector('sp-contextual-help')?.textContent).toBe('Where to look for pages');
    // The control is a direct child of the field, not nested with the label.
    expect(field.lastElementChild).toBe(control);
  });

  it('omits the badge when no help text is given', () => {
    const control = dom.window.document.createElement('input');
    const field = labelledField('field-id', 'User name', control);

    expect(field.querySelector('sp-contextual-help')).toBeNull();
    expect(field.querySelectorAll('sp-field-label')).toHaveLength(1);
    expect(field.lastElementChild).toBe(control);
  });
});
