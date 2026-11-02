import { el } from '../lib/dom';
import type { AppSettingsSnapshot, ProxyId, ProxySnapshot } from '../../../shared';
import { createContextualHelp, helpAccessibleName, labelledField } from './fieldHelp';
import { createProxyPicker, type ProxySelection } from './proxyPicker';
import { confirmDestructiveAction, type SaveOutcome, type StatusBannerSink } from './statusBanner';

/**
 * The Settings panel's General tab: browser-pane behaviour that is not about a
 * host, a proxy entry, or the agent.
 *
 * The tab's id is still `browser` (and it edits the `browser.*` settings
 * group); "General" is the label because these are the pane-level settings the
 * host- and proxy-specific tabs below refine.
 *
 * The controls, top to bottom:
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
 *    action attached to it). The erase is all-or-nothing and now travels with
 *    the pane's own cookie jar inside **Clear personal data** below, so there is
 *    no button of its own.
 *
 * The last group is the pane's two clearing actions, stacked:
 *
 *  - **Clear personal data** - saved sign-ins, the pane's cookies and every open
 *    document's session storage. This is "log me out of everything".
 *  - **Clear storage** - local storage, IndexedDB, service workers, cache
 *    storage and the HTTP cache. This is "start this site from scratch".
 *
 * Both clear through main (`browser:clear-data`) and then reload the open page,
 * so the consequence is visible at once; both confirm through the shared
 * destructive prompt. They deliberately carry a contextual-help badge each,
 * spelling out the exact split - a data-clearing action whose scope is a guess
 * is not acceptable (owner decision, overriding the "a button is not a field"
 * rule the Updates tab's buttons still follow).
 *
 * The first two save immediately on change (there is nothing to debounce and no
 * dependent fields), through the panel's one save reporter, exactly like the
 * other sections' immediate mutations. The clearing actions are not saves: they
 * report to the same status banner directly.
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

  const personalButton = el('sp-action-button', {
    attrs: { 'data-testid': 'clear-personal-data' },
    text: 'Clear personal data',
  }) as HTMLElement & { disabled: boolean };
  const storageButton = el('sp-action-button', {
    attrs: { 'data-testid': 'clear-storage' },
    text: 'Clear storage',
  }) as HTMLElement & { disabled: boolean };

  // Both clearing actions carry a help badge that names exactly what goes - the
  // one place the split between them is written where the user can read it. (The
  // behavioral truth lives in `src/main/browser/browsingData.ts`.)
  const clearingRows = el('div', {
    attrs: { class: 'browser-section__clearing host-item__fields' },
    children: [
      el('div', {
        attrs: { class: 'field-label-row' },
        children: [
          personalButton,
          createContextualHelp(
            "Forgets saved sign-ins, the pane's cookies and session storage, then reloads the open page",
            helpAccessibleName('Clear personal data'),
          ),
        ],
      }),
      el('div', {
        attrs: { class: 'field-label-row' },
        children: [
          storageButton,
          createContextualHelp(
            'Clears local storage, IndexedDB, service workers and cached files, then reloads the open page',
            helpAccessibleName('Clear storage'),
          ),
        ],
      }),
    ],
  });

  const section = el('div', {
    attrs: {
      class: 'settings-section browser-section subsection-gap',
      'aria-label': 'General',
    },
    children: [fields, clearingRows],
  });

  // Guards `update` against the `change` event assigning `.checked` can emit
  // in some environments (the same guard the Agents section uses).
  let rendering = false;
  let disposed = false;
  let clearingPersonal = false;
  let clearingStorage = false;

  async function failureOf(
    work: () => Promise<{ ok: boolean; error?: { message: string } }>,
  ): Promise<string | undefined> {
    try {
      const result = await work();
      return result.ok ? undefined : result.error?.message;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async function clearPersonalData(): Promise<void> {
    if (clearingPersonal) return;
    clearingPersonal = true;
    personalButton.disabled = true;
    try {
      // Both halves run even when one fails: the saved sign-ins and the cookie
      // jar are independent stores, and the error names whichever half broke.
      const signIns = await failureOf(() => window.daisy.credentials.erase());
      const paneData = await failureOf(() => window.daisy.browser.clearData({ scope: 'personal' }));
      if (disposed) return;
      const failure = signIns ?? paneData;
      if (failure !== undefined) {
        options.status.showError(failure);
        return;
      }
      options.status.showStatus('Personal data cleared');
    } finally {
      clearingPersonal = false;
      if (!disposed) personalButton.disabled = false;
    }
  }

  async function clearStorage(): Promise<void> {
    if (clearingStorage) return;
    clearingStorage = true;
    storageButton.disabled = true;
    try {
      const failure = await failureOf(() => window.daisy.browser.clearData({ scope: 'storage' }));
      if (disposed) return;
      if (failure !== undefined) {
        options.status.showError(failure);
        return;
      }
      options.status.showStatus('Storage cleared');
    } finally {
      clearingStorage = false;
      if (!disposed) storageButton.disabled = false;
    }
  }

  const onPersonalClick = (): void => {
    // The prompt dismisses itself when its button is pressed (see
    // `showPrompt`), so the clearing's outcome takes the row.
    confirmDestructiveAction(options.status, 'clear your personal data', () => {
      void clearPersonalData();
    });
  };
  const onStorageClick = (): void => {
    confirmDestructiveAction(options.status, 'clear the browser storage', () => {
      void clearStorage();
    });
  };
  personalButton.addEventListener('click', onPersonalClick);
  storageButton.addEventListener('click', onStorageClick);

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
      personalButton.removeEventListener('click', onPersonalClick);
      storageButton.removeEventListener('click', onStorageClick);
    },
  };
}
