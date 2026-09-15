import { el } from '../lib/dom';
import type { AuthStatus } from '../../../shared';

/**
 * Authentication status section: uses the real `window.daisy.agent` sign-in
 * API, presented as one line of Settings. Sign-in/out are real; there is no
 * stub here.
 */
export interface AuthenticationSection {
  readonly element: HTMLElement;
  refresh(): Promise<void>;
}

export function createAuthenticationSection(): AuthenticationSection {
  const statusLight = el('sp-status-light', { attrs: { variant: 'neutral' }, text: 'Checking...' });
  const warning = el('p', { attrs: { class: 'authentication-section__warning' } });

  const signInButton = el('sp-button', { attrs: { variant: 'accent' }, text: 'Sign in' });
  const signOutButton = el('sp-button', {
    attrs: { variant: 'secondary' },
    text: 'Sign out (local only)',
  });

  async function refresh(): Promise<void> {
    try {
      const status: AuthStatus = await window.daisy.agent.getAuthStatus();
      if (status.isAuthenticated) {
        statusLight.setAttribute('variant', 'positive');
        statusLight.textContent = `Signed in${status.login ? ` as ${status.login}` : ''}`;
      } else {
        statusLight.setAttribute('variant', 'negative');
        statusLight.textContent = status.statusMessage ?? 'Not signed in';
      }
    } catch (error) {
      statusLight.setAttribute('variant', 'negative');
      statusLight.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  signInButton.addEventListener('click', () => {
    signInButton.setAttribute('disabled', '');
    void window.daisy.agent
      .login()
      .then((outcome) => {
        if (outcome.status === 'failed') {
          warning.textContent = `Sign-in failed: ${outcome.message}`;
        }
      })
      .finally(() => {
        signInButton.removeAttribute('disabled');
        void refresh();
      });
  });

  signOutButton.addEventListener('click', () => {
    void window.daisy.agent.logout().then((result) => {
      warning.textContent = result.warning;
      void refresh();
    });
  });

  const element = el('section', {
    attrs: { class: 'settings-section', 'aria-label': 'Authentication' },
    children: [
      el('h2', { text: 'Authentication' }),
      el('div', { attrs: { class: 'authentication-section__row' }, children: [statusLight] }),
      warning,
      el('div', {
        attrs: { class: 'authentication-section__actions' },
        children: [signInButton, signOutButton],
      }),
    ],
  });

  void refresh();

  return { element, refresh };
}
