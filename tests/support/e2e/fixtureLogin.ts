import { expect } from '@playwright/test';
import { FIXTURE_PASSWORD, FIXTURE_USERNAME } from '../../integration/support/testAemServer';
import type { ElectronApp } from './app';
import { paneEvaluate } from './hostView';

/**
 * The fixture AEM origin's Granite-shaped sign-in form, for specs that need a
 * signed-in pane. `tests/integration/support/testAemServer.ts` serves it; these
 * helpers only drive it through the pane's own document.
 */

/** True while the fixture's sign-in form is the document on screen. */
export function loginFormPresent(app: ElectronApp, hostViewId: number): Promise<boolean> {
  return paneEvaluate<boolean>(app, hostViewId, 'document.querySelector("#login-form") !== null');
}

export async function waitForLoginForm(app: ElectronApp, hostViewId: number): Promise<void> {
  await expect.poll(() => loginFormPresent(app, hostViewId), { timeout: 30_000 }).toBe(true);
}

/** The form's two values, so a test can prove a fill (or the absence of one). */
export function loginFieldValues(
  app: ElectronApp,
  hostViewId: number,
): Promise<{ username: string; password: string }> {
  return paneEvaluate<{ username: string; password: string }>(
    app,
    hostViewId,
    `(() => {
      const username = document.querySelector('#username');
      const password = document.querySelector('#password');
      return { username: username ? username.value : '', password: password ? password.value : '' };
    })()`,
  );
}

/**
 * Types the fixture credentials into the visible form and submits it, then waits
 * for the form to disappear. Throws when the form is not the current document:
 * a silent no-op here would make the next assertion fail for the wrong reason.
 */
export async function signInOnLoginForm(app: ElectronApp, hostViewId: number): Promise<void> {
  const submitted = await paneEvaluate<boolean>(
    app,
    hostViewId,
    `(() => {
      const form = document.querySelector('#login-form');
      if (!form) return false;
      document.querySelector('#username').value = ${JSON.stringify(FIXTURE_USERNAME)};
      document.querySelector('#password').value = ${JSON.stringify(FIXTURE_PASSWORD)};
      form.requestSubmit();
      return true;
    })()`,
  );
  if (!submitted) throw new Error('the sign-in form is not on screen');
  await expect.poll(() => loginFormPresent(app, hostViewId), { timeout: 30_000 }).toBe(false);
}
