import { el } from '../lib/dom';
import { createStatusBanner, type StatusBannerSink } from '../settings/statusBanner';
import { createBrowserToolbar } from './browserToolbar';
import { createBrowserViewHost } from './browserViewHost';
import type { Panel } from './panel';
import { createHostsPanel } from './hostsPanel';
import type { HostOption } from './viewModel';

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
   * The pane-owned status slot for the whole-size panels it hosts (Settings
   * today, History later). It lives in the page panel directly below the view
   * slot - outside every panel - so a panel's save feedback survives the panel
   * being dismissed. Handed to a panel through its options rather than created
   * by it (a panel-owned row was hidden with the panel).
   */
  readonly surfaceStatus: StatusBannerSink;
  /**
   * Opens the pane's own hosts panel as the active panel (covering the whole
   * page-view region, exactly like a click on the toolbar's hosts button).
   * Used by the shell to reveal the existing-host list at startup when at
   * least one server is configured.
   */
  openHostsPicker(): void;
  /**
   * Navigates the pane to `url` exactly as a typed address or a picker
   * selection would. The shell routes a transcript link here so the browser
   * pane owns the navigation and, in particular, its failure: a failed load
   * shows the pane's error row (with Reload) rather than a chat-pane error.
   */
  navigate(url: string): void;
  /**
   * Appends a panel's element to the pane's shared view slot (hidden until
   * `panelHost.open` reveals it). Used for panels the pane does not itself
   * own (settings, history).
   */
  appendPanel(panel: Panel): void;
  /** Reflects the chat pane's visibility onto the toolbar toggle (icon/title). */
  setAgentPaneOpen(open: boolean): void;
  update(state: {
    readonly addressValue: string;
    readonly hostOptions: readonly HostOption[];
  }): void;
  dispose(): void;
}

/**
 * The left-hand browser pane: toolbar, then a page panel stacking the
 * reserved page-view region and the browser's status/message row (toolbar
 * errors, the "unknown origin"/certificate prompts, and the "Loading…"
 * presentation). The row is statusbar-style - *below* the region it
 * describes - so it is never covered by a page and never overlaps the native
 * view.
 *
 *  - a whole-size panel (`panelHost.open`) is the only thing the renderer may
 *    draw over the native view's region: instead of an overlay trying to
 *    float above an Electron-native WebContentsView (which always composites
 *    *above* this document), opening the panel suspends/collapses the native
 *    view and lets the DOM panel take its exact slot (`viewSlot`). The hosts
 *    panel ("combobox glyph" button in the toolbar) and the chat pane's
 *    Settings/History buttons all go through this one host.
 *  - the panel replaces the native view *inside the view slot only*. The
 *    message row lives outside that slot and stays visible, so an error row
 *    (with Reload) is never hidden by whichever panel happens to be open.
 *  - a splitter drag does NOT touch the native view or any panel: the page
 *    stays fully visible and live-following for the drag's whole duration.
 *    The view only ever collapses for a panel.
 *  - when a failed load has no page to restore, the pane asks the hosts
 *    picker on - but only when no panel is already on screen
 *    (`onHostsPickerRequest`); the error row appears below whatever is shown.
 *
 * The row's *content* lifecycle stays in the toolbar (`browserToolbar.ts`):
 * it is cleared when a new navigation starts loading, and re-shown only when
 * that navigation fails.
 */
export interface BrowserPaneCallbacks {
  /** Fired by the toolbar's agent-pane toggle; the shell hides/shows the chat pane. */
  readonly onToggleAgentPane?: () => void;
}

export function createBrowserPane(callbacks: BrowserPaneCallbacks = {}): BrowserPane {
  let activePanel: Panel | undefined;

  // The closeability latch. A whole-size panel replaces (suspends) the native
  // view, so dismissing it reveals the bare page-view region. That region is
  // only meaningful once a real page has loaded into the native view, which is
  // exactly when the main process starts pushing navigation-state updates; a
  // user must therefore never be able to dismiss a panel until at least one
  // `onStateChanged` event has arrived (the startup hosts picker/Settings
  // panel on a fresh profile are the prime case). The latch is one-way for the
  // session - a view that has loaded a page keeps it, so once the pane unlocks
  // it stays unlocked.
  let pageLoaded = false;

  // The pane-owned status slot for the panels it hosts (Settings today). It is
  // created here, not by the panel, and lives in `pagePanel` below the view
  // slot so its feedback outlives a dismissed panel. `createStatusBanner`
  // defaults to the `surface-status-banner` surface class.
  const surfaceStatus = createStatusBanner();

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
      if (activePanel === picker) {
        // Toggling the open picker off is a dismissal, so it obeys the same
        // closeability rule: with nothing loaded under it yet, the only way
        // out is to select a host (which navigates AND closes the panel).
        if (pageLoaded) closeActivePanel();
      } else {
        openPanel(picker);
      }
    },
    onToggleAgentPane(): void {
      callbacks.onToggleAgentPane?.();
    },
    // A failed load with no page to restore: replace the blank page-view
    // region with the hosts list so the user can pick where to go. Not a
    // toggle - opening an already-open picker is a no-op (`openPanel`).
    //
    // Only when nothing else is on screen: if a panel (Settings, History, …)
    // is already open, leave it. A failed navigation must not yank the user
    // out of the surface they chose; the error row still appears below it
    // (the row lives outside the panel's slot and is never covered).
    onHostsPickerRequest(): void {
      if (activePanel === undefined) openPanel(picker);
    },
  });
  const viewHost = createBrowserViewHost();

  // The pane keeps its own latch on the navigation-state feed: the toolbar's
  // copy is private, and each `onStateChanged` listener is an independent
  // `ipcRenderer.on` subscription (app-preload.ts), so subscribing twice is
  // safe. Like the toolbar's `lastNavigationState`, it latches on ANY push -
  // including the start/stop of a failed load, so a down server still unlocks
  // the panel once the user has navigated at it.
  const unsubscribeState = window.daisy.browser.onStateChanged(() => {
    if (pageLoaded) return;
    pageLoaded = true;
    activePanel?.setCloseable(true);
  });

  // The slot the native view and every whole-size panel share, directly above
  // the status/prompt row. A panel *replaces the native view* inside this one
  // slot - the exact region the `WebContentsView` occupies - so the message
  // row below it is never covered (see the file doc comment). The picker's
  // element lives here too; no panel is ever a sibling of the row.
  const viewSlot = el('div', {
    attrs: { class: 'browser-view-slot', 'data-testid': 'browser-view-slot' },
    children: [viewHost.element, picker.element],
  });

  // The status/prompt row sits BELOW the view slot (statusbar-style), so it is
  // physically outside every panel's region: a panel can never cover the error
  // or loading copy. Opening a panel no longer hides the row - the row
  // describes the browser, not the page a panel replaced.
  //
  // The pane-owned surface-status row (Settings saves, and later other panels'
  // feedback) is the first row under the slot, so it reads as the status of
  // whatever occupies the slot; the browser's own navigation row stays last.
  // Both collapse to zero height when idle, so the browser row sits flush under
  // the page whenever the surface row is empty.
  const pagePanel = el('div', {
    attrs: { class: 'browser-page-panel', 'data-testid': 'browser-page-panel' },
    children: [viewSlot, surfaceStatus.element, toolbar.messageElement],
  });

  function openPanel(panel: Panel): void {
    if (activePanel === panel) return;
    activePanel?.close();
    activePanel = panel;
    // Order matters (see file doc comment): the native view paints above the
    // document, so it must be collapsed first and hidden before the panel
    // takes the slot; the message row below stays visible either way.
    viewHost.setSuspended(true);
    viewHost.element.hidden = true;
    toolbar.setHostsPickerOpen(panel === picker);
    panel.setCloseable(pageLoaded);
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
    viewHost.element.hidden = false;
    viewHost.setSuspended(false);
  }

  const element = el('section', {
    attrs: { class: 'pane browser-pane', 'aria-label': 'Browser' },
    children: [toolbar.element, pagePanel],
  });

  return {
    element,
    panelHost: {
      open: openPanel,
      close: closeActivePanel,
      isActive: (panel) => activePanel === panel,
    },
    surfaceStatus,
    openHostsPicker(): void {
      openPanel(picker);
    },
    navigate(url: string): void {
      toolbar.navigateTo(url);
    },
    appendPanel(panel: Panel): void {
      viewSlot.append(panel.element);
    },
    setAgentPaneOpen(open: boolean): void {
      toolbar.setAgentPaneOpen(open);
    },
    update(state): void {
      toolbar.setAddressValue(state.addressValue);
      toolbar.setHostOptions(state.hostOptions);
      picker.setHostOptions(state.hostOptions);
      viewHost.reportBoundsNow();
    },
    dispose(): void {
      unsubscribeState();
      surfaceStatus.dispose();
      toolbar.dispose();
      picker.dispose();
      viewHost.dispose();
    },
  };
}
