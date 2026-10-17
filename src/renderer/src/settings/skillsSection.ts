import { el } from '../lib/dom';
import { createContextualHelp, helpAccessibleName } from './fieldHelp';
import type { StatusBannerSink } from './statusBanner';

/**
 * The Settings panel's Skills tab. It holds two actions: **Custom skills
 * folder** and **Custom rules folder**, each opening the user's folder in the
 * OS file manager (main creates it when missing). Skills and rules are read at
 * startup only, so the help badges say to restart after adding one. There is
 * nothing to save, hence no snapshot to read.
 */
export interface SkillsSectionOptions {
  /** The panel's single status slot, used to report a failed open. */
  status: StatusBannerSink;
}

export interface SkillsSection {
  readonly element: HTMLElement;
  dispose(): void;
}

const OPEN_FOLDER_LABEL = 'Custom skills folder';
const OPEN_RULES_FOLDER_LABEL = 'Custom rules folder';

export function createSkillsSection(options: SkillsSectionOptions): SkillsSection {
  const openButton = el('sp-action-button', {
    attrs: { 'data-testid': 'skills-open-folder' },
    text: OPEN_FOLDER_LABEL,
  });
  const openRulesButton = el('sp-action-button', {
    attrs: { 'data-testid': 'rules-open-folder' },
    text: OPEN_RULES_FOLDER_LABEL,
  });

  async function openFolder(
    open: () => Promise<{ ok: boolean; error?: { message: string } }>,
  ): Promise<void> {
    try {
      const result = await open();
      if (!result.ok && result.error) options.status.showError(result.error.message);
    } catch (error) {
      options.status.showError(error instanceof Error ? error.message : String(error));
    }
  }

  const onClick = (): void => void openFolder(() => window.daisy.skills.openFolder());
  const onRulesClick = (): void => void openFolder(() => window.daisy.rules.openFolder());
  openButton.addEventListener('click', onClick);
  openRulesButton.addEventListener('click', onRulesClick);

  const row = el('div', {
    attrs: { class: 'field-label-row' },
    children: [
      openButton,
      createContextualHelp(
        'Place your skills in the folder. Restart the application for new skills to apply',
        helpAccessibleName(OPEN_FOLDER_LABEL),
      ),
    ],
  });

  const rulesRow = el('div', {
    attrs: { class: 'field-label-row' },
    children: [
      openRulesButton,
      createContextualHelp(
        'Place your rules as markdown files in the folder. A rule applies to every project, or only to the projects named in its project front matter. Restart the application for new rules to apply',
        helpAccessibleName(OPEN_RULES_FOLDER_LABEL),
      ),
    ],
  });

  const section = el('div', {
    attrs: { class: 'settings-section skills-section', 'aria-label': 'Skills' },
    children: [row, rulesRow],
  });

  return {
    element: section,
    dispose(): void {
      openButton.removeEventListener('click', onClick);
      openRulesButton.removeEventListener('click', onRulesClick);
    },
  };
}
