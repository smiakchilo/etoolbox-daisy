import type { JSDOM } from 'jsdom';
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
let showStatus: Mock<(message: string) => void>;

const openFolder = vi.fn();
const reload = vi.fn();
const onSkillsReloaded = vi.fn();
const openRulesFolder = vi.fn();
const rulesReload = vi.fn();
const openMemosFolder = vi.fn();
const updateMemoSettings = vi.fn();
const reportSave = vi.fn();
const onSettingsChanged = vi.fn();
const showError = vi.fn();

function makeSection(): ReturnType<typeof createSkillsSection> {
  return createSkillsSection({ status, reportSave, onSettingsChanged, onSkillsReloaded });
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

function reloadButton(element: HTMLElement): HTMLElement {
  const button = element.querySelector<HTMLElement>(byTestId('skills-reload'));
  if (button === null) throw new Error('reload control not found');
  return button;
}

function rulesReloadButton(element: HTMLElement): HTMLElement {
  const button = element.querySelector<HTMLElement>(byTestId('rules-reload'));
  if (button === null) throw new Error('rules reload control not found');
  return button;
}

function rulesButton(element: HTMLElement): HTMLElement {
  const button = element.querySelector<HTMLElement>(byTestId('rules-open-folder'));
  if (button === null) throw new Error('rules open-folder control not found');
  return button;
}

beforeEach(() => {
  openFolder.mockReset();
  reload.mockReset();
  onSkillsReloaded.mockReset();
  reload.mockResolvedValue({ ok: true, count: 2 });
  openRulesFolder.mockReset();
  rulesReload.mockReset();
  rulesReload.mockResolvedValue({ ok: true, count: 1 });
  updateMemoSettings.mockReset();
  reportSave.mockReset();
  onSettingsChanged.mockReset();
  showError.mockReset();
  openMemosFolder.mockResolvedValue({ ok: true });
  updateMemoSettings.mockResolvedValue({ ok: true });
  openFolder.mockResolvedValue({ ok: true });
  openRulesFolder.mockResolvedValue({ ok: true });
  showStatus = vi.fn();
  status = {
    showStatus,
    showError,
    showPrompt: vi.fn(),
    showNotice: vi.fn(),
    clear: vi.fn(),
  };
  ({ dom, restore: restoreGlobals } = installJsdomGlobals());
  Reflect.set(dom.window, 'daisy', {
    skills: { openFolder, reload },
    rules: { openFolder: openRulesFolder, reload: rulesReload },
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

  it('reloads skills, confirms, and tells the shell so the chat re-reads its list', async () => {
    const section = makeSection();
    reloadButton(section.element).click();
    await flushMicrotasks(4);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(showStatus).toHaveBeenCalledTimes(1);
    expect(onSkillsReloaded).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
  });

  it('shows the failure and does not notify the shell when the reload fails', async () => {
    reload.mockResolvedValue({
      ok: false,
      error: { code: 'reload_failed', message: 'could not read' },
    });
    const section = makeSection();
    reloadButton(section.element).click();
    await flushMicrotasks(4);
    expect(showError).toHaveBeenCalledWith('could not read');
    expect(onSkillsReloaded).not.toHaveBeenCalled();
  });

  it('shows a rejected reload as an error', async () => {
    reload.mockRejectedValue(new Error('ipc gone'));
    const section = makeSection();
    reloadButton(section.element).click();
    await flushMicrotasks(4);
    expect(showError).toHaveBeenCalledWith('ipc gone');
    expect(onSkillsReloaded).not.toHaveBeenCalled();
  });

  it('reloads rules through the rules call only, and confirms', async () => {
    const section = makeSection();
    rulesReloadButton(section.element).click();
    await flushMicrotasks(4);
    expect(rulesReload).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(onSkillsReloaded).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
  });

  it('shows a failed rules reload as an error', async () => {
    rulesReload.mockResolvedValue({
      ok: false,
      error: { code: 'reload_failed', message: 'could not read rules' },
    });
    const section = makeSection();
    rulesReloadButton(section.element).click();
    await flushMicrotasks(4);
    expect(showError).toHaveBeenCalledWith('could not read rules');
  });

  it('wears icon-only reload buttons that carry their name as a title', () => {
    const section = makeSection();
    for (const button of [reloadButton(section.element), rulesReloadButton(section.element)]) {
      expect(button.textContent?.trim()).toBe('');
      expect(button.querySelector('[slot="icon"]')).not.toBeNull();
      expect(button.getAttribute('title')).toBeTruthy();
      expect(button.getAttribute('aria-label')).toBe(button.getAttribute('title'));
    }
  });

  it('ignores a second click while a reload is running', async () => {
    let finish: (value: unknown) => void = () => undefined;
    reload.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const section = makeSection();
    reloadButton(section.element).click();
    reloadButton(section.element).click();
    expect(reload).toHaveBeenCalledTimes(1);
    finish({ ok: true, count: 1 });
    await flushMicrotasks(4);
    reloadButton(section.element).click();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('unhooks the click listeners on dispose', async () => {
    const section = makeSection();
    section.dispose();
    openButton(section.element).click();
    rulesButton(section.element).click();
    reloadButton(section.element).click();
    await flushMicrotasks(4);
    expect(openFolder).not.toHaveBeenCalled();
    expect(openRulesFolder).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
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
