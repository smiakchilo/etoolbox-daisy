import type { VirtualTrigger } from '@spectrum-web-components/overlay/src/VirtualTrigger.js';
import { el } from '../lib/dom';
import type { LinkAction } from './linkTargets';

/**
 * The single, travelling hover popover for transcript links that offer
 * edit-mode actions (Edit / CRX).
 *
 * One `sp-overlay` + `sp-popover` is created for the whole transcript and
 * reused for every link - never one per link, which for a long message with
 * thousands of links would create thousands of overlay elements and stack
 * entries. It is positioned with a Spectrum `VirtualTrigger` moved to the
 * hovered link's own bounding box (`placement="top"`), so it is anchored to the
 * link rather than following the pointer.
 *
 * `VirtualTrigger` is imported lazily, and the whole factory returns
 * `undefined` when `sp-overlay` is not registered. Both matter for the same
 * reason: the overlay package's module graph touches `window`/`document` at
 * import time, so a top-level import would break the node-based unit tests
 * (which import `transcriptView.ts` but never load the real overlay). In the
 * shipped renderer `main.ts` has already registered `sp-overlay`, so the
 * dynamic import resolves from the same, already-loaded graph.
 */

export interface LinkActionPopover {
  /** Shows the popover for `anchor`, replacing its buttons with `actions`. */
  show(anchor: HTMLElement, actions: readonly LinkAction[]): void;
  /** Hides after a short grace, so moving from the link into the popover keeps it open. */
  scheduleHide(): void;
  /** Hides immediately. */
  hideNow(): void;
  dispose(): void;
}

export interface LinkActionPopoverOptions {
  /** Invoked when one of the popover's action buttons is activated. */
  readonly onOpenLink: (url: string) => void;
  /** Where to attach the overlay; must be inside the active `sp-theme` so the popover is themed. */
  readonly getContainer: () => HTMLElement;
}

/** Long enough to cross the gap between the link and the popover above it. */
const HIDE_GRACE_MS = 200;

export function createLinkActionPopover(
  options: LinkActionPopoverOptions,
): LinkActionPopover | undefined {
  if (
    typeof customElements === 'undefined' ||
    customElements.get('sp-overlay') === undefined ||
    customElements.get('sp-popover') === undefined
  ) {
    return undefined;
  }

  const buttons = el('div', { attrs: { class: 'chat-link-popover__actions' } });
  const popover = el('sp-popover', { attrs: { class: 'chat-link-popover' } });
  popover.append(buttons);
  const overlay = el('sp-overlay', {
    attrs: { type: 'manual', placement: 'top', offset: '10' },
  });
  overlay.append(popover);

  let trigger: VirtualTrigger | undefined;
  let pending: { anchor: HTMLElement; actions: readonly LinkAction[] } | undefined;
  let attached = false;
  let disposed = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  void import('@spectrum-web-components/overlay/src/VirtualTrigger.js').then(
    ({ VirtualTrigger: VirtualTriggerClass }) => {
      if (disposed) return;
      trigger = new VirtualTriggerClass(0, 0);
      overlay.triggerElement = trigger;
      if (pending !== undefined) {
        const queued = pending;
        pending = undefined;
        show(queued.anchor, queued.actions);
      }
    },
  );

  function cancelHide(): void {
    if (hideTimer !== undefined) {
      clearTimeout(hideTimer);
      hideTimer = undefined;
    }
  }

  function hideNow(): void {
    cancelHide();
    overlay.open = false;
  }

  function scheduleHide(): void {
    cancelHide();
    hideTimer = setTimeout(hideNow, HIDE_GRACE_MS);
  }

  function buildButton(action: LinkAction): HTMLElement {
    const icon =
      action.id === 'edit'
        ? el('sp-icon-edit', { attrs: { slot: 'icon' } })
        : el('sp-icon-journey-voyager', { attrs: { slot: 'icon' } });
    const button = el('sp-action-button', {
      // `tabindex="-1"` keeps the button out of the tab order (the Spectrum
      // button sets its own host to `tabindex="0"` only when none is present);
      // `mousedown` is prevented so a click never focuses it either. The popover
      // is a transient hover affordance, so no button may ever take focus.
      attrs: { label: action.title, title: action.title, tabindex: '-1' },
    });
    button.append(icon);
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      hideNow();
      options.onOpenLink(action.href);
    });
    return button;
  }

  function show(anchor: HTMLElement, actions: readonly LinkAction[]): void {
    if (disposed) return;
    if (trigger === undefined) {
      pending = { anchor, actions };
      return;
    }
    if (!attached) {
      options.getContainer().append(overlay);
      attached = true;
    }
    buttons.replaceChildren(...actions.map(buildButton));
    const rect = anchor.getBoundingClientRect();
    trigger.updateBoundingClientRect(rect.left + rect.width / 2, rect.top);
    overlay.open = true;
  }

  // Keeping the popover open while the pointer is over it is what lets the user
  // move from the link up into a button without it vanishing.
  overlay.addEventListener('pointerenter', cancelHide);
  overlay.addEventListener('pointerleave', scheduleHide);

  // A scroll moves the link out from under the popover, so the anchor would be
  // wrong; close instead of chasing it.
  const onScroll = (): void => hideNow();
  window.addEventListener('scroll', onScroll, true);

  return {
    show,
    scheduleHide,
    hideNow,
    dispose() {
      disposed = true;
      window.removeEventListener('scroll', onScroll, true);
      cancelHide();
      overlay.open = false;
      overlay.removeEventListener('pointerenter', cancelHide);
      overlay.removeEventListener('pointerleave', scheduleHide);
      overlay.remove();
    },
  };
}
