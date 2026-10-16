import { el } from '../lib/dom';
import { createContextualHelp, helpAccessibleName } from './fieldHelp';
import type { StatusBannerSink } from './statusBanner';

/**
 * The Settings panel's Skills tab. It holds one action: **Custom skills
 * folder**, which opens the user's skills folder in the OS file manager (main
 * creates it when missing). Skills are read at startup only, so the help badge
 * says to restart after adding one. There is nothing to save, hence no
 * snapshot to read.
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

export function createSkillsSection(options: SkillsSectionOptions): SkillsSection {
  const openButton = el('sp-action-button', {
    attrs: { 'data-testid': 'skills-open-folder' },
    text: OPEN_FOLDER_LABEL,
  });

  async function openFolder(): Promise<void> {
    try {
      const result = await window.daisy.skills.openFolder();
      if (!result.ok) options.status.showError(result.error.message);
    } catch (error) {
      options.status.showError(error instanceof Error ? error.message : String(error));
    }
  }

  const onClick = (): void => void openFolder();
  openButton.addEventListener('click', onClick);

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

  const section = el('div', {
    attrs: { class: 'settings-section skills-section', 'aria-label': 'Skills' },
    children: [row],
  });

  return {
    element: section,
    dispose(): void {
      openButton.removeEventListener('click', onClick);
    },
  };
}
