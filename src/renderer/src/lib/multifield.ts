import { el } from './dom';

/**
 * A reusable, ordered "multifield" list (the Settings "Hosts" tab is its first
 * consumer; it is written to be reused, e.g. for the proxy section later).
 *
 * The component owns only the *structure* of the list: one row per item, the
 * up/down/remove action buttons in each row's top-right corner, and the
 * "Add item" button underneath. What each row *contains* is supplied by the
 * caller as an arbitrary element - the "slot" - which this component moves,
 * never rebuilds. That distinction matters for reordering: moving a row swaps
 * the caller's live field elements (with their focus, selection and local
 * state) between positions instead of re-rendering them from scratch.
 *
 * It is deliberately unaware of the caller's domain: it never validates,
 * saves, or confirms anything. The three callbacks let the caller decide what
 * "add", "move" and "remove" mean. Removal is callback-only (the row is *not*
 * removed until the caller calls {@link Multifield.remove}), so a caller that
 * needs a confirmation can arm it and remove the row only once the user
 * confirms - exactly what the hosts section does for a saved host.
 */
export interface MultifieldItemContent {
  /** Stable identity for the item across moves; unique within one list. */
  readonly key: string;
  /**
   * The item's field block - the caller's "slot". The same node instance is
   * moved between positions; the component never clones or re-creates it.
   */
  readonly element: HTMLElement;
}

export interface MultifieldOptions {
  /** Visible text of the "Add item" button. */
  readonly addLabel: string;
  /** "Add item" was clicked. The caller creates the draft and calls {@link Multifield.append}. */
  readonly onAdd: () => void;
  /**
   * An item was moved by its up/down button. The DOM has already been
   * reordered when this fires; `index` is the item's new zero-based position.
   */
  readonly onMove: (key: string, index: number) => void;
  /** An item's remove button was clicked. The component does not remove the row; the caller decides. */
  readonly onRemove: (key: string) => void;
}

export interface Multifield {
  readonly element: HTMLElement;
  /** Appends an item at the end of the list. */
  append(item: MultifieldItemContent): void;
  /** Removes an item's row. No-op for an unknown key. */
  remove(key: string): void;
  /** Moves an item one position up (-1) or down (+1). No-op at the ends. */
  move(key: string, delta: -1 | 1): void;
  /** Removes every item. */
  clear(): void;
  /** The item keys, in visual order. */
  keys(): readonly string[];
  hasKey(key: string): boolean;
  itemCount(): number;
  dispose(): void;
}

interface Entry {
  readonly key: string;
  readonly row: HTMLLIElement;
  /** The caller's field block (the "slot"), used to locate its first field. */
  readonly element: HTMLElement;
  readonly upButton: HTMLElement;
  readonly downButton: HTMLElement;
  readonly removeButton: HTMLElement;
  /**
   * The last field inside this row that held focus. Tracked because a click on
   * an up/down button moves focus to that *button* before {@link move} runs, so
   * `document.activeElement` at move time is no longer the field the user was
   * editing.
   */
  lastFocused: HTMLElement | undefined;
}

/**
 * Focus events retarget to the host of a shadow tree, so a focused Spectrum
 * textfield reports its `<sp-textfield>` host as the target. Only such field
 * hosts are tracked: the colour picker's menu button also lives inside the
 * fields slot, and it must not become the remembered "current field".
 */
const FIELD_SELECTOR = 'sp-textfield, input, textarea, select';

function isTrackableField(target: EventTarget | null): boolean {
  const element = target as Element | null;
  return (
    element !== null && typeof element.matches === 'function' && element.matches(FIELD_SELECTOR)
  );
}

/**
 * The first focusable field in an item's slot, in DOM order. The slot element
 * itself counts if it is the field (a caller may pass the field directly
 * rather than a wrapper containing it).
 */
function firstFieldWithin(root: HTMLElement): HTMLElement | undefined {
  if (typeof root.matches === 'function' && root.matches(FIELD_SELECTOR)) return root;
  const found = root.querySelector(FIELD_SELECTOR);
  return found === null ? undefined : (found as HTMLElement);
}

/** The subset of a native input (or Spectrum's inner `focusElement`) needed to preserve a caret. */
interface SelectableElement {
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  setSelectionRange(start: number, end: number): void;
}

/**
 * Resolves the element that actually owns a text selection: a raw
 * `input`/`textarea`, or - for Spectrum's textfield - its shadow
 * `focusElement`. Duck-typed rather than `instanceof` so it also holds under
 * jsdom, where the component is not upgraded.
 */
function selectableOf(element: HTMLElement | undefined): SelectableElement | undefined {
  if (element === undefined) return undefined;
  const candidates: unknown[] = [(element as { focusElement?: unknown }).focusElement, element];
  for (const candidate of candidates) {
    if (
      candidate !== null &&
      typeof candidate === 'object' &&
      typeof (candidate as SelectableElement).setSelectionRange === 'function'
    ) {
      return candidate as SelectableElement;
    }
  }
  return undefined;
}

function readSelection(
  element: HTMLElement | undefined,
): { readonly start: number; readonly end: number } | undefined {
  const target = selectableOf(element);
  if (target === undefined) return undefined;
  const start = target.selectionStart;
  const end = target.selectionEnd;
  if (typeof start !== 'number' || typeof end !== 'number') return undefined;
  return { start, end };
}

function restoreSelection(
  element: HTMLElement,
  selection: { readonly start: number; readonly end: number } | undefined,
): void {
  if (selection === undefined) return;
  const target = selectableOf(element);
  if (target === undefined) return;
  try {
    target.setSelectionRange(selection.start, selection.end);
  } catch {
    // Some input types (e.g. number/email) reject an explicit selection range;
    // focus is still restored, which is the important part.
  }
}

function setDisabled(node: HTMLElement, disabled: boolean): void {
  if (disabled) node.setAttribute('disabled', '');
  else node.removeAttribute('disabled');
}

function buildActionButton(iconTag: string, label: string, className: string): HTMLElement {
  const button = el('sp-action-button', {
    attrs: { quiet: '', label, class: className },
  });
  const icon = document.createElement(iconTag);
  icon.setAttribute('slot', 'icon');
  button.append(icon);
  return button;
}

export function createMultifield(options: MultifieldOptions): Multifield {
  // `.subsection-gap` widens the gap between items (see settings.css), so each
  // item reads as its own subsection rather than as another field of the one above.
  const list = el('ul', { attrs: { class: 'multifield__list subsection-gap' } });
  const entries = new Map<string, Entry>();
  let disposed = false;

  // An `sp-action-button` (not `sp-button`): the "Add item" affordance is the
  // same class of control as the item actions above it. Non-quiet, with an
  // icon and visible text.
  const addButton = el('sp-action-button', { attrs: { class: 'multifield__add' } });
  const addIcon = document.createElement('sp-icon-add');
  addIcon.setAttribute('slot', 'icon');
  addButton.append(addIcon, document.createTextNode(options.addLabel));
  addButton.addEventListener('click', () => {
    if (!disposed) options.onAdd();
  });

  /**
   * Up is disabled on the first row and down on the last, so the buttons can be
   * pressed without a dead click; a single-row list has both disabled.
   *
   * Reads the *DOM* order, not the `entries` Map's insertion order:
   * `move` reorders nodes and leaves the Map untouched, so iterating it here
   * would compute every bound against the pre-move order and leave the moved
   * row with the wrong buttons enabled.
   */
  function syncBounds(): void {
    const rows = [...list.children];
    const count = rows.length;
    rows.forEach((row, index) => {
      const key = (row as HTMLElement).dataset.key;
      const entry = key === undefined ? undefined : entries.get(key);
      if (!entry) return;
      setDisabled(entry.upButton, index === 0);
      setDisabled(entry.downButton, index === count - 1);
    });
  }

  function append(item: MultifieldItemContent): void {
    if (disposed || entries.has(item.key)) return;

    const upButton = buildActionButton(
      'sp-icon-chevron-up',
      'Move item up',
      'multifield__action multifield__action--up',
    );
    const downButton = buildActionButton(
      'sp-icon-chevron-down',
      'Move item down',
      'multifield__action multifield__action--down',
    );
    const removeButton = buildActionButton(
      'sp-icon-delete-outline',
      'Remove item',
      'multifield__action multifield__action--remove',
    );
    // Test hook (additive, behaviour-free): a spec locates the row's remove
    // control by id, scoped to its `.multifield__item` row.
    removeButton.setAttribute('data-testid', 'multifield-remove');

    upButton.addEventListener('click', () => move(item.key, -1));
    downButton.addEventListener('click', () => move(item.key, 1));
    removeButton.addEventListener('click', () => options.onRemove(item.key));

    const actions = el('div', {
      attrs: { class: 'multifield__item-actions' },
      children: [upButton, downButton, removeButton],
    });
    const fields = el('div', {
      attrs: { class: 'multifield__fields' },
      children: [item.element],
    });
    // Fields left, action gutter right (the CSS is a two-column grid).
    const row = el('li', {
      attrs: { class: 'multifield__item', 'data-key': item.key },
      children: [fields, actions],
    });

    const entry: Entry = {
      key: item.key,
      row,
      element: item.element,
      upButton,
      downButton,
      removeButton,
      lastFocused: undefined,
    };
    // Remember the last field the user focused in this row. This is what makes
    // post-move focus restoration hit the field rather than the clicked button.
    //
    // Both `focusin` (bubbling) and `focus` (capture; the only composed focus
    // event guaranteed across a shadow boundary) are bound, because Spectrum's
    // textfields focus an input inside their shadow root and only the composed
    // path reliably reaches this light-DOM ancestor.
    const rememberFocus = (event: Event): void => {
      if (!isTrackableField(event.target)) return;
      entry.lastFocused = event.target as HTMLElement;
    };
    fields.addEventListener('focusin', rememberFocus);
    fields.addEventListener('focus', rememberFocus, true);
    entries.set(item.key, entry);
    list.append(row);
    syncBounds();
  }

  function remove(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    entry.row.remove();
    entries.delete(key);
    syncBounds();
  }

  function move(key: string, delta: -1 | 1): void {
    const entry = entries.get(key);
    if (!entry) return;
    const rows = [...list.children];
    const current = rows.indexOf(entry.row);
    const target = current + delta;
    if (current < 0 || target < 0 || target >= rows.length) return;
    const targetRow = rows[target];
    if (!targetRow) return;

    // Re-inserting a node detaches and re-adds it, which drops focus - and a
    // click on an up/down button had already moved focus to that button. The
    // moved item is therefore *forcedly* re-focused: the field the user was
    // last editing in this row when it is still available, otherwise the item's
    // first available field. The clicked up/down button is never the target:
    // the user's context is a field.
    const active = document.activeElement;
    const activeField =
      active !== null && entry.row.contains(active) && isTrackableField(active)
        ? (active as HTMLElement)
        : undefined;
    const remembered =
      entry.lastFocused !== undefined && entry.row.contains(entry.lastFocused)
        ? entry.lastFocused
        : undefined;
    const focusTarget = remembered ?? activeField ?? firstFieldWithin(entry.element);
    const selection = readSelection(focusTarget);

    if (delta === -1) list.insertBefore(entry.row, targetRow);
    else list.insertBefore(entry.row, targetRow.nextSibling);
    syncBounds();

    if (focusTarget !== undefined) {
      focusTarget.focus();
      restoreSelection(focusTarget, selection);
    }
    // Keep the moved row "current" for the user: bring it back into view when
    // the list is long enough to scroll.
    entry.row.scrollIntoView?.({ block: 'nearest' });
    options.onMove(key, target);
  }

  const element = el('div', {
    attrs: { class: 'multifield' },
    children: [list, el('div', { attrs: { class: 'multifield__footer' }, children: [addButton] })],
  });

  return {
    element,
    append,
    remove,
    move,
    clear(): void {
      list.replaceChildren();
      entries.clear();
    },
    // Read from the DOM, not from the Map's insertion order: `move` reorders
    // nodes, which leaves the Map untouched, so iteration order would go stale.
    keys: () =>
      [...list.children]
        .map((row) => (row as HTMLElement).dataset.key)
        .filter((key): key is string => key !== undefined),
    hasKey: (key) => entries.has(key),
    itemCount: () => entries.size,
    dispose(): void {
      disposed = true;
      entries.clear();
    },
  };
}
