import { loadBrowserPaneFraction, saveBrowserPaneFraction } from '../lib/paneLayoutStore';
import { loadSettingsSnapshot } from '../lib/settingsClient';
import type { AppSettingsSnapshot } from '../../../shared';
import { createBrowserPane, type BrowserPane } from './browserPane';
import { createChatPane } from './chatPane';
import { createMainSplitView } from './mainSplitView';
import { DEFAULT_BROWSER_PANE_FRACTION } from './splitLayout';
import { buildServerOptions, computeAddressBarValue, computeInsecureMarker } from './viewModel';

export interface MountMainShellOptions {
  /**
   * Extra elements appended into the chat pane's one internally-scrolling
   * region (see `chatPane.ts`), rather than after the shell as document-level
   * siblings. Used by `main.ts` to keep its hello-button/app-info elements
   * mounted without letting them grow the document past the viewport - see
   * `styles/shell.css` for the "document never scrolls" layout contract this
   * depends on.
   */
  readonly chatFooterContent?: readonly HTMLElement[];
}

/** Applies one loaded settings snapshot to the already-mounted browser pane. */
function applySnapshot(browserPane: BrowserPane, snapshot: AppSettingsSnapshot): void {
  const { servers, activeServerId } = snapshot;
  browserPane.update({
    addressValue: computeAddressBarValue(),
    serverOptions: buildServerOptions(servers, activeServerId),
    insecureMarker: computeInsecureMarker(servers, activeServerId),
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
  const chatPane = createChatPane();
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
  } else {
    // Leave the panes in their empty/no-server state; surfacing this error
    // more prominently is out of scope for step 05's initial shell.
    console.warn('[daisy] failed to load settings snapshot:', result.error);
  }

  // Settings are edited only from the separate Settings window (requirements
  // -decisions.md section 8), so re-poll on focus rather than pushing a
  // change event - there is no settings-changed IPC channel yet either.
  window.addEventListener('focus', () => {
    void loadSettingsSnapshot().then((refreshed) => {
      if (refreshed.ok) applySnapshot(browserPane, refreshed.snapshot);
    });
  });

  // Unsubscribes the toolbar's `onStateChanged`/`onSwitchStateChanged`
  // listeners and the view host's resize observer/listener when this
  // (single, app-lifetime) window actually closes.
  window.addEventListener('unload', () => {
    shellResizeObserver.disconnect();
    splitView.dispose();
    browserPane.dispose();
    chatPane.dispose();
  });
}
