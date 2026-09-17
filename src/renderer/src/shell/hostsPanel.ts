import { el } from '../lib/dom';
import { createPanel } from './panel';
import type { HostOption } from './viewModel';

/**
 * The full-size hosts list that replaces the native `WebContentsView`
 * region while the extended panel is open (requirements-decisions.md
 * section 8). It is a concrete case of the shared whole-size panel scaffold
 * (`panel.ts`): a Spectrum overlay/dropdown can never paint above the native
 * view Electron composites over the renderer document, so instead of a menu
 * that floats over the page, opening the panel suspends/collapses the native
 * view (`BrowserViewHost.setSuspended`, via the browser pane's panel host)
 * and lets this panel occupy the pane's whole page-view region.
 *
 * Each option is a real `<button>` addressable in the accessibility tree, but
 * styled as a flat list row (no resting button background - see
 * `.hosts-item` in browser.css), so the list reads as "one item after
 * another", exactly like a browser's own host/bookmark picker. Clicking or
 * pressing Enter on an item selects it; the header offers a close (cross)
 * button and Escape dismisses.
 */
export interface HostsPanel {
  readonly element: HTMLElement;
  /** Rebuilds the option rows from a loaded settings snapshot. */
  setHostOptions(options: readonly HostOption[]): void;
  /** Reveals the panel (it must already be in the DOM, hidden). */
  open(): void;
  /** Hides the panel. */
  close(): void;
  readonly isOpen: boolean;
  /**
   * Locks or unlocks the panel's dismissal affordances (close button and
   * Escape). See `Panel.setCloseable` — the browser pane gates this on whether
   * a page is loaded under the panel, so a user can never dismiss the startup
   * picker to reveal a bare page-view region. Selecting a host stays the
   * sanctioned way out regardless.
   */
  setCloseable(closeable: boolean): void;
  dispose(): void;
}

export interface HostsPanelCallbacks {
  /** Fired when an option row is activated (click or Enter). */
  onSelect(origin: string): void;
  /** Fired when the close (cross) button or Escape dismisses the panel. */
  onClose(): void;
}

export function createHostsPanel(callbacks: HostsPanelCallbacks): HostsPanel {
  const list = el('div', {
    attrs: {
      class: 'hosts-panel__list',
      role: 'listbox',
      'aria-label': 'Configured hosts',
    },
  });

  const panel = createPanel({
    title: 'Select a host',
    closeAriaLabel: 'Close hosts panel',
    surfaceClassName: 'hosts-panel',
    closeButtonClassName: 'hosts-panel__close',
    autofocusSelector: '.hosts-item',
    content: list,
    onDismiss(): void {
      callbacks.onClose();
    },
  });

  function buildItem(option: HostOption): HTMLElement {
    const swatch = el('span', {
      attrs: { class: 'server-swatch hosts-item__swatch', role: 'presentation' },
    });
    swatch.style.backgroundColor = option.colorCss;
    const label = el('span', {
      attrs: { class: 'hosts-item__label' },
      text: option.label,
    });
    const origin = el('span', {
      attrs: { class: 'hosts-item__origin' },
      text: option.origin,
    });
    const item = el('button', {
      attrs: {
        class: 'hosts-item',
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

  function setHostOptions(options: readonly HostOption[]): void {
    list.replaceChildren(...options.map(buildItem));
  }

  return {
    get element() {
      return panel.element;
    },
    setHostOptions,
    open: () => panel.open(),
    close: () => panel.close(),
    setCloseable: (closeable) => panel.setCloseable(closeable),
    get isOpen() {
      return panel.isOpen;
    },
    dispose: () => panel.dispose(),
  };
}
