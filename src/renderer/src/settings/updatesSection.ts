import { el } from '../lib/dom';
import { markUserRequestedUpdateCheck, subscribeUpdateStatus } from '../lib/updateStatusFeed';
import type { AppSettingsSnapshot, UpdateStatus } from '../../../shared';
import { createContextualHelp, helpAccessibleName, labelledField } from './fieldHelp';
import { confirmDestructiveAction, type SaveOutcome, type StatusBannerSink } from './statusBanner';

/**
 * The Settings panel's Updates tab (last in the strip).
 *
 * The first line holds **Check for updates** and, beside it, **Update** - shown
 * only while an update is pending (`available`) - then a short status phrase.
 * After a subsection gap: the **Check for updates on startup** checkbox (off by
 * default), then the **Update source** (a branch, a tag or an https zip URL).
 * Both settings save
 * immediately; the status itself is main's (`window.daisy.updates`), so this
 * section only renders what main pushes and asks main to check or apply.
 *
 * **Update** confirms first (a chat turn may be running), through the shared
 * destructive-confirm prompt, because applying ends with the app quitting.
 */
export interface UpdatesSectionOptions {
  /** The panel's single status slot. */
  status: StatusBannerSink;
  /** Registers the save with the panel's save reporter. */
  reportSave(outcome: Promise<SaveOutcome>): void;
  /** Fired after a successful save, so the panel re-reads the snapshot. */
  onSettingsChanged(): void;
}

export interface UpdatesSection {
  readonly element: HTMLElement;
  /** Re-reads the source field and the startup checkbox from the snapshot. */
  update(snapshot: AppSettingsSnapshot): void;
  dispose(): void;
}

const CHECK_LABEL = 'Check for updates';
const UPDATE_LABEL = 'Update';
const SOURCE_LABEL = 'Update source';
const STARTUP_LABEL = 'Check for updates on startup';

/** The phrase the section shows beside its buttons; empty when there is nothing to say. */
export function describeUpdateStatus(status: UpdateStatus): string {
  switch (status.kind) {
    case 'idle':
      return '';
    case 'checking':
      return 'Checking\u2026';
    case 'upToDate':
      return 'You have the latest version';
    case 'available':
      return `Version ${status.version} is available`;
    case 'applying':
      return status.text === undefined ? 'Updating\u2026' : `Updating: ${status.text}`;
    case 'updated':
      return `Updated to version ${status.version}`;
    case 'failed':
      // A failed *check* is the answer to the button the reader just pressed, so
      // it stays here. A failed *apply* is reported in the pane's banner instead
      // (see `describeUpdateApplyFailure`), where it survives the panel closing;
      // this label clears so the same message is not shown twice.
      return status.phase === 'check'
        ? `Could not check for updates${status.reason === undefined ? '' : `: ${status.reason}`}`
        : '';
  }
}

/**
 * The pane-banner message for a failed apply, or `undefined` for any other
 * status. Applying ends in "nothing happened, and here is why" - the one update
 * outcome worth a sticky status row that outlives the Settings panel (the
 * button line's label is cleared for it, so the message lives in one place).
 */
export function describeUpdateApplyFailure(status: UpdateStatus): string | undefined {
  if (status.kind !== 'failed' || status.phase !== 'apply') return undefined;
  return status.reason === undefined
    ? 'Could not apply the update'
    : `Could not apply the update: ${status.reason}`;
}

type TextField = HTMLElement & { value: string };

export function createUpdatesSection(options: UpdatesSectionOptions): UpdatesSection {
  const checkButton = el('sp-action-button', {
    attrs: { 'data-testid': 'updates-check' },
    text: CHECK_LABEL,
  }) as HTMLElement & { disabled: boolean };
  const updateButton = el('sp-action-button', {
    attrs: { class: 'action-button--primary', 'data-testid': 'updates-apply', hidden: '' },
    text: UPDATE_LABEL,
  }) as HTMLElement & { disabled: boolean };
  const statusText = el('span', {
    attrs: { class: 'updates-section__status', 'data-testid': 'updates-status' },
  });

  const actionsRow = el('div', {
    attrs: { class: 'field-label-row updates-section__actions' },
    children: [checkButton, updateButton, statusText],
  });

  const sourceFieldId = 'updates-source';
  const sourceField = el('sp-textfield', {
    attrs: {
      id: sourceFieldId,
      class: 'host-field__input',
      placeholder: 'E.g.: master',
      'aria-label': SOURCE_LABEL,
      'data-field': 'updates-source',
    },
  }) as TextField;
  const sourceRow = labelledField(
    sourceFieldId,
    SOURCE_LABEL,
    sourceField,
    'A branch or tag of the repository to update from, or an https link to a source zip. Empty means the main branch',
  );

  const startupCheckbox = el('sp-checkbox', {
    attrs: { id: 'updates-check-on-startup', 'data-field': 'updates-check-on-startup' },
    text: STARTUP_LABEL,
  }) as HTMLElement & { checked: boolean };
  const startupRow = el('div', {
    attrs: { class: 'field-label-row' },
    children: [
      startupCheckbox,
      createContextualHelp(
        'Checks quietly once the app has started and offers the update if one is found',
        helpAccessibleName(STARTUP_LABEL),
      ),
    ],
  });

  // `.subsection-gap` sets the 24px boundary between the button line and the two
  // settings (see settings.css); the settings keep the plain gap between them.
  const settingsGroup = el('div', {
    attrs: { class: 'updates-section__group' },
    children: [startupRow, sourceRow],
  });

  const section = el('div', {
    attrs: {
      class: 'settings-section updates-section subsection-gap',
      'aria-label': 'Updates',
    },
    children: [actionsRow, settingsGroup],
  });

  function render(status: UpdateStatus): void {
    statusText.textContent = describeUpdateStatus(status);
    // A failed apply belongs in the pane's status row, not beside the buttons:
    // the message stays readable after the panel is dismissed, and the label has
    // already cleared for it (see `describeUpdateStatus`).
    const applyFailure = describeUpdateApplyFailure(status);
    if (applyFailure !== undefined) options.status.showError(applyFailure);
    const busy = status.kind === 'checking' || status.kind === 'applying';
    checkButton.disabled = busy;
    updateButton.disabled = busy;
    updateButton.toggleAttribute('hidden', status.kind !== 'available');
  }

  async function runUpdateCall(
    call: () => Promise<{ ok: boolean; status?: UpdateStatus; error?: { message: string } }>,
  ): Promise<void> {
    try {
      const result = await call();
      if (result.ok && result.status !== undefined) render(result.status);
      else if (!result.ok && result.error) options.status.showError(result.error.message);
    } catch (error) {
      options.status.showError(error instanceof Error ? error.message : String(error));
    }
  }

  const onCheckClick = (): void => {
    // The result is answered here, beside the button the reader pressed, so its
    // availability must not also raise the chat pane's fallback notice.
    markUserRequestedUpdateCheck();
    void runUpdateCall(() => window.daisy.updates.check());
  };
  const onUpdateClick = (): void => {
    confirmDestructiveAction(options.status, 'install the update and restart the app', () => {
      void runUpdateCall(() => window.daisy.updates.apply());
    });
  };
  checkButton.addEventListener('click', onCheckClick);
  updateButton.addEventListener('click', onUpdateClick);

  const unsubscribe = subscribeUpdateStatus(render);

  // Guards `update` against the `change` event assigning `.checked` can emit
  // in some environments (the same guard the Browser section uses).
  let rendering = false;

  async function save(changes: {
    source?: string | null;
    checkOnStartup?: boolean;
  }): Promise<SaveOutcome> {
    try {
      const result = await window.daisy.settings.updateUpdateSettings({ changes });
      return result.ok ? { ok: true } : { ok: false, error: result.error.message };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  function report(changes: { source?: string | null; checkOnStartup?: boolean }): void {
    const outcome = save(changes);
    options.reportSave(outcome);
    void outcome.then((result) => {
      if (result.ok) options.onSettingsChanged();
    });
  }

  const onSourceCommit = (): void => {
    if (rendering) return;
    const value = sourceField.value.trim();
    report({ source: value === '' ? null : value });
  };
  const onStartupChange = (): void => {
    if (rendering) return;
    report({ checkOnStartup: startupCheckbox.checked });
  };
  sourceField.addEventListener('change', onSourceCommit);
  startupCheckbox.addEventListener('change', onStartupChange);

  void window.daisy.updates
    .getStatus()
    .then((result) => {
      if (result.ok) render(result.status);
    })
    .catch(() => undefined);

  return {
    element: section,
    update(snapshot): void {
      rendering = true;
      sourceField.value = snapshot.updates.source ?? '';
      startupCheckbox.checked = snapshot.updates.checkOnStartup;
      rendering = false;
    },
    dispose(): void {
      unsubscribe();
      checkButton.removeEventListener('click', onCheckClick);
      updateButton.removeEventListener('click', onUpdateClick);
      sourceField.removeEventListener('change', onSourceCommit);
      startupCheckbox.removeEventListener('change', onStartupChange);
    },
  };
}
