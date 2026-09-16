import { el } from '../lib/dom';
import type { ServerOption } from './viewModel';

/**
 * The full-size server list that replaces the native `WebContentsView`
 * region while the extended picker is open (requirements-decisions.md
 * section 8). It exists because a Spectrum overlay/dropdown can never paint
 * above the native view Electron composites over the renderer document - so
 * instead of a menu that floats over the page, opening the picker
 * suspends/collapses the native view (`BrowserViewHost.setSuspended`) and lets
 * this panel occupy the pane's whole page-view region.
 *
 * Each option is a real `<button>` addressable in the accessibility tree, but
 * styled as a flat list row (no resting button background - see
 * `.server-picker-item` in shell.css), so the list reads as "one item after
 * another", exactly like a browser's own server/bookmark picker. Clicking or
 * pressing Enter on an item selects it; the header offers a close (cross)
 * button.
 */
export interface ServerPickerPanel {
  readonly element: HTMLElement;
  /** Rebuilds the option rows from a loaded settings snapshot. */
  setServerOptions(options: readonly ServerOption[]): void;
  /** Reveals the panel (it must already be in the DOM, hidden). */
  open(): void;
  /** Hides the panel. */
  close(): void;
  readonly isOpen: boolean;
  dispose(): void;
}

export interface ServerPickerPanelCallbacks {
  /** Fired when an option row is activated (click or Enter). */
  onSelect(origin: string): void;
  /** Fired when the close (cross) button is activated. */
  onClose(): void;
}

export function createServerPickerPanel(callbacks: ServerPickerPanelCallbacks): ServerPickerPanel {
  let open = false;

  const closeButton = el('sp-action-button', {
    attrs: { quiet: '', 'aria-label': 'Close server list', class: 'server-picker-panel__close' },
  });
  const closeIcon = document.createElement('sp-icon-cross500');
  closeIcon.setAttribute('slot', 'icon');
  closeButton.append(closeIcon);

  function handleClose(): void {
    close();
    callbacks.onClose();
  }
  closeButton.addEventListener('click', handleClose);

  const header = el('div', {
    attrs: { class: 'server-picker-panel__header' },
    children: [
      el('span', { attrs: { class: 'server-picker-panel__title' }, text: 'Servers' }),
      closeButton,
    ],
  });

  const list = el('div', {
    attrs: {
      class: 'server-picker-panel__list',
      role: 'listbox',
      'aria-label': 'Configured servers',
    },
  });

  const element = el('div', {
    attrs: { class: 'server-picker-panel', 'data-testid': 'server-picker-panel' },
    children: [header, list],
  });
  element.hidden = true;

  const handleKeydown = (event: KeyboardEvent): void => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      callbacks.onClose();
    }
  };
  document.addEventListener('keydown', handleKeydown, true);

  function buildItem(option: ServerOption): HTMLElement {
    const swatch = el('span', {
      attrs: { class: 'server-swatch server-picker-item__swatch', role: 'presentation' },
    });
    swatch.style.backgroundColor = option.colorCss;
    const label = el('span', {
      attrs: { class: 'server-picker-item__label' },
      text: option.label,
    });
    const origin = el('span', {
      attrs: { class: 'server-picker-item__origin' },
      text: option.origin,
    });
    const item = el('button', {
      attrs: {
        class: 'server-picker-item',
        role: 'option',
        type: 'button',
        'data-origin': option.origin,
      },
      children: [swatch, label, origin],
    });
    item.addEventListener('click', () => {
      close();
      callbacks.onSelect(option.origin);
    });
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        close();
        callbacks.onSelect(option.origin);
      }
    });
    return item;
  }

  function close(): void {
    if (!open) return;
    open = false;
    element.hidden = true;
  }

  return {
    get element() {
      return element;
    },
    get isOpen() {
      return open;
    },
    setServerOptions(options: readonly ServerOption[]): void {
      list.replaceChildren(...options.map(buildItem));
    },
    open(): void {
      if (open) return;
      open = true;
      element.hidden = false;
      const first = list.querySelector<HTMLElement>('.server-picker-item');
      first?.focus();
    },
    close,
    dispose(): void {
      closeButton.removeEventListener('click', handleClose);
      document.removeEventListener('keydown', handleKeydown, true);
    },
  };
}
