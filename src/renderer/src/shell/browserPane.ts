import { el } from '../lib/dom';
import { createBrowserToolbar } from './browserToolbar';
import { createBrowserViewHost } from './browserViewHost';
import { createInsecureBanner } from './insecureBanner';
import { createServerPickerPanel } from './serverPickerPanel';
import type { InsecureMarkerState, ServerOption } from './viewModel';

export interface BrowserPane {
  readonly element: HTMLElement;
  update(state: {
    readonly addressValue: string;
    readonly serverOptions: readonly ServerOption[];
    readonly insecureMarker: InsecureMarkerState;
  }): void;
  /** Collapses/restores the native AEM view while the pane splitter is dragged - see `BrowserViewHost.setSuspended`. */
  setViewSuspended(suspended: boolean): void;
  dispose(): void;
}

/**
 * The left-hand browser pane: toolbar, persistent insecure marker, the page
 * panel - the browser's status/message row (toolbar errors, the "unknown
 * origin" prompt, "Switching servers...") grouped with the reserved page-view
 * region it describes - and, overlaid while the server picker is open, the
 * whole-size server list panel.
 *
 * Message and native-view region are grouped inside `browserPagePanel` so one
 * `hidden` toggle governs both:
 *
 *  - the picker ("combobox glyph" button coupled to the address field in the
 *    toolbar) is the only way to surface that panel, and the panel is the only
 *    thing the renderer may draw over the native view's region: instead of a
 *    menu trying to float above an Electron-native WebContentsView (which
 *    always composites *above* this document), opening the picker
 *    suspends/collapses the native view (`suspendedByPicker`) and lets the DOM
 *    panel take the whole page-view area. The splitter drag uses the same
 *    collapse mechanism (`suspendedBySplitter`); the two are combined so each
 *    independently collapsing and restoring never resurrects the native view
 *    while the other still requires it hidden.
 *  - whenever the native view is hidden/collapsed that way, the message row is
 *    hidden along with it - its text describes the page that just vanished, so
 *    showing it against the picker list or an empty drag region would be
 *    misleading. The picker swaps instantly (`pagePanel.hidden` + an instant
 *    native-view collapse - the list needs the layout space immediately); a
 *    splitter drag fades the panel via the `browser-page-panel--suspended`
 *    class *and* asks the native view to collapse with an animation matching
 *    that fade (browserViewHost.ts), so the pane's height stays put while the
 *    page area fades in/out around the shrinking view.
 *
 * The row's *content* lifecycle stays in the toolbar (`browserToolbar.ts`):
 * it is cleared when a new navigation starts loading, and re-shown only when
 * that navigation fails.
 */
export function createBrowserPane(): BrowserPane {
  let suspendedBySplitter = false;
  let suspendedByPicker = false;
  let pickerOpen = false;

  function applySuspension(): void {
    const suspended = suspendedBySplitter || suspendedByPicker;
    // Animate whenever a splitter drag is involved; a picker-only suspension
    // (and its restore) collapses instantly so the list can take its space.
    viewHost.setSuspended(suspended, { animate: suspendedBySplitter });
    if (suspendedByPicker) {
      // The server picker panel takes over the page area, so the page panel
      // must relinquish its layout space at once (`display:none`). The drag
      // path below instead fades it while keeping its space, so the pane does
      // not jump mid-drag.
      pagePanel.hidden = true;
      pagePanel.classList.remove('browser-page-panel--suspended');
    } else {
      pagePanel.hidden = false;
      pagePanel.classList.toggle('browser-page-panel--suspended', suspendedBySplitter);
    }
  }

  const panel = createServerPickerPanel({
    onSelect(origin: string): void {
      closePickerPanel();
      toolbar.navigateTo(origin);
    },
    onClose(): void {
      closePickerPanel();
    },
  });

  const toolbar = createBrowserToolbar({
    onServerPickerClick(): void {
      if (pickerOpen) closePickerPanel();
      else openPickerPanel();
    },
  });
  const insecureBanner = createInsecureBanner();
  const viewHost = createBrowserViewHost();

  // Groups the toolbar's status/prompt row with the native view region so the
  // picker/splitter suspension hides both at once (see the file doc comment).
  const pagePanel = el('div', {
    attrs: { class: 'browser-page-panel', 'data-testid': 'browser-page-panel' },
    children: [toolbar.messageElement, viewHost.element],
  });

  function openPickerPanel(): void {
    if (pickerOpen) return;
    pickerOpen = true;
    // Order matters (see file doc comment): the native view paints above the
    // document, so it must be collapsed first and never restored below an
    // already-hidden panel.
    suspendedByPicker = true;
    applySuspension();
    toolbar.setServerPickerOpen(true);
    panel.open();
  }

  function closePickerPanel(): void {
    if (!pickerOpen) return;
    pickerOpen = false;
    // Hide the panel first (via its own close), then restore the native view
    // region, so the returning view never paints over a still-visible panel.
    panel.close();
    toolbar.setServerPickerOpen(false);
    suspendedByPicker = false;
    applySuspension();
  }

  const element = el('section', {
    attrs: { class: 'pane browser-pane', 'aria-label': 'Browser' },
    children: [toolbar.element, insecureBanner.element, pagePanel, panel.element],
  });

  return {
    element,
    update(state): void {
      toolbar.setAddressValue(state.addressValue);
      toolbar.setServerOptions(state.serverOptions);
      panel.setServerOptions(state.serverOptions);
      insecureBanner.update(state.insecureMarker);
      viewHost.reportBoundsNow();
    },
    setViewSuspended(suspended: boolean): void {
      suspendedBySplitter = suspended;
      applySuspension();
    },
    dispose(): void {
      toolbar.dispose();
      panel.dispose();
      viewHost.dispose();
    },
  };
}
