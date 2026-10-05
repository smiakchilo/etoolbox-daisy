import { el } from '../lib/dom';
import { loadSettingsSnapshot } from '../lib/settingsClient';
import type { AppSettingsSnapshot } from '../../../shared';
import { createAgentsSection } from '../settings/agentsSection';
import { createProxiesSection } from '../settings/proxiesSection';
import { createHostsSection } from '../settings/hostsSection';
import { createBrowserSection } from '../settings/browserSection';
import {
  createSaveReporter,
  createStatusBanner,
  reportSave,
  type SaveOutcome,
} from '../settings/statusBanner';
import { createPanel, type Panel } from './panel';

/**
 * The Settings surface as a whole-size panel (`panel.ts`), superseding the
 * separate Settings child window (`requirements-decisions.md` section 8, as
 * deviated - see `docs/handoff-steps-09-12.md`). It reuses the same section
 * components the window used to mount (hosts, agents, proxies) and the same
 * re-fetch-on-change rhythm:
 * every section that mutates settings calls back into `reload`, which
 * re-reads the snapshot, re-renders the host/proxy sections,
 * refreshes the Agents tab, and reports the fresh snapshot to the caller
 * so the shell's browser pane follows along in real time.
 *
 * The panel occupies the browser pane's page-view region while open (the
 * native view is suspended underneath by `browserPane.ts`'s panel host), so
 * it behaves like the hosts panel: one panel at a time, close button and
 * Escape dismiss it.
 *
 * Status is a single slot: the panel owns one banner (`statusBanner.ts`) the
 * sections share, and one save reporter that collapses the many concurrent
 * saves into a single "Saving..." -> "Settings saved"/first-error sequence.
 * `reload` is guarded: a section with unpersisted edits is left untouched
 * (its in-progress input is not clobbered by a re-read), while the rest of
 * the snapshot - including the shell-facing callback - still refreshes.
 * Closing the panel flushes whatever is still pending instead of dropping it.
 */
export interface SettingsPanel extends Panel {
  /** Re-reads the settings snapshot and re-renders every section. */
  reload(): Promise<void>;
  /**
   * Selects the tab shown next (and now, if the panel is already open). Used
   * by the chat pane's "activate an agent" banner to land directly on Agents.
   */
  selectTab(tab: SettingsTab): void;
}

/** The Settings panel's tab ids, in strip order. */
export type SettingsTab = 'hosts' | 'agents' | 'proxies' | 'browser';

export interface CreateSettingsPanelOptions {
  /**
   * Fired after every successful settings reload with the freshly-read
   * snapshot, so the shell can re-apply it to the browser pane (address bar,
   * server options) without a second IPC round trip.
   */
  onSnapshotApplied(snapshot: AppSettingsSnapshot): void;
  /**
   * Fired when the panel's own close button or Escape dismisses it, so the
   * shell can unwire the browser-pane panel host (restore the suspended
   * native view and clear the pane's active-panel reference). Without this
   * the pane keeps pointing at a panel the user already closed, so the
   * native view stays collapsed and re-opening the panel short-circuits.
   */
  onDismiss(): void;
}

export function createSettingsPanel(options: CreateSettingsPanelOptions): SettingsPanel {
  const banner = createStatusBanner();

  // One reporter for every section's saves. The handlers never disturb a
  // showing prompt: the banner's priority already stops a prompt being
  // displaced by an error/status, and here a *new* save batch does not
  // interrupt an actionable prompt either.
  const saveReporter = createSaveReporter({
    onPendingStart(): void {
      if (banner.isPromptShowing()) return;
      banner.clear();
      banner.showStatus('Saving\u2026');
    },
    onDrained(firstError: string | undefined): void {
      if (banner.isPromptShowing()) return;
      if (firstError !== undefined) banner.showError(firstError);
      else banner.showStatus('Settings saved');
    },
  });

  function reportWith(outcome: Promise<SaveOutcome>): void {
    reportSave(saveReporter, outcome);
  }

  const agentsSection = createAgentsSection({
    status: banner,
    reportSave: reportWith,
    onSettingsChanged: () => void reload(),
  });
  const hostsSection = createHostsSection({
    status: banner,
    reportSave: reportWith,
    onSettingsChanged: () => void reload(),
  });
  const proxiesSection = createProxiesSection({
    onSettingsChanged: () => void reload(),
    status: banner,
    reportSave: reportWith,
  });
  const browserSection = createBrowserSection({
    status: banner,
    reportSave: reportWith,
    onSettingsChanged: () => void reload(),
  });

  async function reload(): Promise<void> {
    const result = await loadSettingsSnapshot();
    if (!result.ok) {
      banner.showError(`Failed to load settings: ${result.error.message}`);
      return;
    }
    // A section with unpersisted edits keeps what it has on screen rather
    // than being clobbered by a re-read; everything else follows the fresh
    // snapshot. The shell-facing callback always fires (the address bar and
    // server options should follow the committed state immediately).
    // The hosts section is always told about the latest proxies: its Proxy
    // combobox must reflect library changes even when a host edit is pending.
    hostsSection.update(result.snapshot.hosts, result.snapshot.proxies);
    if (!proxiesSection.hasPendingEdits()) proxiesSection.update(result.snapshot.proxies);
    browserSection.update(result.snapshot);
    // The Agents tab does its own IPC reads rather than rendering a projection
    // of the snapshot: it needs the live sign-in status and the active agent's
    // SDK catalogue. That first auth read starts the real Copilot runtime and
    // takes seconds, so it must not gate the snapshot callback; it is kicked
    // off here and awaited last, and the section repaints itself whenever it
    // resolves.
    const agentsRefresh = agentsSection.refresh(result.snapshot);
    options.onSnapshotApplied(result.snapshot);
    await agentsRefresh;
  }

  /** Close-and-persist: surfaces what was about to be lost, then hands over to the panel. */
  async function flushPendingEdits(): Promise<void> {
    await hostsSection.flushNow();
    await proxiesSection.flushNow();
    await agentsSection.flushNow();
  }

  // The sections become tab panels (AGENTS.md rule 1: Spectrum Web
  // Components only), their headings promoted to `<sp-tab>` labels so the
  // panel body no longer repeats the tab's title. The Hosts tab is the
  // default selection, matching the previous stacked layout's top position.
  const tabSections: ReadonlyArray<{
    readonly value: SettingsTab;
    readonly label: string;
    readonly element: HTMLElement;
  }> = [
    { value: 'hosts', label: 'Hosts', element: hostsSection.element },
    { value: 'agents', label: 'Agents', element: agentsSection.element },
    // Browser sits ahead of Proxies: the default proxy is a property of the
    // browser pane, and a host's Proxy combobox offers "(Default)" which points
    // at it, so it reads naturally before the library it draws from.
    { value: 'browser', label: 'Browser', element: browserSection.element },
    { value: 'proxies', label: 'Proxies', element: proxiesSection.element },
  ];

  const tabs = el('sp-tabs', {
    attrs: { class: 'settings-panel__tabs', selected: 'hosts', size: 'm' },
    children: [
      ...tabSections.map(({ value, label }) => el('sp-tab', { attrs: { value }, text: label })),
      ...tabSections.map(({ value, element }) =>
        el('sp-tab-panel', {
          attrs: { class: 'settings-panel__tab-panel', value },
          children: [element],
        }),
      ),
    ],
  });

  // The tab strip and its panels are the only content column children.
  const content = el('div', {
    attrs: { class: 'settings-panel__content' },
    children: [tabs],
  });

  const panel = createPanel({
    title: 'Settings',
    closeAriaLabel: 'Close settings',
    surfaceClassName: 'settings-panel',
    closeButtonClassName: 'settings-panel__close',
    content,
    onDismiss(): void {
      options.onDismiss();
    },
  });

  // Single status slot, appended to the panel surface and pinned to its
  // bottom edge (settings.css keeps it out of the layout flow): like the
  // browser pane's status row, a prompt or an error raised from any section
  // is visible regardless of the active tab, and never reflows the tabs.
  panel.element.append(banner.element);

  // No eager reload at construction: the panel is created at shell startup,
  // and its refresh chain reads live IPCs (including `agent:get-auth-status`,
  // whose first call starts the real Copilot runtime). Opening the panel
  // reloads, which is exactly what the superseded Settings window did - a
  // fresh page load on every open.
  return {
    get element() {
      return panel.element;
    },
    get isOpen() {
      return panel.isOpen;
    },
    open: () => {
      panel.open();
      void reload();
    },
    close: () => {
      // Fire-and-forget: the flush outlives the panel surface. Nothing on
      // screen depends on the close point, so closing never waits on IPC.
      void flushPendingEdits();
      panel.close();
    },
    setCloseable: (closeable) => panel.setCloseable(closeable),
    reload,
    selectTab(tab: SettingsTab): void {
      // `sp-tabs` reads its selection from the `selected` attribute (the same
      // way it is seeded with `hosts` above); setting it before `open()` means
      // the panel paints on the requested tab with no first-frame flicker.
      tabs.setAttribute('selected', tab);
    },
    dispose(): void {
      hostsSection.dispose();
      proxiesSection.dispose();
      agentsSection.dispose();
      browserSection.dispose();
      banner.dispose();
      panel.dispose();
    },
  };
}
