import { el } from '../lib/dom';
import { loadSettingsSnapshot } from '../lib/settingsClient';
import { createAuthenticationSection } from './authenticationSection';
import { createCertificatesSection } from './certificatesSection';
import { createModelsSection } from './modelsSection';
import { createProxySection } from './proxySection';
import { createServersSection } from './serversSection';

/**
 * Mounts the Settings window's content (requirements-decisions.md section
 * 8: a separate local child window, distinct from the main window's shell).
 */
export async function mountSettingsShell(root: HTMLElement): Promise<void> {
  const statusLine = el('p', { attrs: { class: 'settings-shell__status' } });
  const reloadButton = el('sp-button', { attrs: { variant: 'secondary' }, text: 'Reload' });

  async function reload(): Promise<void> {
    const result = await loadSettingsSnapshot();
    if (!result.ok) {
      statusLine.textContent = `Failed to load settings: ${result.error.message}`;
      return;
    }
    statusLine.textContent = '';
    serversSection.update(result.snapshot.servers);
    certificatesSection.update(result.snapshot.servers);
    proxySection.update(result.snapshot.copilotProxy);
    // Its own IPC read, not a projection of the snapshot: the model section
    // needs the SDK catalogue and the live turn lock, neither of which the
    // settings document contains.
    await modelsSection.refresh();
  }

  const serversSection = createServersSection(() => void reload());
  const certificatesSection = createCertificatesSection(() => void reload());
  const proxySection = createProxySection(() => void reload());
  const authenticationSection = createAuthenticationSection();
  const modelsSection = createModelsSection();

  reloadButton.addEventListener('click', () => void reload());

  const shell = el('div', {
    attrs: { class: 'settings-shell' },
    children: [
      el('header', {
        attrs: { class: 'settings-shell__header' },
        children: [el('h1', { text: 'Settings' }), reloadButton],
      }),
      statusLine,
      serversSection.element,
      proxySection.element,
      authenticationSection.element,
      certificatesSection.element,
      modelsSection.element,
    ],
  });
  root.append(shell);

  // Unsubscribes the certificates section's `onCertificateBlocked` listener
  // when this (single, window-lifetime) Settings window actually closes.
  window.addEventListener('unload', () => {
    certificatesSection.dispose();
  });

  await reload();
}
