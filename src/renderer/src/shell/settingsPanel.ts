import { el } from '../lib/dom';
import { loadSettingsSnapshot } from '../lib/settingsClient';
import type { AppSettingsSnapshot } from '../../../shared';
import { createAuthenticationSection } from '../settings/authenticationSection';
import { createModelsSection } from '../settings/modelsSection';
import { createProxySection } from '../settings/proxySection';
import { createServersSection } from '../settings/serversSection';
import { createPanel, type Panel } from './panel';

/**
 * The Settings surface as a whole-size panel (`panel.ts`), superseding the
 * separate Settings child window (`requirements-decisions.md` section 8, as
 * deviated - see `docs/handoff-steps-09-12.md`). It reuses the same section
 * components the window used to mount (servers, proxy, authentication,
 * models) and the same re-fetch-on-change rhythm:
 * every section that mutates settings calls back into `reload`, which
 * re-reads the snapshot, re-renders the server/proxy sections,
 * refreshes the model pickers, and reports the fresh snapshot to the caller
 * so the shell's browser pane follows along in real time.
 *
 * The panel occupies the browser pane's page-view region while open (the
 * native view is suspended underneath by `browserPane.ts`'s panel host), so
 * it behaves like the hosts panel: one panel at a time, close button and
 * Escape dismiss it.
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
  const serversSection = createServersSection(() => void reload());
  const proxySection = createProxySection(() => void reload());
  const authenticationSection = createAuthenticationSection();
  const modelsSection = createModelsSection();

  const statusLine = el('p', { attrs: { class: 'settings-panel__status' } });
  const reloadButton = el('sp-button', { attrs: { variant: 'secondary' }, text: 'Reload' });

  async function reload(): Promise<void> {
    const result = await loadSettingsSnapshot();
    if (!result.ok) {
      statusLine.textContent = `Failed to load settings: ${result.error.message}`;
      return;
    }
    statusLine.textContent = '';
    serversSection.update(result.snapshot.servers);
    proxySection.update(result.snapshot.copilotProxy);
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
    await modelsSection.refresh();
    options.onSnapshotApplied(result.snapshot);
    await authRefresh;
  }

  reloadButton.addEventListener('click', () => void reload());

  // The four sections become tab panels (AGENTS.md rule 1: Spectrum Web
  // Components only), their headings promoted to `<sp-tab>` labels so the
  // panel body no longer repeats the tab's title. The Servers tab is the
  // default selection, matching the previous stacked layout's top position.
  const tabSections: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
    readonly element: HTMLElement;
  }> = [
    { value: 'servers', label: 'Servers', element: serversSection.element },
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

  const content = el('div', {
    attrs: { class: 'settings-panel__content' },
    children: [statusLine, tabs],
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
    close: () => panel.close(),
    setCloseable: (closeable) => panel.setCloseable(closeable),
    reload,
    dispose(): void {
      panel.dispose();
    },
  };
}
