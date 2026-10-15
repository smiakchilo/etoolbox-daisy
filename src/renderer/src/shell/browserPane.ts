import { el } from '../lib/dom';
import { createStatusBanner, type StatusBannerSink } from '../settings/statusBanner';
import { createBrowserToolbar } from './browserToolbar';
import { createBrowserViewHost } from './browserViewHost';
import { createHomeScreen, type HomeScreen } from './homeScreen';
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
   * The pane's home (welcome) screen - the base layer of the page-view region,
   * shown whenever no document is loaded and no panel is open. Exposed so the
   * shell can fill its app name/version and skill list from the sources it
   * already owns (`getAppInfo`/`listSkills`); the pane never loads those
   * itself.
   */
  readonly home: HomeScreen;
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
 * The page-view region is a three-way stack, only one layer ever visible:
 *
 *  - the native AEM `WebContentsView`, shown while a document is loaded;
 *  - the pane's **home (welcome) screen** (`homeScreen.ts`), shown while no
 *    document is loaded - the default state on a fresh profile and after a
 *    failed load with no page to restore, so the region is never blank;
 *  - a whole-size panel (`panelHost.open`), the only thing the renderer draws
 *    over the native view: a native view always composites *above* this
 *    document, so opening a panel suspends/collapses the native view and lets
 *    the DOM panel take its exact slot (`viewSlot`). The hosts panel
 *    ("combobox glyph" button in the toolbar) and the chat pane's
 *    Settings/History buttons all go through this one host.
 *
 * The native view is collapsed whenever it has no document to show
 * (`hasDocument` false, pushed by main), the user pressed the toolbar's Home
 * button, *or* a panel is open; the home screen fills the slot in the first two
 * cases. Because the home screen is always a valid thing to reveal, panels are
 * now always closeable: dismissing one shows the page if a document is loaded,
 * or the home screen if not - never a bare region.
 *
 * The two ways the home screen appears are treated differently. As the genuine
 * empty state (no document) it is simply the base layer with nothing to close.
 * As a *forced veil* over a loaded document (the Home button) it is not a page
 * and must not pretend to be one: `syncHomeChrome` blanks the address bar and
 * disables Back/Forward for as long as it is up, and the home screen gains a
 * close control that returns to the page underneath. Back is deliberately not
 * the way out - the veil is not a history position, so Back over it would
 * silently skip the covered page.
 */
export interface BrowserPaneCallbacks {
  /** Fired by the toolbar's agent-pane toggle; the shell hides/shows the chat pane. */
  readonly onToggleAgentPane?: () => void;
  /**
   * Opens Settings as the active panel. The shell owns the settings panel, so
   * it supplies this callback; the pane's home screen's "Open settings" action
   * invokes it.
   */
  readonly onOpenSettings?: () => void;
}

export function createBrowserPane(callbacks: BrowserPaneCallbacks = {}): BrowserPane {
  let activePanel: Panel | undefined;

  // Whether the AEM view currently holds a committed document (pushed by main
  // as `browser:state-changed`'s `hasDocument`). The native view is shown only
  // when this is true and no panel is open; otherwise the home screen (no
  // panel) or the panel takes the slot. False until the first commit, which is
  // exactly the fresh-profile / failed-first-load state the home screen exists
  // for.
  let hasDocument = false;

  // Set when the user presses the toolbar's Home button: the home screen is
  // shown even while a document is loaded, until the user navigates away. The
  // native view is only collapsed, never destroyed, so the loaded page and the
  // AEM bridge stay alive underneath.
  let homeForced = false;

  // The pane-owned status slot for the panels it hosts (Settings today). It is
  // created here, not by the panel, and lives in `pagePanel` below the view
  // slot so its feedback outlives a dismissed panel. `createStatusBanner`
  // defaults to the `surface-status-banner` surface class.
  const surfaceStatus = createStatusBanner();

  const picker = createHostsPanel({
    onSelect(origin: string): void {
      closeActivePanel();
      toolbar.navigateToHost(origin);
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
    onHomeClick(): void {
      showHome();
    },
    onNavigationStarted(): void {
      // An externally-caused navigation (a transcript link, a typed/selected
      // address, Back/Forward, Refresh) reveals the page: dismiss whatever
      // whole-size panel covers the page-view region, so the destination is
      // never hidden behind it. In-page navigation never reaches here - it only
      // produces `browser:state-changed` pushes - so a panel the user opened is
      // left alone while the AEM page navigates itself.
      const panelWasOpen = activePanel !== undefined;
      if (!panelWasOpen && !homeForced) return;
      homeForced = false;
      if (panelWasOpen) closeActivePanel();
      else updateViewVisibility();
      syncHomeChrome();
    },
    onToggleAgentPane(): void {
      callbacks.onToggleAgentPane?.();
    },
  });
  const viewHost = createBrowserViewHost();

  const home = createHomeScreen({
    onOpenHosts(): void {
      openPanel(picker);
    },
    onOpenSettings(): void {
      callbacks.onOpenSettings?.();
    },
    onClose(): void {
      // Dismiss the forced veil: reveal the page it was covering. Not a
      // navigation - the page was never navigated away from - so no
      // `onNavigationStarted` runs and the address/history chrome is restored
      // from the still-live page state.
      if (!homeForced) return;
      homeForced = false;
      updateViewVisibility();
      syncHomeChrome();
    },
  });

  // The pane tracks whether a document is loaded from the state feed: each
  // `onStateChanged` listener is an independent `ipcRenderer.on` subscription
  // (app-preload.ts), so subscribing here alongside the toolbar's own is safe.
  // Only a `hasDocument` change moves the view/home/panel stack, so a push that
  // merely updates the address does not re-run the visibility logic.
  const unsubscribeState = window.daisy.browser.onStateChanged((state) => {
    if (state.hasDocument === hasDocument) return;
    hasDocument = state.hasDocument;
    updateViewVisibility();
    syncHomeChrome();
  });

  // The slot the native view, the home screen and every whole-size panel share,
  // directly above the status/prompt row. Exactly one of the three is visible
  // at a time (see `updateViewVisibility`), and a panel *replaces* the region
  // rather than overlaying it - the exact rectangle the `WebContentsView`
  // occupies - so the message row below is never covered (see the file doc
  // comment). The picker's element also lives here; no panel is ever a sibling
  // of the row. The home screen is first so it sits at the bottom of the stack.
  const viewSlot = el('div', {
    attrs: { class: 'browser-view-slot', 'data-testid': 'browser-view-slot' },
    children: [home.element, viewHost.element, picker.element],
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

  /**
   * The one decision that drives the whole page-view stack: show the native
   * view when a document is loaded (and the user has not forced Home), the home
   * screen when none is or Home was forced, or the panel when one is open. Both
   * the native view and the home screen are `flex:1`, so exactly one may be
   * unhidden at a time or they would split the slot; the panel is a third,
   * equally exclusive state.
   */
  function updateViewVisibility(): void {
    const panelOpen = activePanel !== undefined;
    const showHomeLayer = !hasDocument || homeForced;
    const nativeVisible = !showHomeLayer && !panelOpen;
    const homeVisible = showHomeLayer && !panelOpen;
    viewHost.element.hidden = !nativeVisible;
    home.element.hidden = !homeVisible;
    // Collapsing the native view (rather than merely hiding its host element)
    // is what lets the DOM layer show: a native view composites above the
    // document regardless of z-order, so it must be sized to zero.
    viewHost.setSuspended(!nativeVisible);
  }

  /**
   * Reveals the home screen: closes any open panel and forces the home layer
   * even when a document is loaded, until the next user-initiated navigation
   * (`onNavigationStarted`) or an explicit close (`home.onClose`). The native
   * view is only collapsed, so the loaded page stays alive and the AEM bridge
   * keeps working.
   */
  function showHome(): void {
    homeForced = true;
    if (activePanel === undefined) updateViewVisibility();
    else closeActivePanel();
    syncHomeChrome();
  }

  /**
   * Reflects the forced-home state onto the two pieces of chrome that must not
   * pretend the welcome screen is a page: the toolbar (`setHomeShown` blanks
   * the address bar and disables Back/Forward) and the home screen's own close
   * control - offered only when there is a page underneath to return to. Both
   * derive from `homeForced && hasDocument`: with no document loaded the home
   * screen is the genuine empty state, so nothing is blanked or locked (a
   * failed load's address is left for the unknown-origin prompt that names it).
   * Both are re-synced wherever `homeForced`/`hasDocument` changes.
   */
  function syncHomeChrome(): void {
    const veil = homeForced && hasDocument;
    toolbar.setHomeShown(veil);
    home.setClosable(veil);
  }

  function openPanel(panel: Panel): void {
    if (activePanel === panel) return;
    activePanel?.close();
    activePanel = panel;
    // Order matters (see file doc comment): the native view paints above the
    // document, so it must be collapsed first; the message row below stays
    // visible either way.
    updateViewVisibility();
    toolbar.setHostsPickerOpen(panel === picker);
    panel.setCloseable(true);
    panel.open();
  }

  function closeActivePanel(): void {
    if (activePanel === undefined) return;
    const panel = activePanel;
    activePanel = undefined;
    // Hide the panel first (via its own close), then restore whichever of the
    // native view / home screen belongs in the slot, so the returning layer
    // never paints over a still-visible panel.
    panel.close();
    toolbar.setHostsPickerOpen(false);
    updateViewVisibility();
  }

  // Start on the home screen: no document is loaded yet.
  updateViewVisibility();
  syncHomeChrome();

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
    home,
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
      home.setHostsAvailable(state.hostOptions.length > 0);
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
