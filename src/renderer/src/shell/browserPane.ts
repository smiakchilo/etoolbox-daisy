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
 * The left-hand browser pane: toolbar, persistent insecure marker, the
 * reserved page-view region, and - overlaid on that region while the server
 * picker is open - the whole-size server list panel.
 *
 * The picker ("combobox glyph" button coupled to the address field in the
 * toolbar) is the only way to surface that panel, and the panel is the only
 * thing the renderer may draw over the native view's region: instead of a
 * menu trying to float above an Electron-native WebContentsView (which always
 * composites *above* this document), opening the picker suspends/collapses
 * the native view (`suspendedByPicker`) and lets the DOM panel take the whole
 * page-view area. The splitter drag uses the same collapse mechanism
 * (`suspendedBySplitter`); the two are combined so each independently
 * collapsing and restoring never resurrects the native view while the other
 * still requires it hidden.
 */
export function createBrowserPane(): BrowserPane {
  let suspendedBySplitter = false;
  let suspendedByPicker = false;
  let pickerOpen = false;

  function applySuspension(): void {
    viewHost.setSuspended(suspendedBySplitter || suspendedByPicker);
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

  function openPickerPanel(): void {
    if (pickerOpen) return;
    pickerOpen = true;
    // Order matters (see file doc comment): the native view paints above the
    // document, so it must be collapsed first and never restored below an
    // already-hidden panel.
    suspendedByPicker = true;
    applySuspension();
    viewHost.element.hidden = true;
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
    viewHost.element.hidden = false;
    suspendedByPicker = false;
    applySuspension();
    viewHost.reportBoundsNow();
  }

  const element = el('section', {
    attrs: { class: 'pane browser-pane', 'aria-label': 'Browser' },
    children: [
      toolbar.element,
      toolbar.messageElement,
      insecureBanner.element,
      viewHost.element,
      panel.element,
    ],
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
