import { el } from '../lib/dom';
import type { AppSettingsSnapshot, ProxyId, ProxySnapshot } from '../../../shared';
import { createProxyPicker, type ProxySelection } from './proxyPicker';
import type { SaveOutcome, StatusBannerSink } from './statusBanner';

/**
 * The Settings panel's Browser tab: browser-pane behaviour that is not about a
 * host, a proxy entry, or the agent.
 *
 * Two controls:
 *
 *  - **Default proxy** (first) - the entry of the "Proxies" library the AEM
 *    pane uses for any origin that is not one of the configured hosts (for
 *    example Adobe's IMS login origin during an SSO redirect). Backed by
 *    `browser.proxy`; "(No proxy)" clears it (direct). It is rendered with the
 *    same picker the Hosts tab uses, but without a "(Default)" choice - it *is*
 *    the default.
 *  - **Suppress the Windows security-key prompt** - `browser.disableNativeWebAuthn`
 *    (default `true`). It asks Chromium to handle WebAuthn itself instead of
 *    the native Windows API, which is what raises the "Windows Security /
 *    Insert your security key" dialog on IdP login pages (see
 *    `src/main/index.ts`). Chromium reads its feature switches once, before the
 *    app is ready, so this value is consumed at the next launch - the helper
 *    text says so, and the checkbox deliberately reports the *stored* value,
 *    not a live effect.
 *
 * Both save immediately on change (there is nothing to debounce and no
 * dependent fields), through the panel's one save reporter, exactly like the
 * other sections' immediate mutations.
 */
export interface BrowserSectionOptions {
  /** The panel's single status slot. */
  status: StatusBannerSink;
  /** Registers the save with the panel's save reporter. */
  reportSave(outcome: Promise<SaveOutcome>): void;
  /** Fired after a successful save, so the panel re-reads the snapshot. */
  onSettingsChanged(): void;
}

export interface BrowserSection {
  readonly element: HTMLElement;
  /** Re-reads both controls from the snapshot. */
  update(snapshot: AppSettingsSnapshot): void;
  dispose(): void;
}

/** The stored `browser.proxy` as the picker's value; absent means "(No proxy)". */
function defaultProxySelection(proxyId: ProxyId | undefined): ProxySelection {
  return proxyId === undefined ? { kind: 'none' } : { kind: 'proxy', proxyId };
}

export function createBrowserSection(options: BrowserSectionOptions): BrowserSection {
  const proxyFieldId = 'browser-default-proxy';
  let proxies: readonly ProxySnapshot[] = [];
  let selected: ProxySelection = { kind: 'none' };

  const proxyPicker = createProxyPicker({
    fieldId: proxyFieldId,
    initial: selected,
    proxies,
    // The default proxy has no "inherit" state; "(No proxy)" is the absence of
    // a default.
    includeDefault: false,
    onChange: () => {
      selected = proxyPicker.read();
      onProxyChange();
    },
  });

  const proxyField = el('div', {
    attrs: { class: 'host-field browser-section__proxy' },
    children: [
      el('sp-field-label', { attrs: { for: proxyFieldId }, text: 'Default proxy' }),
      proxyPicker.element,
    ],
  });

  const checkbox = el('sp-checkbox', {
    attrs: { id: 'browser-disable-native-webauthn' },
    text: 'Suppress the Windows security-key prompt',
  }) as HTMLElement & { checked: boolean };

  const helper = el('p', {
    attrs: { class: 'browser-section__hint' },
    text: 'Takes effect after restarting the app',
  });

  const checkboxGroup = el('div', {
    attrs: { class: 'browser-section__group' },
    children: [checkbox, helper],
  });

  const fields = el('div', {
    attrs: { class: 'host-item__fields' },
    children: [proxyField, checkboxGroup],
  });

  const section = el('div', {
    attrs: { class: 'settings-section browser-section', 'aria-label': 'Browser' },
    children: [fields],
  });

  // Guards `update` against the `change` event assigning `.checked` can emit
  // in some environments (the same guard the Agents section uses).
  let rendering = false;

  async function save(changes: {
    disableNativeWebAuthn?: boolean;
    proxy?: ProxyId | null;
  }): Promise<SaveOutcome> {
    try {
      const result = await window.daisy.settings.updateBrowserSettings({ changes });
      return result.ok ? { ok: true } : { ok: false, error: result.error.message };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  function report(changes: { disableNativeWebAuthn?: boolean; proxy?: ProxyId | null }): void {
    const outcome = save(changes);
    options.reportSave(outcome);
    void outcome.then((result) => {
      if (result.ok) options.onSettingsChanged();
    });
  }

  function onProxyChange(): void {
    report({ proxy: selected.kind === 'proxy' ? selected.proxyId : null });
  }

  function onWebAuthnChange(): void {
    if (rendering) return;
    report({ disableNativeWebAuthn: checkbox.checked });
  }

  checkbox.addEventListener('change', onWebAuthnChange);

  return {
    element: section,
    update(snapshot): void {
      proxies = snapshot.proxies;
      proxyPicker.setOptions(proxies);
      selected = defaultProxySelection(snapshot.browser.proxy);
      proxyPicker.select(selected);

      rendering = true;
      checkbox.checked = snapshot.browser.disableNativeWebAuthn;
      rendering = false;
    },
    dispose(): void {
      checkbox.removeEventListener('change', onWebAuthnChange);
    },
  };
}
