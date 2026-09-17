import { el } from '../lib/dom';
import { createBrowserToolbar } from './browserToolbar';
import { createBrowserViewHost } from './browserViewHost';
import { createInsecureBanner } from './insecureBanner';
import type { Panel } from './panel';
import { createHostsPanel } from './hostsPanel';
import type { HostOption, InsecureMarkerState } from './viewModel';

/**
 * The single-open host for whole-size panels over the pane's page-view
 * region (the hosts panel and the Settings panel today; History later).
 * Only one panel is visible at a time: opening a second panel first closes
 * whatever is active. The host owns the native-view suspension dance and
 * nothing else - the panels themselves are plain `Panel` instances managed
 * through their own `open`/`close`.
 */
export interface BrowserPanelHost {
  /** Suspends the native view and shows `panel`, closing whatever was open. */
  open(panel: Panel): void;
  /** Hides and desuspends whatever panel is active, if any. */
  close(): void;
  isActive(panel: Panel): boolean;
}

export interface BrowserPane {
  readonly element: HTMLElement;
  /** The single-open host for whole-size panels over the page-view region. */
  readonly panelHost: BrowserPanelHost;
  /**
   * Appends a panel's element to the pane's page-view region (hidden until
   * `panelHost.open` reveals it). Used for panels the pane does not itself
   * own (settings, history).
   */
  appendPanel(panel: Panel): void;
  update(state: {
    readonly addressValue: string;
    readonly hostOptions: readonly HostOption[];
    readonly insecureMarker: InsecureMarkerState;
  }): void;
  dispose(): void;
}

/**
 * The left-hand browser pane: toolbar, persistent insecure marker, the page
 * panel - the browser's status/message row (toolbar errors, the "unknown
 * origin" prompt, external-loading "Loading…" presentation) grouped below
 * the reserved page-view region it describes (statusbar-style: the row sits
 * under the page, not over it) - and, covered while a whole-size panel is
 * open, the panel (hosts panel or Settings).
 *
 * Message and native-view region are grouped inside `browserPagePanel` so one
 * `hidden` toggle governs both:
 *
 *  - a whole-size panel (`panelHost.open`) is the only thing the renderer may
 *    draw over the native view's region: instead of an overlay trying to
 *    float above an Electron-native WebContentsView (which always composites
 *    *above* this document), opening the panel suspends/collapses the native
 *    view and lets the DOM panel take the whole page-view area. The hosts
 *    panel ("combobox glyph" button in the toolbar) and the chat pane's
 *    Settings/History buttons all go through this one host.
 *  - a splitter drag does NOT touch the native view or the panel at all: the
 *    page stays fully visible and live-following for the drag's whole
 *    duration. The view only ever collapses for a panel.
 *  - whenever the native view is hidden/collapsed by a panel, the message
 *    row is hidden along with it - its text describes the page that just
 *    vanished, so showing it against the panel would be misleading. The
 *    panel swaps instantly (`pagePanel.hidden` + an instant native-view
 *    collapse - the panel needs the layout space immediately).
 *
 * The row's *content* lifecycle stays in the toolbar (`browserToolbar.ts`):
 * it is cleared when a new navigation starts loading, and re-shown only when
 * that navigation fails.
 */
export function createBrowserPane(): BrowserPane {
  let activePanel: Panel | undefined;

  const picker = createHostsPanel({
    onSelect(origin: string): void {
      closeActivePanel();
      toolbar.navigateTo(origin);
    },
    onClose(): void {
      closeActivePanel();
    },
  });

  const toolbar = createBrowserToolbar({
    onHostsPickerClick(): void {
      if (activePanel === picker) closeActivePanel();
      else openPanel(picker);
    },
  });
  const insecureBanner = createInsecureBanner();
  const viewHost = createBrowserViewHost();

  // Groups the toolbar's status/prompt row with the native view region so the
  // panel suspension hides both at once (see the file doc comment). The
  // message row comes AFTER the view host in DOM order - the flex column lays
  // it out below the reserved page-view region (statusbar-style), where it
  // physically can't overlap the native view during the load it describes.
  const pagePanel = el('div', {
    attrs: { class: 'browser-page-panel', 'data-testid': 'browser-page-panel' },
    children: [viewHost.element, toolbar.messageElement],
  });

  function openPanel(panel: Panel): void {
    if (activePanel === panel) return;
    activePanel?.close();
    activePanel = panel;
    // Order matters (see file doc comment): the native view paints above the
    // document, so it must be collapsed first and never restored below an
    // already-hidden panel.
    viewHost.setSuspended(true);
    pagePanel.hidden = true;
    toolbar.setHostsPickerOpen(panel === picker);
    panel.open();
  }

  function closeActivePanel(): void {
    if (activePanel === undefined) return;
    const panel = activePanel;
    activePanel = undefined;
    // Hide the panel first (via its own close), then restore the native view
    // region, so the returning view never paints over a still-visible panel.
    panel.close();
    toolbar.setHostsPickerOpen(false);
    viewHost.setSuspended(false);
    pagePanel.hidden = false;
  }

  const element = el('section', {
    attrs: { class: 'pane browser-pane', 'aria-label': 'Browser' },
    children: [toolbar.element, insecureBanner.element, pagePanel, picker.element],
  });

  return {
    element,
    panelHost: {
      open: openPanel,
      close: closeActivePanel,
      isActive: (panel) => activePanel === panel,
    },
    appendPanel(panel: Panel): void {
      element.append(panel.element);
    },
    update(state): void {
      toolbar.setAddressValue(state.addressValue);
      toolbar.setHostOptions(state.hostOptions);
      picker.setHostOptions(state.hostOptions);
      insecureBanner.update(state.insecureMarker);
      viewHost.reportBoundsNow();
    },
    dispose(): void {
      toolbar.dispose();
      picker.dispose();
      viewHost.dispose();
    },
  };
}
