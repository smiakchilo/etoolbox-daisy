import { el } from '../lib/dom';
import type { ProxyPasswordTarget } from '../../../shared';
import type { StatusBannerSink } from './statusBanner';

/**
 * A "set password" / "clear password" control for one proxy target. This is
 * the one piece of settings mutation that already has real IPC
 * (`setProxyPassword`/`clearProxyPassword`, step 04) - unlike every other
 * mutation in this window, it is fully wired, not a stub.
 *
 * The typed password never leaves this closure other than as the argument to
 * `setProxyPassword`: it is read from the field and the field is cleared
 * immediately after the call settles, win or lose, so nothing here ever
 * holds, displays, or echoes a password value (the hard security boundary
 * from `ProxyCredentialsSnapshot` only ever carrying `hasPassword`).
 *
 * Set/Clear stay explicit buttons (unlike the debounced fields around them):
 * the password's raw text is never supposed to sit in a field that a later
 * automatic save could sweep up, and the two actions are deliberately
 * deliberate. Their results go to the panel's one banner slot through
 * `status` - "Password saved" / "Password cleared" are transient statuses,
 * failures are sticky errors.
 */
export function createPasswordEntry(
  target: ProxyPasswordTarget,
  status: StatusBannerSink,
): {
  readonly element: HTMLElement;
  onChanged(listener: () => void): void;
} {
  const passwordField = el('sp-textfield', {
    attrs: { type: 'password', placeholder: 'New password', 'aria-label': 'Proxy password' },
  }) as HTMLElement & { value: string };

  const setButton = el('sp-button', { attrs: { variant: 'secondary' }, text: 'Set password' });
  const clearButton = el('sp-button', { attrs: { variant: 'secondary' }, text: 'Clear password' });

  let changedListener: (() => void) | undefined;

  function setBusy(busy: boolean): void {
    if (busy) {
      setButton.setAttribute('disabled', '');
      clearButton.setAttribute('disabled', '');
    } else {
      setButton.removeAttribute('disabled');
      clearButton.removeAttribute('disabled');
    }
  }

  setButton.addEventListener('click', () => {
    const password = passwordField.value;
    if (password === '') {
      status.showError('Enter a password first');
      return;
    }
    setBusy(true);
    void window.daisy.settings
      .setProxyPassword(target, password)
      .then((result) => {
        if (result.ok) {
          status.showStatus('Password saved');
          changedListener?.();
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
    setBusy(true);
    void window.daisy.settings
      .clearProxyPassword(target)
      .then((result) => {
        if (result.ok) {
          status.showStatus('Password cleared');
          changedListener?.();
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
    attrs: { class: 'password-entry' },
    children: [passwordField, setButton, clearButton],
  });

  return {
    element,
    onChanged(listener: () => void): void {
      changedListener = listener;
    },
  };
}
