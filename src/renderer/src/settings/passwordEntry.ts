import { el } from '../lib/dom';
import type { PasswordTarget } from '../../../shared';
import type { StatusBannerSink } from './statusBanner';

/**
 * A per-item "Set" / "Clear" password control rendered on the same line as
 * its password field. Unlike the debounced label/address/username fields
 * around it, this is one deliberate two-action control: the password's raw
 * text is never supposed to sit in a field a later automatic save could sweep
 * up, so set/clear stay explicit.
 *
 * The typed password never leaves this closure other than as the argument to
 * `setPassword`: it is read from the field and the field is cleared
 * immediately after the call settles, win or lose, so nothing here ever
 * holds, displays, or echoes a password value (the hard security boundary
 * from `ProxyCredentialsSnapshot` only ever carrying `hasPassword`).
 *
 * The target is resolved at click time through `options.target` rather than
 * captured: an item starts as an unsaved draft (no id) and becomes a real
 * entry after its first save, all on the same element instance. Results go to
 * the panel's one banner slot through `status` - "Password saved" / "Password
 * cleared" are transient statuses, failures are sticky errors.
 */
export interface PasswordControlOptions {
  /** Resolves the target at click time; `undefined` while a draft has no id yet. */
  readonly target: () => PasswordTarget | undefined;
  /** Called after a successful set/clear so the panel re-reads the snapshot. */
  readonly onChanged: () => void;
}

export interface PasswordControl {
  readonly element: HTMLElement;
}

export function createPasswordControl(
  options: PasswordControlOptions,
  status: StatusBannerSink,
): PasswordControl {
  const passwordField = el('sp-textfield', {
    attrs: { type: 'password', placeholder: 'New password', 'aria-label': 'Password' },
  }) as HTMLElement & { value: string };

  const setButton = el('sp-action-button', {
    attrs: { quiet: '', label: 'Set password' },
    text: 'Set',
  });
  const clearButton = el('sp-action-button', {
    attrs: { quiet: '', label: 'Clear password' },
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
      status.showError('Save the item before setting a password');
      return;
    }
    const password = passwordField.value;
    if (password === '') {
      status.showError('Enter a password first');
      return;
    }
    setBusy(true);
    void window.daisy.settings
      .setPassword(target, password)
      .then((result) => {
        if (result.ok) {
          status.showStatus('Password saved');
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
      status.showError('Save the item before clearing a password');
      return;
    }
    setBusy(true);
    void window.daisy.settings
      .clearPassword(target)
      .then((result) => {
        if (result.ok) {
          status.showStatus('Password cleared');
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
