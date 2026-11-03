import type { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_TYPE_DEFAULT_VALUE,
  createHostTypePicker,
} from '../../../../src/renderer/src/settings/hostTypePicker';
import { installJsdomGlobals } from '../../../support/jsdomGlobals';

let dom: JSDOM;
let restoreGlobals: () => void;

function pickerOf(handle: { element: HTMLElement }): HTMLElement & { value: string } {
  return handle.element as HTMLElement & { value: string };
}

function menuLabels(picker: HTMLElement): string[] {
  return [...picker.querySelectorAll('sp-menu-item')].map((item) => item.textContent ?? '');
}

function menuValues(picker: HTMLElement): string[] {
  return [...picker.querySelectorAll('sp-menu-item')].map(
    (item) => item.getAttribute('value') ?? '',
  );
}

function choose(picker: HTMLElement & { value: string }, value: string): void {
  picker.value = value;
  picker.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

beforeEach(() => {
  ({ dom, restore: restoreGlobals } = installJsdomGlobals());
});

afterEach(() => {
  restoreGlobals();
});

describe('createHostTypePicker', () => {
  it('offers "(Default)" then the closed list of host roles, selecting "(Default)" when none is stored', () => {
    const handle = createHostTypePicker({
      fieldId: 'type',
      initial: undefined,
      onChange: () => undefined,
    });

    expect(menuLabels(handle.element)).toEqual(['(Default)', 'Author', 'Publish']);
    expect(menuValues(handle.element)).toEqual([HOST_TYPE_DEFAULT_VALUE, 'author', 'publish']);
    expect(pickerOf(handle).value).toBe(HOST_TYPE_DEFAULT_VALUE);
    expect(handle.read()).toBeUndefined();
  });

  it('selects the stored role', () => {
    const handle = createHostTypePicker({
      fieldId: 'type',
      initial: 'publish',
      onChange: () => undefined,
    });

    expect(pickerOf(handle).value).toBe('publish');
    expect(handle.read()).toBe('publish');
  });

  it('reads a change as the role and fires onChange', () => {
    const onChange = vi.fn();
    const handle = createHostTypePicker({
      fieldId: 'type',
      initial: undefined,
      onChange,
    });

    choose(pickerOf(handle), 'author');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(handle.read()).toBe('author');

    choose(pickerOf(handle), HOST_TYPE_DEFAULT_VALUE);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(handle.read()).toBeUndefined();
  });

  it('sets the selection from stored state', () => {
    const handle = createHostTypePicker({
      fieldId: 'type',
      initial: 'author',
      onChange: () => undefined,
    });

    handle.select(undefined);
    expect(pickerOf(handle).value).toBe(HOST_TYPE_DEFAULT_VALUE);

    handle.select('publish');
    expect(pickerOf(handle).value).toBe('publish');
  });
});
