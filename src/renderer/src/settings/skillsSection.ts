import { el } from '../lib/dom';
import type { AppSettingsSnapshot } from '../../../shared';
import { createContextualHelp, helpAccessibleName } from './fieldHelp';
import type { SaveOutcome, StatusBannerSink } from './statusBanner';

/**
 * The Settings panel's Skills tab. It holds three folder actions - **Custom
 * skills folder**, **Custom rules folder** and **Memos folder** - each opening
 * the user's folder in the OS file manager (main creates it when missing), and
 * the **Self-learning** checkbox (`memos.enabled`), plus icon-only reload
 * buttons for skills and rules, which re-read those sources without a restart.
 * Memos and the checkbox are read fresh on every prompt.
 * The checkbox saves immediately, like the Browser tab's.
 */
export interface SkillsSectionOptions {
  /** The panel's single status slot, used to report a failed open. */
  status: StatusBannerSink;
  /** Registers the save with the panel's save reporter. */
  reportSave(outcome: Promise<SaveOutcome>): void;
  /** Fired after a successful save, so the panel re-reads the snapshot. */
  onSettingsChanged(): void;
  /** Fired after skills were re-read, so the chat refreshes its skill list. */
  onSkillsReloaded?(): void;
}

export interface SkillsSection {
  readonly element: HTMLElement;
  /** Re-reads the Self-learning checkbox from the snapshot. */
  update(snapshot: AppSettingsSnapshot): void;
  dispose(): void;
}

const OPEN_FOLDER_LABEL = 'Custom skills folder';
const RELOAD_SKILLS_LABEL = 'Reload skills';
const RELOAD_RULES_LABEL = 'Reload rules';

/** An icon-only quiet button wearing the browser toolbar's refresh glyph. */
function createReloadButton(testId: string, label: string): HTMLElement {
  const button = el('sp-action-button', {
    attrs: {
      quiet: '',
      title: label,
      'aria-label': label,
      'data-testid': testId,
      class: 'skills-section__reload',
    },
  });
  const icon = document.createElement('sp-icon-refresh');
  icon.setAttribute('slot', 'icon');
  button.append(icon);
  return button;
}
const OPEN_RULES_FOLDER_LABEL = 'Custom rules folder';
const OPEN_MEMOS_FOLDER_LABEL = 'Memos folder';
const SELF_LEARNING_LABEL = 'Self-learning';

export function createSkillsSection(options: SkillsSectionOptions): SkillsSection {
  const openButton = el('sp-action-button', {
    attrs: { 'data-testid': 'skills-open-folder' },
    text: OPEN_FOLDER_LABEL,
  });
  const reloadButton = createReloadButton('skills-reload', RELOAD_SKILLS_LABEL);
  const reloadRulesButton = createReloadButton('rules-reload', RELOAD_RULES_LABEL);
  const openRulesButton = el('sp-action-button', {
    attrs: { 'data-testid': 'rules-open-folder' },
    text: OPEN_RULES_FOLDER_LABEL,
  });
  const openMemosButton = el('sp-action-button', {
    attrs: { 'data-testid': 'memos-open-folder' },
    text: OPEN_MEMOS_FOLDER_LABEL,
  });
  const selfLearning = el('sp-checkbox', {
    attrs: { id: 'memos-enabled', 'data-field': 'memos-enabled' },
    text: SELF_LEARNING_LABEL,
  }) as HTMLElement & { checked: boolean };

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

  let reloading = false;
  async function reload(
    run: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>,
    doneMessage: string,
    onDone?: () => void,
  ): Promise<void> {
    if (reloading) return;
    reloading = true;
    try {
      const result = await run();
      if (result.ok) {
        options.status.showStatus(doneMessage);
        onDone?.();
      } else {
        options.status.showError(result.error.message);
      }
    } catch (error) {
      options.status.showError(error instanceof Error ? error.message : String(error));
    } finally {
      reloading = false;
    }
  }
  const onReloadClick = (): void =>
    void reload(
      () => window.daisy.skills.reload(),
      'Skills reloaded',
      () => options.onSkillsReloaded?.(),
    );
  const onReloadRulesClick = (): void =>
    void reload(() => window.daisy.rules.reload(), 'Rules reloaded');
  reloadButton.addEventListener('click', onReloadClick);
  reloadRulesButton.addEventListener('click', onReloadRulesClick);
  const onRulesClick = (): void => void openFolder(() => window.daisy.rules.openFolder());
  openButton.addEventListener('click', onClick);
  openRulesButton.addEventListener('click', onRulesClick);
  const onMemosClick = (): void => void openFolder(() => window.daisy.memos.openFolder());
  openMemosButton.addEventListener('click', onMemosClick);

  // Guards `update` against the `change` event assigning `.checked` can emit
  // in some environments (the same guard the Browser section uses).
  let rendering = false;

  async function saveSelfLearning(enabled: boolean): Promise<SaveOutcome> {
    try {
      const result = await window.daisy.settings.updateMemoSettings({ changes: { enabled } });
      return result.ok ? { ok: true } : { ok: false, error: result.error.message };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  function onSelfLearningChange(): void {
    if (rendering) return;
    const outcome = saveSelfLearning(selfLearning.checked);
    options.reportSave(outcome);
    void outcome.then((result) => {
      if (result.ok) options.onSettingsChanged();
    });
  }
  selfLearning.addEventListener('change', onSelfLearningChange);

  const row = el('div', {
    attrs: { class: 'field-label-row' },
    children: [
      openButton,
      reloadButton,
      createContextualHelp(
        'Place your skills in the folder, then press Reload skills. Rules and memos are separate. Changes apply to the next prompt',
        helpAccessibleName(OPEN_FOLDER_LABEL),
      ),
    ],
  });

  const rulesRow = el('div', {
    attrs: { class: 'field-label-row' },
    children: [
      openRulesButton,
      reloadRulesButton,
      createContextualHelp(
        'Place your rules as markdown files in the folder, then press Reload rules. A rule applies to every project, or only to the projects named in its project front matter. Changes apply to the next prompt',
        helpAccessibleName(OPEN_RULES_FOLDER_LABEL),
      ),
    ],
  });

  const selfLearningRow = el('div', {
    attrs: { class: 'field-label-row' },
    children: [
      selfLearning,
      createContextualHelp(
        'Lets the assistant write down lessons from corrections and failures, and read them in later chats. Changes apply to the next prompt',
        helpAccessibleName(SELF_LEARNING_LABEL),
      ),
    ],
  });

  const memosRow = el('div', {
    attrs: { class: 'field-label-row' },
    children: [
      openMemosButton,
      createContextualHelp(
        'The lessons the assistant has written down, as markdown files you can edit or delete. Changes apply to the next prompt',
        helpAccessibleName(OPEN_MEMOS_FOLDER_LABEL),
      ),
    ],
  });

  // The tab's three subsections: skills, rules, and the memos pair. The last
  // two rows travel together, so the section's doubled gap marks only the three
  // boundaries between subsections, never the pair's own 8px spacing.
  const memosGroup = el('div', {
    attrs: { class: 'skills-section__group' },
    children: [selfLearningRow, memosRow],
  });

  // `.subsection-gap` widens the gap before each subsection (see settings.css);
  // the memos pair below keeps the section's own plain field gap.
  const section = el('div', {
    attrs: { class: 'settings-section skills-section subsection-gap', 'aria-label': 'Skills' },
    children: [row, rulesRow, memosGroup],
  });

  return {
    element: section,
    update(snapshot): void {
      rendering = true;
      selfLearning.checked = snapshot.memos.enabled;
      rendering = false;
    },
    dispose(): void {
      openButton.removeEventListener('click', onClick);
      reloadButton.removeEventListener('click', onReloadClick);
      reloadRulesButton.removeEventListener('click', onReloadRulesClick);
      openRulesButton.removeEventListener('click', onRulesClick);
      openMemosButton.removeEventListener('click', onMemosClick);
      selfLearning.removeEventListener('change', onSelfLearningChange);
    },
  };
}
