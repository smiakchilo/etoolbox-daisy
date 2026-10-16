import type { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSkillsSection } from '../../../../src/renderer/src/settings/skillsSection';
import type { StatusBannerSink } from '../../../../src/renderer/src/settings/statusBanner';
import { flushMicrotasks } from '../../../support/asyncWaits';
import { installJsdomGlobals } from '../../../support/jsdomGlobals';
import { byTestId } from '../../../support/selectors';

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
const showError = vi.fn();

function openButton(element: HTMLElement): HTMLElement {
  const button = element.querySelector<HTMLElement>(byTestId('skills-open-folder'));
  if (button === null) throw new Error('open-folder control not found');
  return button;
}

beforeEach(() => {
  openFolder.mockReset();
  showError.mockReset();
  openFolder.mockResolvedValue({ ok: true });
  status = {
    showStatus: vi.fn(),
    showError,
    showPrompt: vi.fn(),
    showNotice: vi.fn(),
    clear: vi.fn(),
  };
  ({ dom, restore: restoreGlobals } = installJsdomGlobals());
  Reflect.set(dom.window, 'daisy', { skills: { openFolder } });
});

afterEach(() => {
  restoreGlobals();
});

describe('createSkillsSection', () => {
  it('carries the open-folder control and exactly one help badge', () => {
    const section = createSkillsSection({ status });
    expect(section.element.querySelectorAll('sp-contextual-help')).toHaveLength(1);
    expect(openButton(section.element)).not.toBeNull();
  });

  it('asks main to open the folder and stays quiet on success', async () => {
    const section = createSkillsSection({ status });
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
    const section = createSkillsSection({ status });
    openButton(section.element).click();
    await flushMicrotasks(4);
    expect(showError).toHaveBeenCalledWith('no file manager');
  });

  it('shows a rejected call as an error rather than throwing', async () => {
    openFolder.mockRejectedValue(new Error('ipc gone'));
    const section = createSkillsSection({ status });
    openButton(section.element).click();
    await flushMicrotasks(4);
    expect(showError).toHaveBeenCalledWith('ipc gone');
  });

  it('unhooks the click listener on dispose', async () => {
    const section = createSkillsSection({ status });
    section.dispose();
    openButton(section.element).click();
    await flushMicrotasks(4);
    expect(openFolder).not.toHaveBeenCalled();
  });
});
