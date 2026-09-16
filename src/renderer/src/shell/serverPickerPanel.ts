import { el } from '../lib/dom';
import { createPanel } from './panel';
import type { ServerOption } from './viewModel';

/**
 * The full-size server list that replaces the native `WebContentsView`
 * region while the extended picker is open (requirements-decisions.md
 * section 8). It is a concrete case of the shared whole-size panel scaffold
 * (`panel.ts`): a Spectrum overlay/dropdown can never paint above the native
 * view Electron composites over the renderer document, so instead of a menu
 * that floats over the page, opening the picker suspends/collapses the native
 * view (`BrowserViewHost.setSuspended`, via the browser pane's panel host)
 * and lets this panel occupy the pane's whole page-view region.
 *
 * Each option is a real `<button>` addressable in the accessibility tree, but
 * styled as a flat list row (no resting button background - see
 * `.server-picker-item` in browser.css), so the list reads as "one item after
 * another", exactly like a browser's own server/bookmark picker. Clicking or
 * pressing Enter on an item selects it; the header offers a close (cross)
 * button and Escape dismisses. The `server-picker-panel*` class names are
 * kept as aliases on the shared scaffold's elements so existing selectors
 * (unit and E2E) keep resolving.
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
  /** Fired when the close (cross) button or Escape dismisses the panel. */
  onClose(): void;
}

export function createServerPickerPanel(callbacks: ServerPickerPanelCallbacks): ServerPickerPanel {
  const list = el('div', {
    attrs: {
      class: 'server-picker-panel__list',
      role: 'listbox',
      'aria-label': 'Configured servers',
    },
  });

  const panel = createPanel({
    title: 'Servers',
    closeAriaLabel: 'Close server list',
    surfaceClassName: 'server-picker-panel',
    closeButtonClassName: 'server-picker-panel__close',
    autofocusSelector: '.server-picker-item',
    content: list,
    onDismiss(): void {
      callbacks.onClose();
    },
  });

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
      panel.close();
      callbacks.onSelect(option.origin);
    });
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        panel.close();
        callbacks.onSelect(option.origin);
      }
    });
    return item;
  }

  function setServerOptions(options: readonly ServerOption[]): void {
    list.replaceChildren(...options.map(buildItem));
  }

  return {
    get element() {
      return panel.element;
    },
    setServerOptions,
    open: () => panel.open(),
    close: () => panel.close(),
    get isOpen() {
      return panel.isOpen;
    },
    dispose: () => panel.dispose(),
  };
}
