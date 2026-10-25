import type { VirtualTrigger } from '@spectrum-web-components/overlay/src/VirtualTrigger.js';
import { el } from '../lib/dom';

/**
 * The single, travelling hover popover for transcript affordances that offer
 * one or two icon actions - a message link's Edit/CRX, or a `format_table`
 * run's gutter Copy/Export.
 *
 * One `sp-overlay` + `sp-popover` is created for the whole transcript and
 * reused for every hover target - never one per target, which for a long
 * message with thousands of links would create thousands of overlay elements
 * and stack entries. It is positioned with a Spectrum `VirtualTrigger` moved to
 * the hovered element's own bounding box (`placement="top"`), so it is anchored
 * to that element rather than following the pointer.
 *
 * `VirtualTrigger` is imported lazily, and the whole factory returns
 * `undefined` when `sp-overlay` is not registered. Both matter for the same
 * reason: the overlay package's module graph touches `window`/`document` at
 * import time, so a top-level import would break the node-based unit tests
 * (which import `transcriptView.ts` but never load the real overlay). In the
 * shipped renderer `main.ts` has already registered `sp-overlay`, so the
 * dynamic import resolves from the same, already-loaded graph.
 */

/** One icon-only button the popover shows. */
export interface HoverAction {
  /** Stable identity, used to build each button. */
  readonly id: string;
  /** The tooltip / accessible label, e.g. `"Copy"`. */
  readonly title: string;
  /** The icon element tag to render in the button's icon slot, e.g. `"sp-icon-copy"`. */
  readonly icon: keyof HTMLElementTagNameMap;
  /** What activating the button does. The popover hides itself first. */
  readonly onActivate: () => void;
}

/**
 * Where the popover sits relative to its anchor, named after Spectrum's own
 * placement values: `"top"` centred above it (a link), `"top-end"` right-aligned
 * above it (a table's header row, total line or message surface), `"bottom-end"`
 * right-aligned below it (a table's own bottom edge, for a table that draws no
 * total line - so the buttons sit beside the pointer instead of rising over the
 * last row).
 */
export type HoverActionPlacement = 'top' | 'top-end' | 'bottom-end';

export interface HoverActionPopover {
  /**
   * Shows the popover for `anchor`, replacing its buttons with `actions`.
   * `placement` decides which point of the anchor it hangs off, so the gutter's
   * buttons hug the table's right edge instead of straddling its middle - and a
   * table's bottom edge can carry them *below* itself.
   */
  show(
    anchor: HTMLElement,
    actions: readonly HoverAction[],
    placement?: HoverActionPlacement,
  ): void;
  /** Hides after a short grace, so moving from the anchor into the popover keeps it open. */
  scheduleHide(): void;
  /** Hides immediately. */
  hideNow(): void;
  dispose(): void;
}

export interface HoverActionPopoverOptions {
  /** Where to attach the overlay; must be inside the active `sp-theme` so the popover is themed. */
  readonly getContainer: () => HTMLElement;
}

/** Long enough to cross the gap between the anchor and the popover above it. */
const HIDE_GRACE_MS = 200;

export function createHoverActionPopover(
  options: HoverActionPopoverOptions,
): HoverActionPopover | undefined {
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
    attrs: { type: 'manual', placement: 'top', 'data-testid': 'hover-popover' },
  });
  overlay.append(popover);

  let trigger: VirtualTrigger | undefined;
  let pending:
    | { anchor: HTMLElement; actions: readonly HoverAction[]; placement: HoverActionPlacement }
    | undefined;
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
        show(queued.anchor, queued.actions, queued.placement);
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

  function buildButton(action: HoverAction): HTMLElement {
    const icon = el(action.icon, { attrs: { slot: 'icon' } });
    const button = el('sp-action-button', {
      // `tabindex="-1"` keeps the button out of the tab order (the Spectrum
      // button sets its own host to `tabindex="0"` only when none is present);
      // `mousedown` is prevented so a click never focuses it either. The popover
      // is a transient hover affordance, so no button may ever take focus.
      attrs: {
        label: action.title,
        title: action.title,
        tabindex: '-1',
        'data-testid': `popover-${action.id}`,
      },
    });
    button.append(icon);
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      hideNow();
      action.onActivate();
    });
    return button;
  }

  function show(
    anchor: HTMLElement,
    actions: readonly HoverAction[],
    placement: HoverActionPlacement = 'top',
  ): void {
    if (disposed) return;
    // Showing for a new anchor must cancel any hide still pending from the
    // anchor the pointer just left: moving swiftly from one target to another
    // fires `pointerout` on the old one (which schedules a hide) *before*
    // `pointerover` on the new one, so without this the old target's grace
    // timer would still fire and close the popover the pointer just moved to.
    cancelHide();
    if (trigger === undefined) {
      pending = { anchor, actions, placement };
      return;
    }
    if (!attached) {
      options.getContainer().append(overlay);
      attached = true;
    }
    buttons.replaceChildren(...actions.map(buildButton));
    // The anchor is a zero-size `VirtualTrigger` point, so the *placement* is
    // what aligns the popover against it: `top` centres the popover on the
    // point, `top-end` puts its right edge on the anchor's top-right corner,
    // and `bottom-end` puts its right edge on the anchor's bottom-right corner
    // (below the anchor). Changing `placement` while open makes the overlay
    // re-run its positioning, so a move from a link to a gutter (or back)
    // re-lays out rather than opening at the previous alignment.
    const rect = anchor.getBoundingClientRect();
    if (overlay.placement !== placement) overlay.placement = placement;
    const x = placement === 'top' ? rect.left + rect.width / 2 : rect.right;
    const y = placement === 'bottom-end' ? rect.bottom : rect.top;
    trigger.updateBoundingClientRect(x, y);
    overlay.open = true;
  }

  // Keeping the popover open while the pointer is over it is what lets the user
  // move from the anchor up into a button without it vanishing.
  overlay.addEventListener('pointerenter', cancelHide);
  overlay.addEventListener('pointerleave', scheduleHide);

  // A scroll moves the anchor out from under the popover, so the anchor would
  // be wrong; close instead of chasing it.
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
