import type { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSkillsSection } from '../../../../src/renderer/src/settings/skillsSection';
import { parseAppSettingsSnapshot, type AppSettingsSnapshot } from '../../../../src/shared';
import type { StatusBannerSink } from '../../../../src/renderer/src/settings/statusBanner';
import { flushMicrotasks } from '../../../support/asyncWaits';
import { installJsdomGlobals } from '../../../support/jsdomGlobals';
import { byField, byTestId } from '../../../support/selectors';

/**
 * The Skills tab's DOM, in jsdom: one open-folder control that asks main to
 * open the folder, reports a failed open through the panel's status slot, and
 * carries exactly one help badge. The real custom-element upgrade is covered by
 * `tests/e2e/settings-tabs.spec.ts`.
 */

let dom: JSDOM;
let restoreGlobals: () => void;
let status: StatusBannerSink;

const openFolder = vi.fn();
const openRulesFolder = vi.fn();
const openMemosFolder = vi.fn();
const updateMemoSettings = vi.fn();
const reportSave = vi.fn();
const onSettingsChanged = vi.fn();
const showError = vi.fn();

function makeSection(): ReturnType<typeof createSkillsSection> {
  return createSkillsSection({ status, reportSave, onSettingsChanged });
}

function snapshotWith(enabled: boolean): AppSettingsSnapshot {
  return parseAppSettingsSnapshot({
    hosts: [],
    proxies: [],
    agents: {},
    browser: { disableNativeWebAuthn: true },
    memos: { enabled },
  });
}

function selfLearning(element: HTMLElement): HTMLElement & { checked: boolean } {
  const box = element.querySelector<HTMLElement & { checked: boolean }>(byField('memos-enabled'));
  if (box === null) throw new Error('self-learning checkbox not found');
  return box;
}

function openButton(element: HTMLElement): HTMLElement {
  const button = element.querySelector<HTMLElement>(byTestId('skills-open-folder'));
  if (button === null) throw new Error('open-folder control not found');
  return button;
}

function rulesButton(element: HTMLElement): HTMLElement {
  const button = element.querySelector<HTMLElement>(byTestId('rules-open-folder'));
  if (button === null) throw new Error('rules open-folder control not found');
  return button;
}

beforeEach(() => {
  openFolder.mockReset();
  openRulesFolder.mockReset();
  openMemosFolder.mockReset();
  updateMemoSettings.mockReset();
  reportSave.mockReset();
  onSettingsChanged.mockReset();
  showError.mockReset();
  openMemosFolder.mockResolvedValue({ ok: true });
  updateMemoSettings.mockResolvedValue({ ok: true });
  openFolder.mockResolvedValue({ ok: true });
  openRulesFolder.mockResolvedValue({ ok: true });
  status = {
    showStatus: vi.fn(),
    showError,
    showPrompt: vi.fn(),
    showNotice: vi.fn(),
    clear: vi.fn(),
  };
  ({ dom, restore: restoreGlobals } = installJsdomGlobals());
  Reflect.set(dom.window, 'daisy', {
    skills: { openFolder },
    rules: { openFolder: openRulesFolder },
    memos: { openFolder: openMemosFolder },
    settings: { updateMemoSettings },
  });
});

afterEach(() => {
  restoreGlobals();
});

describe('createSkillsSection', () => {
  it('carries the three open-folder controls and the checkbox, each with a help badge', () => {
    const section = makeSection();
    expect(section.element.querySelectorAll('sp-contextual-help')).toHaveLength(4);
    expect(openButton(section.element)).not.toBeNull();
    expect(rulesButton(section.element)).not.toBeNull();
  });

  it('places the self-learning checkbox before the memos folder action', () => {
    const section = makeSection();
    const checkbox = selfLearning(section.element);
    const memosButton = section.element.querySelector<HTMLElement>(byTestId('memos-open-folder'));
    if (memosButton === null) throw new Error('memos open-folder control not found');
    // The checkbox's row must come first: DOCUMENT_POSITION_FOLLOWING on the
    // memos button means it follows the checkbox in the document.
    const following = dom.window.Node.DOCUMENT_POSITION_FOLLOWING;
    expect(checkbox.compareDocumentPosition(memosButton) & following).toBe(following);
  });

  it('asks main to open the rules folder, and only that one', async () => {
    const section = makeSection();
    rulesButton(section.element).click();
    await flushMicrotasks(4);
    expect(openRulesFolder).toHaveBeenCalledTimes(1);
    expect(openFolder).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('shows the failure message when the rules folder cannot be opened', async () => {
    openRulesFolder.mockResolvedValue({
      ok: false,
      error: { code: 'open_failed', message: 'no file manager' },
    });
    const section = makeSection();
    rulesButton(section.element).click();
    await flushMicrotasks(4);
    expect(showError).toHaveBeenCalledWith('no file manager');
  });

  it('asks main to open the folder and stays quiet on success', async () => {
    const section = makeSection();
    openButton(section.element).click();
    await flushMicrotasks(4);
    expect(openFolder).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
  });

  it('shows the failure message when the folder cannot be opened', async () => {
    openFolder.mockResolvedValue({
      ok: false,
      error: { code: 'open_failed', message: 'no file manager' },
    });
    const section = makeSection();
    openButton(section.element).click();
    await flushMicrotasks(4);
    expect(showError).toHaveBeenCalledWith('no file manager');
  });

  it('shows a rejected call as an error rather than throwing', async () => {
    openFolder.mockRejectedValue(new Error('ipc gone'));
    const section = makeSection();
    openButton(section.element).click();
    await flushMicrotasks(4);
    expect(showError).toHaveBeenCalledWith('ipc gone');
  });

  it('unhooks the click listeners on dispose', async () => {
    const section = makeSection();
    section.dispose();
    openButton(section.element).click();
    rulesButton(section.element).click();
    await flushMicrotasks(4);
    expect(openFolder).not.toHaveBeenCalled();
    expect(openRulesFolder).not.toHaveBeenCalled();
  });

  it('asks main to open the memos folder, and only that one', async () => {
    const section = makeSection();
    const button = section.element.querySelector<HTMLElement>(byTestId('memos-open-folder'));
    button?.click();
    await flushMicrotasks(4);
    expect(openMemosFolder).toHaveBeenCalledTimes(1);
    expect(openFolder).not.toHaveBeenCalled();
    expect(openRulesFolder).not.toHaveBeenCalled();
  });

  it('reflects the stored self-learning flag without saving it', () => {
    const section = makeSection();
    section.update(snapshotWith(false));
    expect(selfLearning(section.element).checked).toBe(false);
    section.update(snapshotWith(true));
    expect(selfLearning(section.element).checked).toBe(true);
    expect(updateMemoSettings).not.toHaveBeenCalled();
  });

  it('persists a toggle, reports the save, and reloads on success', async () => {
    const section = makeSection();
    section.update(snapshotWith(true));
    const box = selfLearning(section.element);
    box.checked = false;
    box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flushMicrotasks(4);
    expect(updateMemoSettings).toHaveBeenCalledWith({ changes: { enabled: false } });
    expect(reportSave).toHaveBeenCalledTimes(1);
    await expect(reportSave.mock.calls[0]?.[0]).resolves.toEqual({ ok: true });
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
  });

  it('does not reload after a failed save', async () => {
    updateMemoSettings.mockResolvedValue({
      ok: false,
      error: { code: 'write_failed', message: 'disk full' },
    });
    const section = makeSection();
    selfLearning(section.element).dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flushMicrotasks(4);
    await expect(reportSave.mock.calls[0]?.[0]).resolves.toEqual({ ok: false, error: 'disk full' });
    expect(onSettingsChanged).not.toHaveBeenCalled();
  });
});
