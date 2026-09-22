import { loadBrowserPaneFraction, saveBrowserPaneFraction } from '../lib/paneLayoutStore';
import { isHostPageUrl, loadLastPageUrl, saveLastPageUrl } from '../lib/lastPageStore';
import { loadSettingsSnapshot } from '../lib/settingsClient';
import { type AppSettingsSnapshot } from '../../../shared';
import { createBrowserPane } from './browserPane';
import { createChatPane } from './chatPane';
import { createMainSplitView } from './mainSplitView';
import { DEFAULT_BROWSER_PANE_FRACTION } from './splitLayout';
import { createSettingsPanel, type SettingsPanel } from './settingsPanel';
import { buildHostOptions, computeAddressBarValue } from './viewModel';

/**
 * Mounts the two-pane main window shell (requirements-decisions.md section
 * 8) into `root` and loads the initial settings snapshot.
 *
 * All DOM construction and insertion happens synchronously, before the
 * settings snapshot is awaited: nothing in this function should delay the
 * shell's first paint behind an IPC round trip.
 */
export async function mountMainShell(root: HTMLElement): Promise<void> {
  // The boundary the user can drag. Its position is restored from the last
  // run before the shell is inserted, so the window never renders at the
  // default split and then visibly jumps to the remembered one. Created
  // before the panes so the browser toolbar's agent-pane toggle can reach it.
  const splitView = createMainSplitView(
    loadBrowserPaneFraction() ?? DEFAULT_BROWSER_PANE_FRACTION,
    {
      persist: saveBrowserPaneFraction,
    },
  );
  splitView.element.classList.add('main-shell');

  // The right (chat) pane starts visible; the toggle in the browser toolbar
  // flips it. The state is in-memory only (not persisted), so every launch
  // starts with the agent pane open.
  let agentPaneVisible = true;

  const browserPane = createBrowserPane({
    onToggleAgentPane(): void {
      agentPaneVisible = !agentPaneVisible;
      splitView.setAgentPaneVisible(agentPaneVisible);
      browserPane.setAgentPaneOpen(agentPaneVisible);
    },
  });

  // Settings live in a whole-size panel on the browser pane (superseding the
  // separate child window). It is appended once, hidden, and revealed through
  // the pane's single-open panel host: `createSettingsPanel` starts its first
  // `loadSettingsSnapshot` immediately, so opening the panel for the first
  // time never waits on a cold IPC.
  const settingsPanel: SettingsPanel = createSettingsPanel({
    onSnapshotApplied(snapshot: AppSettingsSnapshot): void {
      applySnapshot(snapshot);
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
    onOpenSettings(tab) {
      // Selecting before opening means the panel paints on the requested tab
      // with no first-frame flicker; no tab keeps the last selection.
      if (tab !== undefined) settingsPanel.selectTab(tab);
      browserPane.panelHost.open(settingsPanel);
    },
  });

  /**
   * The origins of the currently configured hosts, kept current by
   * `applySnapshot` and consulted when remembering the last opened page. Only
   * a page inside one of these is ever persisted (see `lastPageStore.ts`), so
   * an SSO hop through an IdP origin is never restored as the "last page".
   */
  let hostOrigins: readonly string[] = [];

  /**
   * Applies one loaded settings snapshot to the browser pane and hands the
   * chat pane the persisted per-provider flags. The chat pane derives which
   * agent is *actually* active (configured-and-eligible, else first eligible)
   * from those flags plus the live sign-in status, so it stays correct as auth
   * changes without the shell having to know the rule.
   */
  function applySnapshot(snapshot: AppSettingsSnapshot): void {
    const { hosts } = snapshot;
    hostOrigins = hosts.map((host) => host.origin);
    browserPane.update({
      addressValue: computeAddressBarValue(),
      hostOptions: buildHostOptions(hosts),
    });
    chatPane.setAgents(snapshot.agents);
  }

  // Remembers the last opened page for the next launch. Subscribing here
  // rather than in the toolbar keeps the address-bar view free of storage
  // concerns, and each `onStateChanged` listener is an independent
  // `ipcRenderer.on` subscription, so a second one is safe (see
  // `browserPane.ts`). A URL whose origin is not a configured host - an SSO
  // redirect, `about:blank`, a pending navigation to an unknown origin - is
  // ignored, so it never displaces the last real AEM page.
  const unsubscribeLastPage = window.daisy.browser.onStateChanged((state) => {
    if (hostOrigins.length === 0) return;
    if (isHostPageUrl(state.url, hostOrigins)) {
      saveLastPageUrl(state.url);
    }
  });

  /**
   * Re-opens the page remembered from the previous run, if there is one and it
   * still belongs to a configured host. Returns `true` when a restore was
   * attempted - including when the load itself failed, which the toolbar's
   * error row reports - so the startup affordance below does not also open the
   * hosts picker over it. A remembered origin that is no longer configured is
   * not attempted at all, so a deleted server falls back to the picker.
   */
  async function restoreLastPage(snapshot: AppSettingsSnapshot): Promise<boolean> {
    const url = loadLastPageUrl();
    if (url === undefined) return false;
    if (
      !isHostPageUrl(
        url,
        snapshot.hosts.map((host) => host.origin),
      )
    )
      return false;

    const outcome = await window.daisy.browser.navigate(url);
    return outcome.ok || outcome.error.code !== 'unknown_origin';
  }

  // The split view was created above (so the toolbar toggle could reach it);
  // its panes are appended here, once both exist, before it is inserted.
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
    applySnapshot(result.snapshot);
    // Restoring the last opened page takes precedence over the hosts picker,
    // so a returning user lands on the page they left. A page whose origin is
    // no longer a configured host is not attempted at all, so a deleted server
    // falls back to today's affordance.
    const restored = await restoreLastPage(result.snapshot);
    if (!restored) {
      // Startup affordance: with configured hosts the picker leads with the
      // list ready to choose from (it replaces the otherwise blank page-view
      // region); with none, Settings is where the first server gets added.
      if (result.snapshot.hosts.length > 0) {
        browserPane.openHostsPicker();
      } else {
        browserPane.panelHost.open(settingsPanel);
      }
    }
  } else {
    console.warn('[daisy] failed to load settings snapshot:', result.error);
    // No usable host list - Settings is the discoverable surface for fixing
    // that, and its own reload will surface the load error in its status row.
    browserPane.panelHost.open(settingsPanel);
  }

  // Unsubscribes the toolbar's `onStateChanged`/`onSwitchStateChanged`
  // listeners, this shell's own last-page subscription, the settings panel's
  // certificate-blocked subscription, and the view host's resize
  // observer/listener when this (single, app-lifetime) window actually closes.
  window.addEventListener('unload', () => {
    unsubscribeLastPage();
    shellResizeObserver.disconnect();
    splitView.dispose();
    browserPane.dispose();
    settingsPanel.dispose();
    chatPane.dispose();
  });
}
