import { el } from '../lib/dom';
import type { CopilotProxySnapshot } from '../../../shared';
import { createPasswordEntry } from './passwordEntry';
import { describeProxySnapshot, validateOriginInput } from './viewModel';

/**
 * The global Copilot proxy section (requirements-decisions.md section 7):
 * one proxy shared by every Copilot request, distinct from each server's own
 * AEM proxy in `serversSection.ts`. Both the address/username and the
 * password have real IPC.
 */
export interface ProxySection {
  readonly element: HTMLElement;
  update(proxy: CopilotProxySnapshot | undefined): void;
}

export function createProxySection(onCredentialsChanged: () => void): ProxySection {
  const summary = el('p', { attrs: { class: 'proxy-section__summary' } });
  const addressStatus = el('p', { attrs: { class: 'proxy-section__status' } });

  const addressField = el('sp-textfield', {
    attrs: { placeholder: 'https://proxy.example:8080', 'aria-label': 'Copilot proxy address' },
  }) as HTMLElement & { value: string };
  const usernameField = el('sp-textfield', {
    attrs: { placeholder: 'Username', 'aria-label': 'Copilot proxy username' },
  }) as HTMLElement & { value: string };
  const saveButton = el('sp-button', { attrs: { variant: 'secondary' }, text: 'Save address' });
  saveButton.addEventListener('click', () => {
    const validated = validateOriginInput(addressField.value);
    if (!validated.ok) {
      addressStatus.textContent = validated.error;
      return;
    }
    const username = usernameField.value.trim();
    addressStatus.textContent = '';
    saveButton.setAttribute('disabled', '');
    void window.daisy.settings
      .setCopilotProxy({
        url: validated.origin,
        ...(username !== '' ? { username } : {}),
      })
      .then((result) => {
        if (!result.ok) {
          addressStatus.textContent = result.error.message;
          return;
        }
        onCredentialsChanged();
      })
      .finally(() => saveButton.removeAttribute('disabled'));
  });

  const passwordEntry = createPasswordEntry({ kind: 'copilotProxy' });
  passwordEntry.onChanged(onCredentialsChanged);

  const element = el('section', {
    attrs: { class: 'settings-section', 'aria-label': 'Global Copilot proxy' },
    children: [
      summary,
      el('div', {
        attrs: { class: 'proxy-section__fields' },
        children: [addressField, usernameField, saveButton],
      }),
      addressStatus,
      passwordEntry.element,
    ],
  });

  return {
    element,
    update(proxy: CopilotProxySnapshot | undefined): void {
      summary.textContent = describeProxySnapshot(proxy);
      addressField.value = proxy?.url ?? '';
      usernameField.value = proxy?.credentials?.username ?? '';
    },
  };
}
