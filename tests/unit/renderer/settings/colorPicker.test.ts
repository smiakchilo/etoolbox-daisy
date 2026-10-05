import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createColorPicker } from '../../../../src/renderer/src/settings/colorPicker';

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;
let dom: JSDOM;

function field(picker: ReturnType<typeof createColorPicker>) {
  return picker.element.querySelector<HTMLElement & { value: string }>('[aria-label="Color tag"]');
}

function preview(picker: ReturnType<typeof createColorPicker>) {
  return picker.element.querySelector<HTMLElement>('.color-picker__preview');
}

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

describe('createColorPicker', () => {
  it('shows a preview dot matching the initial colour', () => {
    const picker = createColorPicker({ fieldId: 'c', initial: { kind: 'swatch', swatch: 'blue' } });
    expect(preview(picker)?.style.backgroundColor).toBe('rgb(38, 128, 235)');
  });

  it('updates the preview as the field value changes', () => {
    const picker = createColorPicker({ fieldId: 'c', initial: { kind: 'swatch', swatch: 'blue' } });
    const input = field(picker);
    if (!input) throw new Error('missing colour field');

    input.value = '#9256d9';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(preview(picker)?.style.backgroundColor).toBe('rgb(146, 86, 217)');

    // A bare swatch name is understood too.
    input.value = 'red';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(preview(picker)?.style.backgroundColor).toBe('rgb(227, 72, 80)');
  });

  it('updates the preview on setValue and clears it for an invalid value', () => {
    const picker = createColorPicker({ fieldId: 'c', initial: { kind: 'swatch', swatch: 'blue' } });
    picker.setValue({ kind: 'custom', hex: '#123abc' });
    expect(preview(picker)?.style.backgroundColor).toBe('rgb(18, 58, 188)');

    const input = field(picker);
    if (!input) throw new Error('missing colour field');
    input.value = 'not-a-colour';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(preview(picker)?.style.backgroundColor).toBe('transparent');
  });

  it('reports typed input separately from a commit, and commits a menu pick', () => {
    const onInput = vi.fn();
    const onCommit = vi.fn();
    const picker = createColorPicker({
      fieldId: 'c',
      initial: { kind: 'swatch', swatch: 'blue' },
      onInput,
      onCommit,
    });
    const input = field(picker);
    if (!input) throw new Error('missing colour field');

    // Typing validates but does not commit.
    input.value = '#9256d9';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();

    // Leaving the field commits.
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(onCommit).toHaveBeenCalledTimes(1);

    // Picking a swatch from the menu is a deliberate commit too.
    const menu = picker.element.querySelector<HTMLElement & { value: string }>(
      '.color-picker-button',
    );
    if (!menu) throw new Error('missing colour menu');
    menu.value = 'purple';
    menu.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it('renders the inline invalid state via setError', () => {
    const picker = createColorPicker({ fieldId: 'c', initial: { kind: 'swatch', swatch: 'blue' } });
    const input = field(picker);
    if (!input) throw new Error('missing colour field');

    picker.setError('must be a valid colour');
    expect(input.hasAttribute('invalid')).toBe(true);
    expect(input.querySelector('[slot="negative-help-text"]')?.textContent).toBe(
      'must be a valid colour',
    );

    picker.setError(undefined);
    expect(input.hasAttribute('invalid')).toBe(false);
  });
});
