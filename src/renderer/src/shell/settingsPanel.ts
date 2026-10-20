import { el } from '../lib/dom';
import { loadSettingsSnapshot } from '../lib/settingsClient';
import type { AppSettingsSnapshot } from '../../../shared';
import { createAgentsSection } from '../settings/agentsSection';
import { createProjectsSection } from '../settings/projectsSection';
import { createProxiesSection } from '../settings/proxiesSection';
import { createHostsSection } from '../settings/hostsSection';
import { createBrowserSection } from '../settings/browserSection';
import { createSkillsSection } from '../settings/skillsSection';
import { createUpdatesSection } from '../settings/updatesSection';
import {
  createSaveReporter,
  reportSave,
  type SaveOutcome,
  type StatusBannerSink,
} from '../settings/statusBanner';
import { createPanel, type Panel } from './panel';

/**
 * The Settings surface as a whole-size panel (`panel.ts`), superseding the
 * separate Settings child window (`requirements-decisions.md` section 8, as
 * deviated). It reuses the same section
 * components the window used to mount (hosts, projects, agents, proxies) and
 * the same re-fetch-on-change rhythm:
 * every section that mutates settings calls back into `reload`, which
 * re-reads the snapshot, re-renders the host/project/proxy sections,
 * refreshes the Agents tab, and reports the fresh snapshot to the caller
 * so the shell's browser pane follows along in real time.
 *
 * The panel occupies the browser pane's page-view region while open (the
 * native view is suspended underneath by `browserPane.ts`'s panel host), so
 * it behaves like the hosts panel: one panel at a time, close button and
 * Escape dismiss it.
 *
 * Status is a single slot the *pane* owns (`browserPane.surfaceStatus`,
 * `statusBanner.ts`): the sections share it, and one save reporter collapses
 * the many concurrent saves into a single "Saving..." -> "Settings
 * saved"/first-error sequence. The panel is handed that sink rather than
 * creating a banner, so the feedback outlives the panel's dismissal.
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
export type SettingsTab =
  'hosts' | 'projects' | 'agents' | 'skills' | 'proxies' | 'browser' | 'updates';

export interface CreateSettingsPanelOptions {
  /**
   * The pane-owned status slot (the browser pane's `surfaceStatus`). It lives
   * in the pane, below the view slot, so save feedback survives the panel
   * being dismissed; the panel must not own a banner of its own.
   */
  readonly status: StatusBannerSink;
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
  const status = options.status;

  // One reporter for every section's saves. The handlers never disturb a
  // showing prompt: the banner's priority already stops a prompt being
  // displaced by an error/status, and here a *new* save batch does not
  // interrupt an actionable prompt either.
  const saveReporter = createSaveReporter({
    onPendingStart(): void {
      if (status.isPromptShowing?.() === true) return;
      status.clear();
      status.showStatus('Saving\u2026');
    },
    onDrained(firstError: string | undefined): void {
      if (status.isPromptShowing?.() === true) return;
      if (firstError !== undefined) status.showError(firstError);
      else status.showStatus('Settings saved');
    },
  });

  function reportWith(outcome: Promise<SaveOutcome>): void {
    reportSave(saveReporter, outcome);
  }

  const agentsSection = createAgentsSection({
    status,
    reportSave: reportWith,
    onSettingsChanged: () => void reload(),
  });
  const hostsSection = createHostsSection({
    status,
    reportSave: reportWith,
    onSettingsChanged: () => void reload(),
  });
  const proxiesSection = createProxiesSection({
    onSettingsChanged: () => void reload(),
    status,
    reportSave: reportWith,
  });
  const projectsSection = createProjectsSection({
    onSettingsChanged: () => void reload(),
    status,
    reportSave: reportWith,
  });
  const browserSection = createBrowserSection({
    status,
    reportSave: reportWith,
    onSettingsChanged: () => void reload(),
  });

  const skillsSection = createSkillsSection({
    status,
    reportSave: reportWith,
    onSettingsChanged: () => void reload(),
  });

  const updatesSection = createUpdatesSection({
    status,
    reportSave: reportWith,
    onSettingsChanged: () => void reload(),
  });

  async function reload(): Promise<void> {
    const result = await loadSettingsSnapshot();
    if (!result.ok) {
      status.showError(`Failed to load settings: ${result.error.message}`);
      return;
    }
    // A section with unpersisted edits keeps what it has on screen rather
    // than being clobbered by a re-read; everything else follows the fresh
    // snapshot. The shell-facing callback always fires (the address bar and
    // server options should follow the committed state immediately).
    // The hosts section is always told about the latest proxies: its Proxy
    // combobox must reflect library changes even when a host edit is pending.
    // The hosts section is always told about the latest proxies and projects:
    // its Proxy/Project comboboxes must reflect library changes even when a
    // host edit is pending.
    hostsSection.update(result.snapshot.hosts, result.snapshot.proxies, result.snapshot.projects);
    if (!proxiesSection.hasPendingEdits()) proxiesSection.update(result.snapshot.proxies);
    if (!projectsSection.hasPendingEdits()) projectsSection.update(result.snapshot.projects);
    browserSection.update(result.snapshot);
    skillsSection.update(result.snapshot);
    updatesSection.update(result.snapshot);
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
    await projectsSection.flushNow();
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
    { value: 'projects', label: 'Projects', element: projectsSection.element },
    { value: 'agents', label: 'Agents', element: agentsSection.element },
    { value: 'skills', label: 'Skills', element: skillsSection.element },
    // Proxies sits ahead of Browser: the library is where entries are defined,
    // and the browser's "(Default)" proxy points at one of them, so the
    // definition reads naturally before the setting that consumes it.
    { value: 'proxies', label: 'Proxies', element: proxiesSection.element },
    { value: 'browser', label: 'Browser', element: browserSection.element },
    { value: 'updates', label: 'Updates', element: updatesSection.element },
  ];

  const tabs = el('sp-tabs', {
    attrs: { class: 'settings-panel__tabs', selected: 'hosts', size: 'm' },
    children: [
      ...tabSections.map(({ value, label }) =>
        el('sp-tab', { attrs: { value, 'data-testid': `settings-tab-${value}` }, text: label }),
      ),
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
    testId: 'settings-panel',
    closeButtonClassName: 'settings-panel__close',
    content,
    onDismiss(): void {
      options.onDismiss();
    },
  });

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
      projectsSection.dispose();
      agentsSection.dispose();
      skillsSection.dispose();
      browserSection.dispose();
      updatesSection.dispose();
      panel.dispose();
    },
  };
}
