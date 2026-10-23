import type { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserSection } from '../../../../src/renderer/src/settings/browserSection';
import type {
  SaveOutcome,
  StatusBannerAction,
  StatusBannerSink,
} from '../../../../src/renderer/src/settings/statusBanner';
import {
  newProxyId,
  parseAppSettingsSnapshot,
  proxySnapshotSchema,
  type AppSettingsSnapshot,
  type CredentialsIpcResult,
  type ProxySnapshot,
} from '../../../../src/shared';
import { PROXY_NONE_VALUE } from '../../../../src/renderer/src/settings/proxyPicker';
import { flushMicrotasks } from '../../../support/asyncWaits';
import { installJsdomGlobals } from '../../../support/jsdomGlobals';
import { byField, byTestId } from '../../../support/selectors';

/**
 * The Browser section's DOM, in jsdom. The real custom-element upgrade is
 * asserted in `tests/e2e/settings-tabs.spec.ts`; this proves the wiring: the
 * checkbox reflects the stored value, a toggle persists exactly the flag it
 * changed, a failed save leaves the panel snapshot untouched, `dispose`
 * unhooks the listener, and the erase button confirms and reports through the
 * shared prompt.
 */

let dom: JSDOM;
let restoreGlobals: () => void;

const updateBrowserSettings = vi.fn();
const erase = vi.fn<() => Promise<CredentialsIpcResult>>();

let status: StatusBannerSink;
let showStatus: ReturnType<typeof vi.fn<(message: string) => void>>;
let showError: ReturnType<typeof vi.fn<(message: string) => void>>;
let showPrompt: ReturnType<typeof vi.fn<(copy: string, action: StatusBannerAction) => void>>;
let reportSave: (outcome: Promise<SaveOutcome>) => void;
let onSettingsChanged: () => void;

function proxySnapshot(id: string, label: string): ProxySnapshot {
  return proxySnapshotSchema.parse({
    id: newProxyId(() => id),
    label,
    url: 'https://proxy.example:8080',
  });
}

function snapshotWith(
  disableNativeWebAuthn: boolean,
  options: { proxy?: string; proxies?: readonly ProxySnapshot[] } = {},
): AppSettingsSnapshot {
  return parseAppSettingsSnapshot({
    hosts: [],
    proxies: options.proxies ?? [],
    agents: {},
    browser: {
      disableNativeWebAuthn,
      ...(options.proxy !== undefined ? { proxy: options.proxy } : {}),
    },
  });
}

function proxyPickerOf(section: ReturnType<typeof createBrowserSection>): HTMLElement & {
  value: string;
} {
  const picker = section.element.querySelector(byField('browser-default-proxy'));
  if (picker === null) throw new Error('proxy picker not found');
  return picker as HTMLElement & { value: string };
}

function chooseProxy(picker: HTMLElement & { value: string }, value: string): void {
  picker.value = value;
  picker.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

const flush = (): Promise<void> => flushMicrotasks(4);

function checkboxOf(section: ReturnType<typeof createBrowserSection>): HTMLElement & {
  checked: boolean;
} {
  const checkbox = section.element.querySelector('#browser-disable-native-webauthn');
  if (checkbox === null) throw new Error('checkbox not found');
  return checkbox as HTMLElement & { checked: boolean };
}

function toggle(checkbox: HTMLElement & { checked: boolean }, checked: boolean): void {
  checkbox.checked = checked;
  checkbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

beforeEach(() => {
  updateBrowserSettings.mockReset();
  updateBrowserSettings.mockResolvedValue({ ok: true });
  erase.mockReset();
  erase.mockResolvedValue({ ok: true });

  showStatus = vi.fn();
  showError = vi.fn();
  showPrompt = vi.fn();
  status = {
    showStatus,
    showError,
    showPrompt,
    showNotice: vi.fn(),
    clear: vi.fn(),
  };
  reportSave = vi.fn<(outcome: Promise<SaveOutcome>) => void>();
  onSettingsChanged = vi.fn<() => void>();

  ({ dom, restore: restoreGlobals } = installJsdomGlobals());
  Reflect.set(dom.window, 'daisy', {
    settings: { updateBrowserSettings },
    credentials: { erase },
  });
});

afterEach(() => {
  restoreGlobals();
});

function buildSection() {
  return createBrowserSection({ status, reportSave, onSettingsChanged });
}

describe('createBrowserSection', () => {
  it('reflects the stored value on update, in both directions', () => {
    const section = buildSection();
    section.update(snapshotWith(false));
    expect(checkboxOf(section).checked).toBe(false);
    section.update(snapshotWith(true));
    expect(checkboxOf(section).checked).toBe(true);
  });

  it('persists exactly the changed flag and reloads on success', async () => {
    const section = buildSection();
    section.update(snapshotWith(true));

    toggle(checkboxOf(section), false);
    expect(updateBrowserSettings).toHaveBeenCalledWith({
      changes: { disableNativeWebAuthn: false },
    });
    expect(reportSave).toHaveBeenCalledTimes(1);
    await flush();
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
  });

  it('reports a failed save and does not reload', async () => {
    updateBrowserSettings.mockResolvedValue({
      ok: false,
      error: { code: 'storage_error', message: 'disk full' },
    });
    const section = buildSection();
    section.update(snapshotWith(true));

    toggle(checkboxOf(section), false);
    await flush();

    expect(reportSave).toHaveBeenCalledTimes(1);
    expect(onSettingsChanged).not.toHaveBeenCalled();
  });

  it('stops reacting to toggles after dispose', () => {
    const section = buildSection();
    section.dispose();
    toggle(checkboxOf(section), false);
    expect(updateBrowserSettings).not.toHaveBeenCalled();
  });

  describe('Default proxy', () => {
    const corp = proxySnapshot('p1', 'Corporate');
    const home = proxySnapshot('p2', 'Home');

    it('renders the Default proxy field first, labelled, with "(No proxy)" plus the library', () => {
      const section = buildSection();
      section.update(snapshotWith(true, { proxies: [corp, home] }));

      const labels = [...section.element.querySelectorAll('sp-field-label')].map(
        (node) => node.textContent,
      );
      expect(labels[0]).toBe('Default proxy');

      const picker = proxyPickerOf(section);
      const menuLabels = [...picker.querySelectorAll('sp-menu-item')].map(
        (item) => item.textContent,
      );
      // No "(Default)" choice: this *is* the default.
      expect(menuLabels).toEqual(['(No proxy)', 'Corporate', 'Home']);
      expect(picker.value).toBe(PROXY_NONE_VALUE);
    });

    it('preselects the stored default proxy id', () => {
      const section = buildSection();
      section.update(snapshotWith(true, { proxy: 'p1', proxies: [corp, home] }));

      expect(proxyPickerOf(section).value).toBe(String(newProxyId(() => 'p1')));
    });

    it('persists the chosen entry, then null when "(No proxy)" is chosen', () => {
      const section = buildSection();
      section.update(snapshotWith(true, { proxies: [corp, home] }));

      chooseProxy(proxyPickerOf(section), String(newProxyId(() => 'p1')));
      expect(updateBrowserSettings).toHaveBeenCalledWith({
        changes: { proxy: newProxyId(() => 'p1') },
      });

      chooseProxy(proxyPickerOf(section), PROXY_NONE_VALUE);
      expect(updateBrowserSettings).toHaveBeenLastCalledWith({ changes: { proxy: null } });
    });
  });

  describe('Saved sign-ins', () => {
    function eraseButtonOf(section: ReturnType<typeof createBrowserSection>): HTMLElement {
      const button = section.element.querySelector(byTestId('erase-saved-credentials'));
      if (button === null) throw new Error('erase button not found');
      return button as HTMLElement;
    }

    function lastPrompt(): StatusBannerAction {
      const action = showPrompt.mock.calls.at(-1)?.[1];
      if (action === undefined) throw new Error('no confirmation was raised');
      return action;
    }

    it('has no count line beside the button', () => {
      const section = buildSection();
      section.update(snapshotWith(true));

      expect(section.element.querySelector(byTestId('saved-sign-ins-status'))).toBeNull();
    });

    it('confirms before erasing, and does nothing until the prompt is accepted', () => {
      const section = buildSection();
      section.update(snapshotWith(true));

      eraseButtonOf(section).click();

      expect(showPrompt).toHaveBeenCalledTimes(1);
      expect(erase).not.toHaveBeenCalled();
      expect(lastPrompt().testId).toBe('banner-confirm');

      lastPrompt().onActivate();

      expect(erase).toHaveBeenCalledTimes(1);
    });

    it('reports a successful erase as a status line', async () => {
      const section = buildSection();
      section.update(snapshotWith(true));

      eraseButtonOf(section).click();
      lastPrompt().onActivate();
      await flush();

      expect(showStatus).toHaveBeenCalled();
      expect(showError).not.toHaveBeenCalled();
    });

    it('surfaces a failed erase as an error', async () => {
      erase.mockResolvedValue({
        ok: false,
        error: { code: 'storage_error', message: 'could not forget' },
      });
      const section = buildSection();
      section.update(snapshotWith(true));

      eraseButtonOf(section).click();
      lastPrompt().onActivate();
      await flush();

      expect(showError).toHaveBeenCalledWith('could not forget');
      expect(showStatus).not.toHaveBeenCalled();
    });
  });
});
