import type { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpdatesSection } from '../../../../src/renderer/src/settings/updatesSection';
import type {
  SaveOutcome,
  StatusBannerSink,
} from '../../../../src/renderer/src/settings/statusBanner';
import {
  parseAppSettingsSnapshot,
  type AppSettingsSnapshot,
  type UpdateStatus,
} from '../../../../src/shared';
import { flushMicrotasks } from '../../../support/asyncWaits';
import { installJsdomGlobals } from '../../../support/jsdomGlobals';
import { byField, byTestId } from '../../../support/selectors';

/**
 * The Updates section's DOM, in jsdom: the buttons follow the status main
 * pushes, the two settings persist exactly what changed, and the Update
 * button asks for confirmation before it applies anything.
 */

let dom: JSDOM;
let restoreGlobals: () => void;

const updateUpdateSettings = vi.fn();
const check = vi.fn();
const apply = vi.fn();
const getStatus = vi.fn();
const unsubscribe = vi.fn();
let pushStatus: (status: UpdateStatus) => void;

let status: StatusBannerSink;
let showPrompt: ReturnType<typeof vi.fn<StatusBannerSink['showPrompt']>>;
let reportSave: (outcome: Promise<SaveOutcome>) => void;
let onSettingsChanged: () => void;

function snapshotWith(updates: { url?: string; checkOnStartup: boolean }): AppSettingsSnapshot {
  return parseAppSettingsSnapshot({
    hosts: [],
    proxies: [],
    agents: {},
    browser: { disableNativeWebAuthn: false },
    updates,
  });
}

const flush = (): Promise<void> => flushMicrotasks(4);

function buildSection() {
  return createUpdatesSection({ status, reportSave, onSettingsChanged });
}

function query<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const found = root.querySelector(selector);
  if (found === null) throw new Error(`${selector} not found`);
  return found as T;
}

type Field = HTMLElement & { value: string; checked: boolean; disabled: boolean };

beforeEach(() => {
  for (const mock of [updateUpdateSettings, check, apply, getStatus, unsubscribe]) mock.mockReset();
  updateUpdateSettings.mockResolvedValue({ ok: true });
  getStatus.mockResolvedValue({ ok: true, status: { kind: 'idle' } });
  check.mockResolvedValue({ ok: true, status: { kind: 'upToDate' } });
  apply.mockResolvedValue({ ok: true, status: { kind: 'applying' } });

  showPrompt = vi.fn<StatusBannerSink['showPrompt']>();
  status = {
    showStatus: vi.fn(),
    showError: vi.fn(),
    showPrompt,
    showNotice: vi.fn(),
    clear: vi.fn(),
  };
  reportSave = vi.fn<(outcome: Promise<SaveOutcome>) => void>();
  onSettingsChanged = vi.fn<() => void>();

  ({ dom, restore: restoreGlobals } = installJsdomGlobals());
  Reflect.set(dom.window, 'daisy', {
    settings: { updateUpdateSettings },
    updates: {
      getStatus,
      check,
      apply,
      onStatusChanged: (listener: (status: UpdateStatus) => void) => {
        pushStatus = listener;
        return unsubscribe;
      },
    },
  });
});

afterEach(() => {
  restoreGlobals();
});

describe('createUpdatesSection', () => {
  it('shows the Update button only while an update is available', async () => {
    const section = buildSection();
    await flush();
    const apply = query<Field>(section.element, byTestId('updates-apply'));
    expect(apply.hasAttribute('hidden')).toBe(true);

    pushStatus({ kind: 'available', version: '2.0.0' });
    expect(apply.hasAttribute('hidden')).toBe(false);

    pushStatus({ kind: 'upToDate' });
    expect(apply.hasAttribute('hidden')).toBe(true);
  });

  it('disables both buttons while checking or applying', () => {
    const section = buildSection();
    const checkButton = query<Field>(section.element, byTestId('updates-check'));
    const applyButton = query<Field>(section.element, byTestId('updates-apply'));

    pushStatus({ kind: 'checking' });
    expect(checkButton.disabled).toBe(true);
    expect(applyButton.disabled).toBe(true);

    pushStatus({ kind: 'idle' });
    expect(checkButton.disabled).toBe(false);
  });

  it('asks main to check when Check is clicked and renders the answer', async () => {
    const section = buildSection();
    query(section.element, byTestId('updates-check')).click();
    await flush();
    expect(check).toHaveBeenCalledTimes(1);
    expect(query(section.element, byTestId('updates-status')).textContent).not.toBe('');
  });

  it('confirms before applying, and applies only on confirmation', async () => {
    const section = buildSection();
    pushStatus({ kind: 'available', version: '2.0.0' });
    query(section.element, byTestId('updates-apply')).click();

    expect(apply).not.toHaveBeenCalled();
    expect(showPrompt).toHaveBeenCalledTimes(1);
    const prompt = showPrompt.mock.calls[0];
    prompt?.[1]?.onActivate();
    await flush();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('reflects the stored settings on update', () => {
    const section = buildSection();
    section.update(snapshotWith({ url: 'https://example.com/x', checkOnStartup: true }));
    expect(query<Field>(section.element, byField('updates-url')).value).toBe(
      'https://example.com/x',
    );
    expect(query<Field>(section.element, byField('updates-check-on-startup')).checked).toBe(true);
  });

  it('persists a trimmed URL, and null when it is cleared', async () => {
    const section = buildSection();
    const field = query<Field>(section.element, byField('updates-url'));

    field.value = '  https://example.com/x  ';
    field.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(updateUpdateSettings).toHaveBeenLastCalledWith({
      changes: { url: 'https://example.com/x' },
    });
    await flush();
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);

    field.value = '   ';
    field.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(updateUpdateSettings).toHaveBeenLastCalledWith({ changes: { url: null } });
  });

  it('persists exactly the startup flag it changed', () => {
    const section = buildSection();
    const checkbox = query<Field>(section.element, byField('updates-check-on-startup'));
    checkbox.checked = true;
    checkbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(updateUpdateSettings).toHaveBeenCalledWith({ changes: { checkOnStartup: true } });
    expect(reportSave).toHaveBeenCalledTimes(1);
  });

  it('does not save while the snapshot is being applied', () => {
    const section = buildSection();
    section.update(snapshotWith({ checkOnStartup: true }));
    expect(updateUpdateSettings).not.toHaveBeenCalled();
  });

  it('does not reload after a failed save', async () => {
    updateUpdateSettings.mockResolvedValue({
      ok: false,
      error: { code: 'storage_error', message: 'disk full' },
    });
    const section = buildSection();
    const checkbox = query<Field>(section.element, byField('updates-check-on-startup'));
    checkbox.checked = true;
    checkbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush();
    expect(onSettingsChanged).not.toHaveBeenCalled();
  });

  it('carries a help badge on its two settings but not on the buttons', () => {
    const section = buildSection();
    expect(section.element.querySelectorAll('sp-contextual-help')).toHaveLength(2);
    const actions = query(section.element, '.updates-section__actions');
    expect(actions.querySelector('sp-contextual-help')).toBeNull();
  });

  it('lists the startup checkbox before the custom URL, after the button line', () => {
    const section = buildSection();
    const order = [
      byTestId('updates-check'),
      byField('updates-check-on-startup'),
      byField('updates-url'),
    ].map((selector) => query(section.element, selector));
    for (let index = 1; index < order.length; index += 1) {
      const previous = order[index - 1];
      const current = order[index];
      expect(previous?.compareDocumentPosition(current as Node)).toBe(
        dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }
  });

  it('says what part of the runtime layer needs the fresh installation', () => {
    const section = buildSection();
    const apply = query<Field>(section.element, byTestId('updates-apply'));
    const status = (): string =>
      query(section.element, byTestId('updates-status')).textContent ?? '';

    pushStatus({ kind: 'installerRequired', version: '2.0.0' });
    const bare = status();
    expect(apply.hasAttribute('hidden')).toBe(true);
    expect(bare).toContain('2.0.0');

    pushStatus({ kind: 'installerRequired', version: '2.0.0', changed: ['payload', 'electron'] });
    const explained = status();
    expect(explained).toContain('2.0.0');
    expect(explained).not.toBe(bare);
    // A status phrase is a label: the app's copy never ends with a period.
    expect(bare.endsWith('.')).toBe(false);
    expect(explained.endsWith('.')).toBe(false);
  });

  it('unsubscribes from status pushes on dispose', () => {
    buildSection().dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
