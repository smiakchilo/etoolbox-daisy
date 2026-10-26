import { el } from '../lib/dom';
import { subscribeUpdateStatus } from '../lib/updateStatusFeed';
import type { AppSettingsSnapshot, UpdateRuntimePart, UpdateStatus } from '../../../shared';
import { createContextualHelp, helpAccessibleName, labelledField } from './fieldHelp';
import { confirmDestructiveAction, type SaveOutcome, type StatusBannerSink } from './statusBanner';

/**
 * The Settings panel's Updates tab (last in the strip).
 *
 * The first line holds **Check for updates** and, beside it, **Update** - shown
 * only while an update is pending (`available`) - then a short status phrase.
 * After a subsection gap: the **Check for updates on startup** checkbox (off by
 * default), then the **Custom update URL** (checked before the built-in places).
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
  /** Re-reads the URL field and the startup checkbox from the snapshot. */
  update(snapshot: AppSettingsSnapshot): void;
  dispose(): void;
}

const CHECK_LABEL = 'Check for updates';
const UPDATE_LABEL = 'Update';
const URL_LABEL = 'Custom update URL';
const STARTUP_LABEL = 'Check for updates on startup';

/** How a part of the runtime layer reads in a status phrase. */
const RUNTIME_PART_LABELS: Readonly<Record<UpdateRuntimePart, string>> = {
  format: 'the update mechanism',
  electron: 'the Electron version',
  payload: 'the agent runtime',
};

/**
 * Says which part of the runtime layer blocks the update: a fresh installation
 * is only understandable if the reader is told what changed.
 */
function describeChangedRuntime(changed: readonly UpdateRuntimePart[] | undefined): string {
  if (changed === undefined || changed.length === 0) return '';
  return ` (${changed.map((part) => RUNTIME_PART_LABELS[part]).join(' and ')} changed)`;
}

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
    case 'installerRequired':
      return `Version ${status.version} needs a fresh installation${describeChangedRuntime(status.changed)}`;
    case 'applying':
      return 'Updating\u2026';
    case 'failed':
      return status.phase === 'check'
        ? 'Could not check for updates'
        : 'Could not apply the update';
  }
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

  const urlFieldId = 'updates-url';
  const urlField = el('sp-textfield', {
    attrs: {
      id: urlFieldId,
      class: 'host-field__input',
      placeholder: 'E.g.: https://github.com/owner/repo/tree/main/update',
      'aria-label': URL_LABEL,
      'data-field': 'updates-url',
    },
  }) as TextField;
  const urlRow = labelledField(
    urlFieldId,
    URL_LABEL,
    urlField,
    'A GitHub folder holding update.json, checked before the built-in places. Must start with https',
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
    children: [startupRow, urlRow],
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

  const onCheckClick = (): void => void runUpdateCall(() => window.daisy.updates.check());
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
    url?: string | null;
    checkOnStartup?: boolean;
  }): Promise<SaveOutcome> {
    try {
      const result = await window.daisy.settings.updateUpdateSettings({ changes });
      return result.ok ? { ok: true } : { ok: false, error: result.error.message };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  function report(changes: { url?: string | null; checkOnStartup?: boolean }): void {
    const outcome = save(changes);
    options.reportSave(outcome);
    void outcome.then((result) => {
      if (result.ok) options.onSettingsChanged();
    });
  }

  const onUrlCommit = (): void => {
    if (rendering) return;
    const value = urlField.value.trim();
    report({ url: value === '' ? null : value });
  };
  const onStartupChange = (): void => {
    if (rendering) return;
    report({ checkOnStartup: startupCheckbox.checked });
  };
  urlField.addEventListener('change', onUrlCommit);
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
      urlField.value = snapshot.updates.url ?? '';
      startupCheckbox.checked = snapshot.updates.checkOnStartup;
      rendering = false;
    },
    dispose(): void {
      unsubscribe();
      checkButton.removeEventListener('click', onCheckClick);
      updateButton.removeEventListener('click', onUpdateClick);
      urlField.removeEventListener('change', onUrlCommit);
      startupCheckbox.removeEventListener('change', onStartupChange);
    },
  };
}
