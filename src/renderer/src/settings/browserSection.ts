import { el } from '../lib/dom';
import type { AppSettingsSnapshot, ProxyId, ProxySnapshot } from '../../../shared';
import { createContextualHelp, helpAccessibleName, labelledField } from './fieldHelp';
import { createProxyPicker, type ProxySelection } from './proxyPicker';
import { confirmDestructiveAction, type SaveOutcome, type StatusBannerSink } from './statusBanner';

/**
 * The Settings panel's Browser tab: browser-pane behaviour that is not about a
 * host, a proxy entry, or the agent.
 *
 * Three controls:
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
 *    app is ready, so this value is consumed at the next launch - the field's
 *    contextual help says so, and the checkbox deliberately reports the *stored*
 *    value, not a live effect.
 *  - **Erase saved sign-ins** - the only management the saved-sign-in vault has
 *    (there is deliberately no list: the pane prefills an origin's most
 *    recently used credential and the user switches accounts by typing another
 *    saved username, and no count either - a number beside the button had no
 *    action attached to it). The erase is all-or-nothing and confirms through
 *    the shared destructive prompt, exactly like removing a host or a proxy.
 *
 * The first two save immediately on change (there is nothing to debounce and no
 * dependent fields), through the panel's one save reporter, exactly like the
 * other sections' immediate mutations. The erase is not a save: it reports to
 * the same status banner directly.
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

  proxyPicker.element.setAttribute('data-field', 'browser-default-proxy');

  const proxyField = labelledField(
    proxyFieldId,
    'Default proxy',
    proxyPicker.element,
    "The proxy used by this browser default. Can be overridden by hosts' settings",
  );

  const checkbox = el('sp-checkbox', {
    attrs: { id: 'browser-disable-native-webauthn', 'data-field': 'browser-disable-webauthn' },
    text: 'Suppress the Windows security-key prompt',
  }) as HTMLElement & { checked: boolean };

  // The checkbox's own text is its label, so its help badge follows that text
  // on the same line rather than sitting in a separate label row. The restart
  // caveat lives in that help: Chromium reads its feature switches once, before
  // the app is ready, so the change is consumed at the next launch.
  const checkboxRow = el('div', {
    attrs: { class: 'field-label-row' },
    children: [
      checkbox,
      createContextualHelp(
        'Asks browser to handle security keys autonomously, avoiding the Windows prompt. Takes effect after restarting the app',
        helpAccessibleName('Suppress the Windows security-key prompt'),
      ),
    ],
  });

  const fields = el('div', {
    attrs: { class: 'host-item__fields' },
    children: [proxyField, checkboxRow],
  });

  const eraseButton = el('sp-action-button', {
    attrs: { 'data-testid': 'erase-saved-credentials' },
    text: 'Erase saved sign-ins',
  }) as HTMLElement & { disabled: boolean };
  // A button is not a field: it carries no contextual-help badge (the same rule
  // the Updates tab's Check/Update buttons follow), and it stands on its own
  // line with nothing beside it.
  const credentialsRow = el('div', {
    attrs: { class: 'field-label-row' },
    children: [eraseButton],
  });

  const section = el('div', {
    attrs: {
      class: 'settings-section browser-section subsection-gap',
      'aria-label': 'Browser',
    },
    children: [fields, credentialsRow],
  });

  // Guards `update` against the `change` event assigning `.checked` can emit
  // in some environments (the same guard the Agents section uses).
  let rendering = false;
  let disposed = false;
  let erasing = false;

  async function eraseSavedSignIns(): Promise<void> {
    if (erasing) return;
    erasing = true;
    eraseButton.disabled = true;
    try {
      const result = await window.daisy.credentials.erase();
      if (disposed) return;
      if (!result.ok) {
        options.status.showError(result.error.message);
        return;
      }
      options.status.showStatus('Sign-ins erased');
    } catch (error) {
      if (!disposed) {
        options.status.showError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      erasing = false;
      if (!disposed) eraseButton.disabled = false;
    }
  }

  const onEraseClick = (): void => {
    // The prompt dismisses itself when its button is pressed (see
    // `showPrompt`), so the erase's outcome takes the row.
    confirmDestructiveAction(options.status, 'erase every saved sign-in', () => {
      void eraseSavedSignIns();
    });
  };
  eraseButton.addEventListener('click', onEraseClick);

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
      disposed = true;
      checkbox.removeEventListener('change', onWebAuthnChange);
      eraseButton.removeEventListener('click', onEraseClick);
    },
  };
}
