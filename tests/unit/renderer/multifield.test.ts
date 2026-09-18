import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMultifield } from '../../../src/renderer/src/lib/multifield';

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;
let dom: JSDOM;

function field(text: string): HTMLElement {
  const node = dom.window.document.createElement('div');
  node.className = 'field';
  node.textContent = text;
  return node;
}

function keysOf(multifield: ReturnType<typeof createMultifield>): readonly string[] {
  return multifield.keys();
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

describe('createMultifield', () => {
  it('renders the add button with the requested label and an add icon', () => {
    const onAdd = vi.fn();
    const multifield = createMultifield({
      addLabel: 'Add item',
      onAdd,
      onMove: vi.fn(),
      onRemove: vi.fn(),
    });
    const addButton = multifield.element.querySelector('.multifield__add');
    expect(addButton).not.toBeNull();
    expect(addButton?.tagName.toLowerCase()).toBe('sp-action-button');
    expect(addButton?.hasAttribute('quiet')).toBe(false);
    expect(addButton?.textContent).toBe('Add item');
    expect(addButton?.querySelector('sp-icon-add')).not.toBeNull();

    addButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('appends items in order and reports them in visual order', () => {
    const multifield = createMultifield({
      addLabel: 'Add item',
      onAdd: vi.fn(),
      onMove: vi.fn(),
      onRemove: vi.fn(),
    });
    multifield.append({ key: 'a', element: field('A') });
    multifield.append({ key: 'b', element: field('B') });
    multifield.append({ key: 'c', element: field('C') });

    expect(keysOf(multifield)).toEqual(['a', 'b', 'c']);
    expect(multifield.itemCount()).toBe(3);
    expect(multifield.hasKey('b')).toBe(true);
    expect(multifield.hasKey('z')).toBe(false);
  });

  it('disables up on the first row and down on the last', () => {
    const multifield = createMultifield({
      addLabel: 'Add item',
      onAdd: vi.fn(),
      onMove: vi.fn(),
      onRemove: vi.fn(),
    });
    multifield.append({ key: 'a', element: field('A') });
    multifield.append({ key: 'b', element: field('B') });
    multifield.append({ key: 'c', element: field('C') });

    const rowFor = (key: string): HTMLElement => {
      const node = multifield.element.querySelector<HTMLElement>(`[data-key="${key}"]`);
      if (!node) throw new Error(`missing row ${key}`);
      return node;
    };
    const isDisabled = (node: Element | null): boolean => node?.hasAttribute('disabled') ?? false;

    expect(isDisabled(rowFor('a').querySelector('.multifield__action--up'))).toBe(true);
    expect(isDisabled(rowFor('a').querySelector('.multifield__action--down'))).toBe(false);
    expect(isDisabled(rowFor('c').querySelector('.multifield__action--up'))).toBe(false);
    expect(isDisabled(rowFor('c').querySelector('.multifield__action--down'))).toBe(true);
  });

  it('moves a row down, reorders the DOM, and reports the new index', () => {
    const onMove = vi.fn();
    const multifield = createMultifield({
      addLabel: 'Add item',
      onAdd: vi.fn(),
      onMove,
      onRemove: vi.fn(),
    });
    multifield.append({ key: 'a', element: field('A') });
    multifield.append({ key: 'b', element: field('B') });

    const down = multifield.element.querySelector<HTMLElement>(
      '[data-key="a"] .multifield__action--down',
    );
    down?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    expect(keysOf(multifield)).toEqual(['b', 'a']);
    expect(onMove).toHaveBeenCalledExactlyOnceWith('a', 1);
  });

  it('recomputes the up/down bounds against the new DOM order after a move', () => {
    const multifield = createMultifield({
      addLabel: 'Add item',
      onAdd: vi.fn(),
      onMove: vi.fn(),
      onRemove: vi.fn(),
    });
    multifield.append({ key: 'a', element: field('A') });
    multifield.append({ key: 'b', element: field('B') });
    multifield.append({ key: 'c', element: field('C') });

    const rowFor = (key: string): HTMLElement => {
      const node = multifield.element.querySelector<HTMLElement>(`[data-key="${key}"]`);
      if (!node) throw new Error(`missing row ${key}`);
      return node;
    };
    const isDisabled = (node: Element | null): boolean => node?.hasAttribute('disabled') ?? false;
    const upOf = (key: string): boolean =>
      isDisabled(rowFor(key).querySelector('.multifield__action--up'));
    const downOf = (key: string): boolean =>
      isDisabled(rowFor(key).querySelector('.multifield__action--down'));

    // Move the first row down to the middle: [b, a, c].
    rowFor('a')
      .querySelector('.multifield__action--down')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(keysOf(multifield)).toEqual(['b', 'a', 'c']);
    expect(upOf('b')).toBe(true);
    expect(downOf('b')).toBe(false);
    expect(upOf('a')).toBe(false);
    expect(downOf('a')).toBe(false);
    expect(upOf('c')).toBe(false);
    expect(downOf('c')).toBe(true);

    // Move it back to the top: [a, b, c] - up must disable again.
    rowFor('a')
      .querySelector('.multifield__action--up')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(keysOf(multifield)).toEqual(['a', 'b', 'c']);
    expect(upOf('a')).toBe(true);
    expect(downOf('c')).toBe(true);
  });

  it('does not move a row past either end', () => {
    const onMove = vi.fn();
    const multifield = createMultifield({
      addLabel: 'Add item',
      onAdd: vi.fn(),
      onMove,
      onRemove: vi.fn(),
    });
    multifield.append({ key: 'a', element: field('A') });
    multifield.append({ key: 'b', element: field('B') });

    multifield.move('a', -1);
    multifield.move('b', 1);

    expect(keysOf(multifield)).toEqual(['a', 'b']);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('asks the caller on remove without removing the row itself', () => {
    const onRemove = vi.fn();
    const multifield = createMultifield({
      addLabel: 'Add item',
      onAdd: vi.fn(),
      onMove: vi.fn(),
      onRemove,
    });
    multifield.append({ key: 'a', element: field('A') });
    multifield.append({ key: 'b', element: field('B') });

    multifield.element
      .querySelector<HTMLElement>('[data-key="a"] .multifield__action--remove')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    expect(onRemove).toHaveBeenCalledExactlyOnceWith('a');
    // Still present: removal waits for the caller (it may need a confirmation).
    expect(keysOf(multifield)).toEqual(['a', 'b']);

    multifield.remove('a');
    expect(keysOf(multifield)).toEqual(['b']);
  });

  it('keeps the caller-owned field element on a move (the same node, not a copy)', () => {
    const multifield = createMultifield({
      addLabel: 'Add item',
      onAdd: vi.fn(),
      onMove: vi.fn(),
      onRemove: vi.fn(),
    });
    const elementA = field('A');
    multifield.append({ key: 'a', element: elementA });
    multifield.append({ key: 'b', element: field('B') });

    multifield.move('a', 1);

    expect(keysOf(multifield)).toEqual(['b', 'a']);
    expect(multifield.element.querySelector('[data-key="a"] .field')).toBe(elementA);
  });

  it('restores focus to an element inside the moved row', () => {
    const multifield = createMultifield({
      addLabel: 'Add item',
      onAdd: vi.fn(),
      onMove: vi.fn(),
      onRemove: vi.fn(),
    });
    const content = dom.window.document.createElement('div');
    const input = dom.window.document.createElement('input');
    content.append(input);
    multifield.append({ key: 'a', element: content });
    multifield.append({ key: 'b', element: field('B') });
    dom.window.document.body.append(multifield.element);

    input.focus();
    expect(dom.window.document.activeElement).toBe(input);

    multifield.move('a', 1);
    expect(keysOf(multifield)).toEqual(['b', 'a']);
    expect(dom.window.document.activeElement).toBe(input);
  });

  it('restores focus to the remembered field, not the clicked button', () => {
    const multifield = createMultifield({
      addLabel: 'Add item',
      onAdd: vi.fn(),
      onMove: vi.fn(),
      onRemove: vi.fn(),
    });
    const content = dom.window.document.createElement('div');
    const input = dom.window.document.createElement('input');
    content.append(input);
    multifield.append({ key: 'a', element: content });
    multifield.append({ key: 'b', element: field('B') });
    dom.window.document.body.append(multifield.element);

    // Focus the field (and let the component observe it), then lose focus to
    // the button click, exactly as the browser would.
    input.focus();
    input.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }));
    input.blur();
    expect(dom.window.document.activeElement).not.toBe(input);

    multifield.move('a', 1);
    expect(dom.window.document.activeElement).toBe(input);
  });

  it('preserves the caret position of the moved field', () => {
    const multifield = createMultifield({
      addLabel: 'Add item',
      onAdd: vi.fn(),
      onMove: vi.fn(),
      onRemove: vi.fn(),
    });
    const content = dom.window.document.createElement('div');
    const input = dom.window.document.createElement('input');
    input.value = 'https://author.example';
    content.append(input);
    multifield.append({ key: 'a', element: content });
    multifield.append({ key: 'b', element: field('B') });
    dom.window.document.body.append(multifield.element);

    input.focus();
    input.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }));
    input.setSelectionRange(4, 4);
    input.blur();

    multifield.move('a', 1);
    expect(dom.window.document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(4);
    expect(input.selectionEnd).toBe(4);
  });

  it("forces focus into the moved item's first available field when none was focused", () => {
    const multifield = createMultifield({
      addLabel: 'Add item',
      onAdd: vi.fn(),
      onMove: vi.fn(),
      onRemove: vi.fn(),
    });
    const first = dom.window.document.createElement('input');
    const second = dom.window.document.createElement('input');
    multifield.append({ key: 'a', element: first });
    multifield.append({ key: 'b', element: second });
    dom.window.document.body.append(multifield.element);

    // Nothing was focused before the move.
    expect(dom.window.document.activeElement).not.toBe(first);

    multifield.move('a', 1);
    expect(keysOf(multifield)).toEqual(['b', 'a']);
    expect(dom.window.document.activeElement).toBe(first);
  });

  it('clears every row', () => {
    const multifield = createMultifield({
      addLabel: 'Add item',
      onAdd: vi.fn(),
      onMove: vi.fn(),
      onRemove: vi.fn(),
    });
    multifield.append({ key: 'a', element: field('A') });
    multifield.append({ key: 'b', element: field('B') });
    multifield.clear();
    expect(multifield.itemCount()).toBe(0);
    expect(keysOf(multifield)).toEqual([]);
  });
});
