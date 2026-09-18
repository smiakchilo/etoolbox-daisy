import { el } from '../lib/dom';
import { loadSettingsSnapshot } from '../lib/settingsClient';
import type { AppSettingsSnapshot } from '../../../shared';
import { createAuthenticationSection } from '../settings/authenticationSection';
import { createModelsSection } from '../settings/modelsSection';
import { createProxySection } from '../settings/proxySection';
import { createHostsSection } from '../settings/hostsSection';
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
 * components the window used to mount (hosts, proxy, authentication,
 * models) and the same re-fetch-on-change rhythm:
 * every section that mutates settings calls back into `reload`, which
 * re-reads the snapshot, re-renders the host/proxy sections,
 * refreshes the model pickers, and reports the fresh snapshot to the caller
 * so the shell's browser pane follows along in real time.
 *
 * The panel occupies the browser pane's page-view region while open (the
 * native view is suspended underneath by `browserPane.ts`'s panel host), so
 * it behaves like the hosts panel: one panel at a time, close button and
 * Escape dismiss it.
 *
 * Status is a single slot: the panel owns one banner (`statusBanner.ts`) the
 * sections share, and one save reporter that collapses the many debounced
 * saves into a single "Saving..." -> "Settings saved"/first-error sequence.
 * `reload` is guarded: a section with unpersisted edits is left untouched
 * (its in-progress input is not clobbered by a re-read), while the rest of
 * the snapshot - including the shell-facing callback - still refreshes.
 * Closing the panel flushes whatever is still pending instead of dropping it.
 */
export interface SettingsPanel extends Panel {
  /** Re-reads the settings snapshot and re-renders every section. */
  reload(): Promise<void>;
}

export interface CreateSettingsPanelOptions {
  /**
   * Fired after every successful settings reload with the freshly-read
   * snapshot, so the shell can re-apply it to the browser pane (address bar,
   * server options, insecure marker) without a second IPC round trip.
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

  const hostsSection = createHostsSection({
    status: banner,
    reportSave: reportWith,
    onSettingsChanged: () => void reload(),
  });
  const proxySection = createProxySection({
    onCredentialsChanged: () => void reload(),
    status: banner,
    reportSave: reportWith,
  });
  const authenticationSection = createAuthenticationSection(banner);
  const modelsSection = createModelsSection({ status: banner, reportSave: reportWith });

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
    if (!hostsSection.hasPendingEdits()) hostsSection.update(result.snapshot.servers);
    if (!proxySection.hasPendingEdits()) proxySection.update(result.snapshot.copilotProxy);
    // These two do their own IPC reads rather than rendering a projection of
    // the snapshot: the authentication section needs the live sign-in status,
    // and the models section needs the SDK catalogue and the live turn lock.
    //
    // The authentication status is read through `agent:get-auth-status`,
    // whose first call starts the real Copilot runtime and takes seconds,
    // so it must not gate the model catalogue or the snapshot callback. Its
    // refresh is kicked off here and awaited last; the section repaints
    // itself whenever it resolves.
    const authRefresh = authenticationSection.refresh();
    if (!modelsSection.hasPendingEdits()) await modelsSection.refresh();
    options.onSnapshotApplied(result.snapshot);
    await authRefresh;
  }

  /** Close-and-persist: surfaces what was about to be lost, then hands over to the panel. */
  async function flushPendingEdits(): Promise<void> {
    await hostsSection.flushNow();
    await proxySection.flushNow();
    await modelsSection.flushNow();
  }

  // The four sections become tab panels (AGENTS.md rule 1: Spectrum Web
  // Components only), their headings promoted to `<sp-tab>` labels so the
  // panel body no longer repeats the tab's title. The Hosts tab is the
  // default selection, matching the previous stacked layout's top position.
  const tabSections: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
    readonly element: HTMLElement;
  }> = [
    { value: 'servers', label: 'Hosts', element: hostsSection.element },
    { value: 'proxy', label: 'Copilot proxy', element: proxySection.element },
    { value: 'authentication', label: 'Authentication', element: authenticationSection.element },
    { value: 'models', label: 'Models', element: modelsSection.element },
  ];

  const tabs = el('sp-tabs', {
    attrs: { class: 'settings-panel__tabs', selected: 'servers', size: 'm' },
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
    dispose(): void {
      hostsSection.dispose();
      proxySection.dispose();
      modelsSection.dispose();
      banner.dispose();
      panel.dispose();
    },
  };
}
