import { el } from '../lib/dom';
import type { PasswordTarget } from '../../../shared';
import type { StatusBannerSink } from './statusBanner';

/**
 * A per-item "Set" / "Clear" secret control rendered on the same line as its
 * secret field. Unlike the debounced label/address/username fields around it,
 * this is one deliberate two-action control: the secret's raw text is never
 * supposed to sit in a field a later automatic save could sweep up, so
 * set/clear stay explicit.
 *
 * The typed secret never leaves this closure other than as the argument to
 * `setPassword`: it is read from the field and the field is cleared
 * immediately after the call settles, win or lose, so nothing here ever
 * holds, displays, or echoes the value (the hard security boundary from
 * `ProxyCredentialsSnapshot` only ever carrying `hasPassword`).
 *
 * The target is resolved at click time through `options.target` rather than
 * captured: an item starts as an unsaved draft (no id) and becomes a real
 * entry after its first save, all on the same element instance. Results go to
 * the panel's one banner slot through `status` - "Password saved" / "Password
 * cleared" (or "Token saved" / "Token cleared") are transient statuses,
 * failures are sticky errors.
 *
 * The same control serves the Agents tab's Token field: `options.noun` names
 * what is being stored, and every label/message is derived from it, so the
 * defaults reproduce the Proxies tab's password wording exactly.
 */
export interface PasswordControlOptions {
  /** Resolves the target at click time; `undefined` while a draft has no id yet. */
  readonly target: () => PasswordTarget | undefined;
  /** Called after a successful set/clear so the panel re-reads the snapshot. */
  readonly onChanged: () => void;
  /**
   * What the stored secret is called in labels and messages. Defaults to
   * `"password"`; the Agents tab passes `"token"`.
   */
  readonly noun?: string;
}

export interface PasswordControl {
  readonly element: HTMLElement;
}

export function createPasswordControl(
  options: PasswordControlOptions,
  status: StatusBannerSink,
): PasswordControl {
  const noun = options.noun ?? 'password';
  const nounLabel = noun.charAt(0).toUpperCase() + noun.slice(1);

  const passwordField = el('sp-textfield', {
    attrs: { type: 'password', placeholder: `New ${noun}`, 'aria-label': nounLabel },
  }) as HTMLElement & { value: string };

  const setButton = el('sp-action-button', {
    attrs: { quiet: '', label: `Set ${noun}` },
    text: 'Set',
  });
  const clearButton = el('sp-action-button', {
    attrs: { quiet: '', label: `Clear ${noun}` },
    text: 'Clear',
  });

  function setBusy(busy: boolean): void {
    for (const button of [setButton, clearButton]) {
      if (busy) button.setAttribute('disabled', '');
      else button.removeAttribute('disabled');
    }
  }

  setButton.addEventListener('click', () => {
    const target = options.target();
    if (target === undefined) {
      status.showError(`Save the item before setting a ${noun}`);
      return;
    }
    const password = passwordField.value;
    if (password === '') {
      status.showError(`Enter a ${noun} first`);
      return;
    }
    setBusy(true);
    void window.daisy.settings
      .setPassword(target, password)
      .then((result) => {
        if (result.ok) {
          status.showStatus(`${nounLabel} saved`);
          options.onChanged();
        } else {
          status.showError(result.error.message);
        }
      })
      .finally(() => {
        passwordField.value = '';
        setBusy(false);
      });
  });

  clearButton.addEventListener('click', () => {
    const target = options.target();
    if (target === undefined) {
      status.showError(`Save the item before clearing a ${noun}`);
      return;
    }
    setBusy(true);
    void window.daisy.settings
      .clearPassword(target)
      .then((result) => {
        if (result.ok) {
          status.showStatus(`${nounLabel} cleared`);
          options.onChanged();
        } else {
          status.showError(result.error.message);
        }
      })
      .finally(() => {
        passwordField.value = '';
        setBusy(false);
      });
  });

  const element = el('div', {
    attrs: { class: 'password-control' },
    children: [passwordField, setButton, clearButton],
  });

  return { element };
}
