import { el } from '../lib/dom';
import type { CopilotProxySnapshot } from '../../../shared';
import { createPasswordEntry } from './passwordEntry';
import { createAutoSave } from './autoSave';
import type { SaveOutcome, StatusBannerSink } from './statusBanner';
import { describeProxySnapshot, validateOriginInput } from './viewModel';

/**
 * The global Copilot proxy section (requirements-decisions.md section 7):
 * one proxy shared by every Copilot request, distinct from each server's own
 * AEM proxy in `hostsSection.ts`. Both the address/username and the
 * password have real IPC.
 *
 * The address/username pair auto-saves: every edit is debounced (~1s) and
 * persisted without a Save button, and the outcome is reported into the
 * panel's one banner slot through `reportSave` (so a label save and a proxy
 * save in the same instant collapse into one "Saving..." -> "Settings
 * saved."/"<error>" sequence). A validation failure is shown straight to the
 * banner without going through the save reporter - it is feedback on the
 * field, not a save attempt. The password keeps its explicit Set/Clear
 * buttons (the one mutation whose raw input should never be stored anywhere
 * but the secret store).
 */
export interface ProxySectionOptions {
  /** Fired after the address/username or a password change persisted */
  onCredentialsChanged(): void;
  /** The panel's single status slot. */
  status: StatusBannerSink;
  /** Registers a debounced save with the panel's save reporter. */
  reportSave(outcome: Promise<SaveOutcome>): void;
}

export interface ProxySection {
  readonly element: HTMLElement;
  update(proxy: CopilotProxySnapshot | undefined): void;
  /** Runs any pending save now (the close-and-persist path). */
  flushNow(): Promise<void>;
  /** True while an edit is armed or a save is in flight. */
  hasPendingEdits(): boolean;
  dispose(): void;
}

export function createProxySection(options: ProxySectionOptions): ProxySection {
  const summary = el('p', { attrs: { class: 'proxy-section__summary' } });

  const addressField = el('sp-textfield', {
    attrs: { placeholder: 'https://proxy.example:8080', 'aria-label': 'Copilot proxy address' },
  }) as HTMLElement & { value: string };
  const usernameField = el('sp-textfield', {
    attrs: { placeholder: 'Username', 'aria-label': 'Copilot proxy username' },
  }) as HTMLElement & { value: string };
  const autoSave = createAutoSave();

  const passwordEntry = createPasswordEntry({ kind: 'copilotProxy' }, options.status);
  passwordEntry.onChanged(() => options.onCredentialsChanged());

  /** The last values `update()` applied, so an edit that returns a field to its stored value saves nothing. */
  let lastAppliedUrl = '';
  let lastAppliedUsername = '';

  /** Whether the fields currently hold anything different from the last applied snapshot. */
  function hasRealChanges(): boolean {
    const validated = validateOriginInput(addressField.value);
    if (!validated.ok) return true;
    const username = usernameField.value.trim();
    return !(validated.origin === lastAppliedUrl && username === lastAppliedUsername);
  }

  /**
   * Runs one save with the *current* field values (the scheduler coalesces
   * edits, so this fires at most once per 1s window). Returns the outcome
   * promise for the reportSave wiring, or `undefined` when nothing was saved
   * (validation failed - already shown on the banner - or the fields still
   * match the last applied snapshot values).
   */
  function runSave(): Promise<SaveOutcome> | undefined {
    const validated = validateOriginInput(addressField.value);
    if (!validated.ok) {
      options.status.showError(validated.error);
      return undefined;
    }
    const username = usernameField.value.trim();
    if (validated.origin === lastAppliedUrl && username === lastAppliedUsername) {
      return undefined;
    }
    return window.daisy.settings
      .setCopilotProxy({
        url: validated.origin,
        ...(username !== '' ? { username } : {}),
      })
      .then(
        (result) => (result.ok ? { ok: true } : { ok: false, error: result.error.message }),
        (error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Could not save the proxy settings',
        }),
      );
  }

  function armSave(): void {
    if (!hasRealChanges()) {
      // A blur-driven native `change` re-commits the very values `update()`
      // last applied (e.g. clicking "Set password" blurs these two fields).
      // Arm nothing for it: an armed-but-no-op save would trip the panel's
      // reload guard (`hasPendingEdits()`), skip this section's `update()`,
      // and leave a freshly-stored password invisible in the summary line.
      return;
    }
    autoSave.arm(() => {
      const outcome = runSave();
      if (outcome === undefined) return;
      // The reporter's settle is attached before our own continuation, so a
      // drain that empties the batch is announced before the reload below
      // re-renders the section from the fresh snapshot.
      options.reportSave(outcome);
      void outcome.then((result) => {
        if (result.ok) options.onCredentialsChanged();
      });
    });
  }

  for (const field of [addressField, usernameField]) {
    field.addEventListener('input', armSave);
    field.addEventListener('change', armSave);
  }

  const element = el('section', {
    attrs: { class: 'settings-section', 'aria-label': 'Global Copilot proxy' },
    children: [
      summary,
      el('div', {
        attrs: { class: 'proxy-section__fields' },
        children: [addressField, usernameField],
      }),
      passwordEntry.element,
    ],
  });

  return {
    element,
    update(proxy: CopilotProxySnapshot | undefined): void {
      summary.textContent = describeProxySnapshot(proxy);
      addressField.value = proxy?.url ?? '';
      usernameField.value = proxy?.credentials?.username ?? '';
      lastAppliedUrl = addressField.value;
      lastAppliedUsername = usernameField.value;
    },
    flushNow: () => autoSave.flushNow(),
    // Precise, not `autoSave.hasPending()` alone: an impulse that changed
    // nothing (e.g. the blur "change" of an untouched field) must not count
    // as an unsaved edit, or a reload triggered by the password Save would
    // be skipped and leave a freshly-stored password invisible in the summary.
    hasPendingEdits: () => autoSave.hasPending() && hasRealChanges(),
    dispose: () => autoSave.dispose(),
  };
}
