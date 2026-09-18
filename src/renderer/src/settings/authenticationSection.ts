import { el } from '../lib/dom';
import type { AuthStatus } from '../../../shared';
import type { StatusBannerSink } from './statusBanner';

/**
 * Authentication status section: uses the real `window.daisy.agent` sign-in
 * API, presented as one line of Settings. Sign-in/out are real; there is no
 * stub here. Transient outcomes (a failed web-flow sign-in, the local
 * sign-out's blast-radius warning) go to the panel's one banner slot.
 */
export interface AuthenticationSection {
  readonly element: HTMLElement;
  refresh(): Promise<void>;
}

export function createAuthenticationSection(status: StatusBannerSink): AuthenticationSection {
  const statusLight = el('sp-status-light', { attrs: { variant: 'neutral' }, text: 'Checking...' });

  const signInButton = el('sp-button', { attrs: { variant: 'accent' }, text: 'Sign in' });
  const signOutButton = el('sp-button', {
    attrs: { variant: 'secondary' },
    text: 'Sign out (local only)',
  });

  async function refresh(): Promise<void> {
    try {
      const auth: AuthStatus = await window.daisy.agent.getAuthStatus();
      if (auth.isAuthenticated) {
        statusLight.setAttribute('variant', 'positive');
        statusLight.textContent = `Signed in${auth.login ? ` as ${auth.login}` : ''}`;
      } else {
        statusLight.setAttribute('variant', 'negative');
        statusLight.textContent = auth.statusMessage ?? 'Not signed in';
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
          status.showError(`Sign-in failed: ${outcome.message}`);
        }
      })
      .finally(() => {
        signInButton.removeAttribute('disabled');
        void refresh();
      });
  });

  signOutButton.addEventListener('click', () => {
    void window.daisy.agent.logout().then((result) => {
      status.showStatus(result.warning);
      void refresh();
    });
  });

  const element = el('section', {
    attrs: { class: 'settings-section', 'aria-label': 'Authentication' },
    children: [
      el('div', { attrs: { class: 'authentication-section__row' }, children: [statusLight] }),
      el('div', {
        attrs: { class: 'authentication-section__actions' },
        children: [signInButton, signOutButton],
      }),
    ],
  });

  void refresh();

  return { element, refresh };
}
