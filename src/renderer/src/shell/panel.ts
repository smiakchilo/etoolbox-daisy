import { el } from '../lib/dom';
import { CLOSE_ICON_TAG, registerCloseIcon } from './closeIcon';

/**
 * The whole-size, page-view "modal" panel shared by every surface that must
 * replace the native `WebContentsView` region while open (the hosts panel
 * today; the Settings and History panels that supersede their child windows).
 *
 * It exists because a Spectrum overlay/dropdown can never paint above the
 * native view Electron composites over the renderer document: instead of a
 * menu that floats over the page, opening the panel suspends/collapses the
 * native view (`BrowserViewHost.setSuspended`, brokered through the browser
 * pane's panel host) and lets the panel occupy the pane's whole page-view
 * area. The close button and Escape both dismiss the panel; the caller of
 * `createPanel` decides what dismissal means via `onDismiss`.
 *
 * The header title uses the theme's own heading typography at the L scale
 * with the light (300) weight variant - the `spectrum-Heading--light`
 * presentation - so the short title reads thin but large against the 14px
 * body text. The close affordance is a quiet action button scaled to roughly
 * 1.5x a regular (size m) action button (48px tall, 32px icon vs the default
 * 32px/18px) and carries our own hairline close glyph (see closeIcon.ts):
 * the Spectrum crosses are filled shapes whose bars read heavy here, so the
 * panel draws its own thin-stroked cross instead.
 */
export interface Panel {
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  /** Reveals the panel (it must already be in the DOM, hidden) and focuses its first focusable surface. */
  open(): void;
  /** Hides the panel. Programmatic closes do not fire `onDismiss`. */
  close(): void;
  /**
   * Locks or unlocks the panel's user dismissal affordances (the close (cross)
   * button and Escape). When locked, both are inert: the cross is disabled and
   * Escape does nothing, so the panel can only be left through a programmatic
   * close (e.g. the hosts panel's selection, which navigates). The owning pane
   * gates this on whether a page is loaded under the panel — dismissing a
   * panel must never reveal a bare, page-less page-view region.
   */
  setCloseable(closeable: boolean): void;
  dispose(): void;
}

export interface PanelDismissHandler {
  /** Fired when the close (cross) button or Escape dismisses the panel. */
  onDismiss(): void;
}

export interface CreatePanelOptions extends PanelDismissHandler {
  readonly title: string;
  /** The panel's scrollable body. */
  readonly content: HTMLElement;
  readonly closeAriaLabel: string;
  /** Extra class names for the panel surface (kept as aliases for existing selectors). */
  readonly surfaceClassName?: string;
  /** Extra class names for the close button (kept as aliases for existing selectors). */
  readonly closeButtonClassName?: string;
  /** Selector of the element to focus on open; defaults to the close button. */
  readonly autofocusSelector?: string;
  /**
   * Stable test hook: the surface wears `data-testid="<testId>"` and its close
   * button `data-testid="<testId>-close"`.
   */
  readonly testId?: string;
}

export function createPanel(options: CreatePanelOptions): Panel {
  registerCloseIcon();
  let open = false;
  let closeable = true;

  const closeButton = el('sp-action-button', {
    attrs: {
      quiet: '',
      'aria-label': options.closeAriaLabel,
      class: ['panel__close', options.closeButtonClassName].filter(Boolean).join(' '),
      ...(options.testId === undefined ? {} : { 'data-testid': `${options.testId}-close` }),
    },
  });
  const closeIcon = document.createElement(CLOSE_ICON_TAG);
  closeIcon.setAttribute('slot', 'icon');
  closeButton.append(closeIcon);

  const header = el('div', {
    attrs: { class: 'panel__header' },
    children: [el('span', { attrs: { class: 'panel__title' }, text: options.title }), closeButton],
  });

  const element = el('div', {
    attrs: {
      class: ['panel', options.surfaceClassName].filter(Boolean).join(' '),
      ...(options.testId === undefined ? {} : { 'data-testid': options.testId }),
    },
    children: [header, options.content],
  });
  element.hidden = true;

  function openPanel(): void {
    if (open) return;
    open = true;
    element.hidden = false;
    const autofocus = options.autofocusSelector
      ? element.querySelector<HTMLElement>(options.autofocusSelector)
      : null;
    const focusTarget = autofocus ?? (closeable ? closeButton : null);
    focusTarget?.focus();
  }

  function closePanel(): void {
    if (!open) return;
    open = false;
    element.hidden = true;
  }

  function setPanelCloseable(next: boolean): void {
    closeable = next;
    if (next) {
      closeButton.removeAttribute('disabled');
    } else {
      closeButton.setAttribute('disabled', '');
    }
  }

  function handleDismiss(): void {
    if (!closeable) return;
    closePanel();
    options.onDismiss();
  }
  closeButton.addEventListener('click', handleDismiss);

  const handleKeydown = (event: KeyboardEvent): void => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      handleDismiss();
    }
  };
  document.addEventListener('keydown', handleKeydown, true);

  return {
    get element() {
      return element;
    },
    get isOpen() {
      return open;
    },
    open: openPanel,
    close: closePanel,
    setCloseable: setPanelCloseable,
    dispose(): void {
      closeButton.removeEventListener('click', handleDismiss);
      document.removeEventListener('keydown', handleKeydown, true);
    },
  };
}
