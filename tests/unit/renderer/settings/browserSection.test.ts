import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserSection } from '../../../../src/renderer/src/settings/browserSection';
import type {
  SaveOutcome,
  StatusBannerSink,
} from '../../../../src/renderer/src/settings/statusBanner';
import { parseAppSettingsSnapshot, type AppSettingsSnapshot } from '../../../../src/shared';

/**
 * The Browser section's DOM, in jsdom. The real custom-element upgrade is
 * asserted in `tests/e2e/settings-tabs.spec.ts`; this proves the wiring: the
 * checkbox reflects the stored value, a toggle persists exactly the flag it
 * changed, a failed save leaves the panel snapshot untouched, and `dispose`
 * unhooks the listener.
 */

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;
let dom: JSDOM;

const updateBrowserSettings = vi.fn();

let status: StatusBannerSink;
let reportSave: (outcome: Promise<SaveOutcome>) => void;
let onSettingsChanged: () => void;

function snapshotWith(disableNativeWebAuthn: boolean): AppSettingsSnapshot {
  return parseAppSettingsSnapshot({
    hosts: [],
    proxies: [],
    agents: {},
    browser: { disableNativeWebAuthn },
  });
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
}

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

  status = {
    showStatus: vi.fn(),
    showError: vi.fn(),
    showPrompt: vi.fn(),
    clear: vi.fn(),
  };
  reportSave = vi.fn<(outcome: Promise<SaveOutcome>) => void>();
  onSettingsChanged = vi.fn<() => void>();

  dom = new JSDOM();
  Reflect.set(globalThis, 'document', dom.window.document);
  Reflect.set(globalThis, 'window', dom.window);
  Reflect.set(dom.window, 'daisy', { settings: { updateBrowserSettings } });
});

afterEach(() => {
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
  Reflect.set(globalThis, 'window', previousWindow);
});

function buildSection() {
  return createBrowserSection({ status, reportSave, onSettingsChanged });
}

describe('createBrowserSection', () => {
  it('renders the suppression checkbox with its label and the restart caveat', () => {
    const section = buildSection();
    expect(section.element.getAttribute('aria-label')).toBe('Browser');
    expect(checkboxOf(section).textContent).toBe('Suppress the Windows security-key prompt');
    expect(section.element.textContent).toContain('Takes effect after restarting the app.');
  });

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
});
