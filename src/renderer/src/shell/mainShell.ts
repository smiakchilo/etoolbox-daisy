import { loadBrowserPaneFraction, saveBrowserPaneFraction } from '../lib/paneLayoutStore';
import { loadSettingsSnapshot } from '../lib/settingsClient';
import type { AppSettingsSnapshot } from '../../../shared';
import { createBrowserPane, type BrowserPane } from './browserPane';
import { createChatPane } from './chatPane';
import { createMainSplitView } from './mainSplitView';
import { DEFAULT_BROWSER_PANE_FRACTION } from './splitLayout';
import { createSettingsPanel, type SettingsPanel } from './settingsPanel';
import { buildHostOptions, computeAddressBarValue } from './viewModel';

export interface MountMainShellOptions {
  /**
   * Extra elements appended into the chat pane's one internally-scrolling
   * region (see `chatPane.ts`), rather than after the shell as document-level
   * siblings. Used by `main.ts` to keep its hello-button/app-info elements
   * mounted without letting them grow the document past the viewport - see
   * `styles/base.css` for the "document never scrolls" layout contract this
   * depends on.
   */
  readonly chatFooterContent?: readonly HTMLElement[];
}

/** Applies one loaded settings snapshot to the already-mounted browser pane. */
function applySnapshot(browserPane: BrowserPane, snapshot: AppSettingsSnapshot): void {
  const { servers, activeServerId } = snapshot;
  browserPane.update({
    addressValue: computeAddressBarValue(),
    hostOptions: buildHostOptions(servers, activeServerId),
  });
}

/**
 * Mounts the two-pane main window shell (requirements-decisions.md section
 * 8) into `root` and loads the initial settings snapshot.
 *
 * All DOM construction and insertion (the shell and any `chatFooterContent`)
 * happens synchronously, before the settings snapshot is awaited: nothing in
 * this function should delay `tests/e2e/app.spec.ts`'s visibility waits on
 * the hello-button/app-info elements behind an IPC round trip.
 */
export async function mountMainShell(
  root: HTMLElement,
  options?: MountMainShellOptions,
): Promise<void> {
  const browserPane = createBrowserPane();

  // Settings live in a whole-size panel on the browser pane (superseding the
  // separate child window). It is appended once, hidden, and revealed through
  // the pane's single-open panel host: `createSettingsPanel` starts its first
  // `loadSettingsSnapshot` immediately, so opening the panel for the first
  // time never waits on a cold IPC.
  const settingsPanel: SettingsPanel = createSettingsPanel({
    onSnapshotApplied(snapshot: AppSettingsSnapshot): void {
      applySnapshot(browserPane, snapshot);
    },
    // Dismissal is the panel's own close button or Escape: the browser-pane
    // panel host must hear about it too, because it is the host that holds
    // the active-panel reference and suspends/restores the native view.
    onDismiss() {
      browserPane.panelHost.close();
    },
  });
  browserPane.appendPanel(settingsPanel);

  const chatPane = createChatPane({
    onOpenSettings() {
      browserPane.panelHost.open(settingsPanel);
    },
  });
  if (options?.chatFooterContent) {
    chatPane.appendFooterContent(...options.chatFooterContent);
  }

  // The boundary the user can drag. Its position is restored from the last
  // run before the shell is inserted, so the window never renders at the
  // default split and then visibly jumps to the remembered one.
  const splitView = createMainSplitView(
    loadBrowserPaneFraction() ?? DEFAULT_BROWSER_PANE_FRACTION,
    {
      persist: saveBrowserPaneFraction,
    },
  );
  splitView.element.classList.add('main-shell');

  splitView.element.append(browserPane.element, chatPane.element);
  root.append(splitView.element);
  splitView.relayout();

  // The stored value is a fraction of the resizable width, so the browser
  // pane keeps its share of a resized window rather than its old pixel width;
  // this also re-applies the minimum-width clamp once the window is narrow
  // enough for it to bite.
  const shellResizeObserver = new ResizeObserver(() => splitView.relayout());
  shellResizeObserver.observe(splitView.element);

  const result = await loadSettingsSnapshot();
  if (result.ok) {
    applySnapshot(browserPane, result.snapshot);
    // Startup affordance: with configured hosts the picker leads with the
    // list ready to choose from (it replaces the otherwise blank page-view
    // region); with none, Settings is where the first server gets added.
    if (result.snapshot.servers.length > 0) {
      browserPane.openHostsPicker();
    } else {
      browserPane.panelHost.open(settingsPanel);
    }
  } else {
    console.warn('[daisy] failed to load settings snapshot:', result.error);
    // No usable host list - Settings is the discoverable surface for fixing
    // that, and its own reload will surface the load error in its status row.
    browserPane.panelHost.open(settingsPanel);
  }

  // Unsubscribes the toolbar's `onStateChanged`/`onSwitchStateChanged`
  // listeners, the settings panel's certificate-blocked subscription, and
  // the view host's resize observer/listener when this (single, app-lifetime)
  // window actually closes.
  window.addEventListener('unload', () => {
    shellResizeObserver.disconnect();
    splitView.dispose();
    browserPane.dispose();
    settingsPanel.dispose();
    chatPane.dispose();
  });
}
