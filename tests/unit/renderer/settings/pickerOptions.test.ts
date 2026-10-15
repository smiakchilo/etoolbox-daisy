import type { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type PickerLike,
  syncPickerOptions,
} from '../../../../src/renderer/src/settings/pickerOptions';
import { installJsdomGlobals } from '../../../support/jsdomGlobals';

/**
 * The in-place option/selection sync behind every Settings picker.
 *
 * Its whole reason to exist is identity preservation: an `sp-picker` paints its
 * shadow content a frame after insertion, so re-creating one leaves a one-frame
 * blank. These tests assert that an unchanged picker (and each of its
 * `sp-menu-item`s) is *not* replaced, and that only a genuine change replaces
 * anything.
 */

let dom: JSDOM;
let restoreGlobals: () => void;

function picker(): PickerLike {
  return dom.window.document.createElement('sp-picker') as PickerLike;
}

function optionSnapshot(node: PickerLike): readonly (readonly [string | null, string | null])[] {
  return [...node.children].map(
    (child) => [child.getAttribute('value'), child.textContent] as const,
  );
}

beforeEach(() => {
  ({ dom, restore: restoreGlobals } = installJsdomGlobals());
});

afterEach(() => {
  restoreGlobals();
});

describe('syncPickerOptions', () => {
  it('populates the options and the selected value on first use', () => {
    const node = picker();
    syncPickerOptions(
      node,
      [
        { value: '__none__', label: '(Auto)' },
        { value: 'model-a', label: 'Model A' },
      ],
      'model-a',
    );

    expect(optionSnapshot(node)).toEqual([
      ['__none__', '(Auto)'],
      ['model-a', 'Model A'],
    ]);
    expect(node.value).toBe('model-a');
  });

  it('leaves an unchanged picker, and its option nodes, untouched', () => {
    const node = picker();
    const options = [
      { value: '__none__', label: '(Auto)' },
      { value: 'model-a', label: 'Model A' },
    ];
    syncPickerOptions(node, options, 'model-a');
    const optionsBefore = [...node.children];

    syncPickerOptions(node, options, 'model-a');

    // `replaceChildren` would re-create the menu items; a picker re-render is
    // the flicker source, so identity must survive.
    expect([...node.children]).toEqual(optionsBefore);
    for (const [index, child] of optionsBefore.entries()) {
      expect(node.children[index]).toBe(child);
    }
  });

  it('replaces the options when a value or label changes', () => {
    const node = picker();
    syncPickerOptions(node, [{ value: 'model-a', label: 'Model A' }], 'model-a');

    syncPickerOptions(node, [{ value: 'model-a', label: 'Model A (renamed)' }], 'model-a');

    expect(optionSnapshot(node)).toEqual([['model-a', 'Model A (renamed)']]);
  });

  it('assigns a changed selection without touching the option nodes', () => {
    const node = picker();
    const options = [
      { value: 'model-a', label: 'Model A' },
      { value: 'model-b', label: 'Model B' },
    ];
    syncPickerOptions(node, options, 'model-a');
    const optionNodes = [...node.children];

    syncPickerOptions(node, options, 'model-b');

    expect(node.value).toBe('model-b');
    expect([...node.children]).toEqual(optionNodes);
  });
});
