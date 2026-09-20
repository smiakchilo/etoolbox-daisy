import { el } from '../lib/dom';
import type { AppSettingsSnapshot } from '../../../shared';
import type { SaveOutcome, StatusBannerSink } from './statusBanner';

/**
 * The Settings panel's Browser tab: browser-pane behaviour flags that are not
 * about a host, a proxy, or the agent.
 *
 * Today a single checkbox, "Suppress the Windows security-key prompt", backed
 * by `browser.disableNativeWebAuthn` (default `true`). It asks Chromium to
 * handle WebAuthn itself instead of the native Windows API, which is what
 * raises the "Windows Security / Insert your security key" dialog on IdP login
 * pages (see `src/main/index.ts`).
 *
 * Chromium reads its feature switches once, before the app is ready, so this
 * value is consumed at the next launch - the helper text says so, and the
 * checkbox deliberately reports the *stored* value, not a live effect.
 *
 * Saves immediately on toggle (there is nothing to debounce and no dependent
 * fields), through the panel's one save reporter, exactly like the other
 * sections' immediate mutations.
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
  /** Re-reads the checkbox from the snapshot. */
  update(snapshot: AppSettingsSnapshot): void;
  dispose(): void;
}

export function createBrowserSection(options: BrowserSectionOptions): BrowserSection {
  const checkbox = el('sp-checkbox', {
    attrs: { id: 'browser-disable-native-webauthn' },
    text: 'Suppress the Windows security-key prompt',
  }) as HTMLElement & { checked: boolean };

  const helper = el('p', {
    attrs: { class: 'browser-section__hint' },
    text: 'Takes effect after restarting the app.',
  });

  const group = el('div', {
    attrs: { class: 'browser-section__group' },
    children: [checkbox, helper],
  });

  const section = el('div', {
    attrs: { class: 'settings-section browser-section', 'aria-label': 'Browser' },
    children: [group],
  });

  // Guards `update` against the `change` event assigning `.checked` can emit
  // in some environments (the same guard the Agents section uses).
  let rendering = false;

  async function save(disableNativeWebAuthn: boolean): Promise<SaveOutcome> {
    try {
      const result = await window.daisy.settings.updateBrowserSettings({
        changes: { disableNativeWebAuthn },
      });
      return result.ok ? { ok: true } : { ok: false, error: result.error.message };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  function onChange(): void {
    if (rendering) return;
    const outcome = save(checkbox.checked);
    options.reportSave(outcome);
    void outcome.then((result) => {
      if (result.ok) options.onSettingsChanged();
    });
  }

  checkbox.addEventListener('change', onChange);

  return {
    element: section,
    update(snapshot): void {
      rendering = true;
      checkbox.checked = snapshot.browser.disableNativeWebAuthn;
      rendering = false;
    },
    dispose(): void {
      checkbox.removeEventListener('change', onChange);
    },
  };
}
