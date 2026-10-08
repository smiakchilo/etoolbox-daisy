import { loadBrowserPaneFraction, saveBrowserPaneFraction } from '../lib/paneLayoutStore';
import { isHostPageUrl, loadLastPageUrl, saveLastPageUrl } from '../lib/lastPageStore';
import { clearLastChat, loadLastChat, saveLastChat } from '../lib/lastChatStore';
import { loadSettingsSnapshot } from '../lib/settingsClient';
import { parseNavigationTarget, type AppSettingsSnapshot, type ServerId } from '../../../shared';
import { createBrowserPane } from './browserPane';
import { createChatPane, type StartupConversation } from './chatPane';
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
    // The home screen's "Open settings" action. The shell owns the settings
    // panel, which is created just below; the callback closes over it and only
    // runs on a user click, long after both exist.
    onOpenSettings(): void {
      browserPane.panelHost.open(settingsPanel);
    },
  });

  // Settings live in a whole-size panel on the browser pane (superseding the
  // separate child window). It is appended once, hidden, and revealed through
  // the pane's single-open panel host: `createSettingsPanel` starts its first
  // `loadSettingsSnapshot` immediately, so opening the panel for the first
  // time never waits on a cold IPC.
  const settingsPanel: SettingsPanel = createSettingsPanel({
    // The pane owns the status row so save feedback survives the panel closing.
    status: browserPane.surfaceStatus,
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

  // Fill the home screen's slower data off the first-paint path: the pane
  // builds the screen synchronously with a static name and a "Loading skills…"
  // row, and these populate it a beat later. Both are best-effort - a failure
  // simply leaves the static fallback in place.
  void window.daisy
    .getAppInfo()
    .then((info) => {
      browserPane.home.setAppInfo(info);
    })
    .catch(() => undefined);
  void window.daisy.agentChat
    .listSkills()
    .then((result) => {
      if (result.ok) browserPane.home.setSkills(result.skills);
    })
    .catch(() => undefined);

  // Started before the panes are built so the first settings round trip is
  // already in flight while the DOM is constructed; awaited further below and
  // shared with the startup-chat resolver, which needs the same snapshot.
  const snapshotPromise = loadSettingsSnapshot();

  const chatPane = createChatPane({
    onOpenSettings(tab) {
      // Selecting before opening means the panel paints on the requested tab
      // with no first-frame flicker; no tab keeps the last selection.
      if (tab !== undefined) settingsPanel.selectTab(tab);
      browserPane.panelHost.open(settingsPanel);
    },
    // A chat link is a browser navigation: route it through the browser pane
    // so that pane owns the load and, on failure, its error row (with Reload)
    // plus the restore-or-hosts-picker fallback - never the chat pane's banner.
    onNavigateInBrowser(url) {
      browserPane.navigate(url);
    },
    resolveStartupConversation,
    onConversationUsed(chatId, sdkSessionId) {
      // The server-match gate reads this back: a chat is only worth remembering
      // when it was used against a configured host, and only that host's page
      // will restore it. No active host means no restore, matching "the page
      // wins".
      const serverId = activeServerId();
      if (serverId === undefined) return;
      saveLastChat({ chatId, sdkSessionId, serverId });
    },
    onConversationUnavailable() {
      clearLastChat();
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
   * The configured hosts, kept current by `applySnapshot`. Consulted to resolve
   * the pane's current page back to its `ServerId` - the value the last-chat
   * pointer records and the server-match gate compares against.
   */
  let hosts: AppSettingsSnapshot['hosts'] = [];

  // The URL the AEM pane last reported, kept so the link context can be
  // re-derived when the *host list* changes (a settings edit) without a new
  // navigation event.
  let lastPaneUrl: string | undefined;

  /**
   * The origin of the pane's current page, but only when it is a configured
   * host - the only origin a relative message path can be resolved against. An
   * `about:blank` start, an SSO/IdP hop, or a page on a since-removed host all
   * yield `undefined`, which is what keeps a relative path plain text.
   */
  function deriveActiveOrigin(): string | undefined {
    if (lastPaneUrl === undefined) return undefined;
    const target = parseNavigationTarget(lastPaneUrl);
    if (!target.ok) return undefined;
    return hostOrigins.includes(target.origin) ? target.origin : undefined;
  }

  /** The configured host the pane is currently showing, if any - see `deriveActiveOrigin`. */
  function activeServerId(): ServerId | undefined {
    const origin = deriveActiveOrigin();
    if (origin === undefined) return undefined;
    return hosts.find((host) => host.origin === origin)?.id;
  }

  /** Pushes the current host/pane context to the chat pane; it repaints only on a real change. */
  function publishLinkContext(): void {
    chatPane.setLinkContext({ hostOrigins, activeOrigin: deriveActiveOrigin() });
  }

  /**
   * Applies one loaded settings snapshot to the browser pane and hands the
   * chat pane the persisted per-provider flags. The chat pane derives which
   * agent is *actually* active (configured-and-eligible, else none) from those
   * flags plus the live sign-in status, so it stays correct as auth
   * changes without the shell having to know the rule.
   */
  function applySnapshot(snapshot: AppSettingsSnapshot): void {
    hosts = snapshot.hosts;
    hostOrigins = snapshot.hosts.map((host) => host.origin);
    browserPane.update({
      addressValue: computeAddressBarValue(),
      hostOptions: buildHostOptions(snapshot.hosts),
    });
    chatPane.setAgents(snapshot.agents);
    publishLinkContext();
  }

  // Remembers the last opened page for the next launch. Subscribing here
  // rather than in the toolbar keeps the address-bar view free of storage
  // concerns, and each `onStateChanged` listener is an independent
  // `ipcRenderer.on` subscription, so a second one is safe (see
  // `browserPane.ts`). A URL whose origin is not a configured host - an SSO
  // redirect, `about:blank`, a pending navigation to an unknown origin - is
  // ignored, so it never displaces the last real AEM page.
  const unsubscribeLastPage = window.daisy.browser.onStateChanged((state) => {
    lastPaneUrl = state.url;
    publishLinkContext();
    if (hostOrigins.length === 0) return;
    if (isHostPageUrl(state.url, hostOrigins)) {
      saveLastPageUrl(state.url);
    }
  });

  /**
   * Re-opens the page remembered from the previous run, if there is one and it
   * still belongs to a configured host. Returns `true` when a restore was
   * attempted - including when the load itself failed, because the browser pane
   * owns that failure (its error row with Reload, and the home screen as the
   * no-document fallback). A remembered origin that is no longer configured is
   * not attempted at all, so a deleted server leaves the pane on its home
   * screen.
   *
   * Deliberately routed through `browserPane.navigate` rather than a bare
   * `browser:navigate`: a dead remembered page must not be the one silent
   * blank page left in the app.
   */
  function restoreLastPage(snapshot: AppSettingsSnapshot): boolean {
    const url = loadLastPageUrl();
    if (url === undefined) return false;
    if (
      !isHostPageUrl(
        url,
        snapshot.hosts.map((host) => host.origin),
      )
    )
      return false;

    browserPane.navigate(url);
    return true;
  }

  /**
   * Decides which conversation, if any, to restore on startup, and returns it
   * with its journal so the chat pane can repaint it.
   *
   * The gate is the same "page wins" rule the shell already applies to the last
   * URL: a chat is restored only when the remembered page's origin is a
   * configured host AND the chat was last used against that same host. A chat
   * recorded against a different server is left alone - cross-server selection
   * belongs to History - so the pane never resumes a conversation against the
   * wrong target.
   *
   * Returns `undefined` for every "nothing to restore" case (no pointer, no
   * page, an unknown origin, a foreign server, a missing journal): the pane then
   * starts a fresh chat, exactly as before this feature.
   */
  async function resolveStartupConversation(): Promise<StartupConversation | undefined> {
    const record = loadLastChat();
    if (record === undefined) return undefined;
    const pageUrl = loadLastPageUrl();
    if (pageUrl === undefined) return undefined;
    const target = parseNavigationTarget(pageUrl);
    if (!target.ok) return undefined;

    const loaded = await snapshotPromise;
    if (!loaded.ok) return undefined;
    const host = loaded.snapshot.hosts.find((candidate) => candidate.origin === target.origin);
    if (host === undefined || host.id !== record.serverId) return undefined;

    const journal = await window.daisy.agentChat.readJournal({ chatId: record.chatId });
    if (!journal.ok) return undefined;

    return { chatId: record.chatId, sdkSessionId: record.sdkSessionId, records: journal.records };
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

  const result = await snapshotPromise;
  if (result.ok) {
    applySnapshot(result.snapshot);
    // Restoring the last opened page takes precedence over the hosts picker, so
    // a returning user lands on the page they left. When there is no page to
    // restore, a configured-host profile keeps its long-standing startup
    // affordance: the picker leads with the list ready to choose from. It no
    // longer *covers a blank region* - the home screen sits beneath it, so
    // dismissing the picker reveals the home screen, not a bare view. A profile
    // with no hosts gets the home screen alone (its Settings action is the way
    // to add the first host); nothing is auto-opened to cover a gap.
    const restored = restoreLastPage(result.snapshot);
    if (!restored && result.snapshot.hosts.length > 0) {
      browserPane.openHostsPicker();
    }
  } else {
    console.warn('[daisy] failed to load settings snapshot:', result.error);
    // No usable host list: the home screen is the landing surface, and its
    // "Open settings" action leads to the panel whose own reload surfaces the
    // load error in its status row.
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
