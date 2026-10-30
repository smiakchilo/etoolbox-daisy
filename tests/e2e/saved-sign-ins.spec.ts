import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import { SUGGESTION_HOST_ATTRIBUTE } from '../../src/main/credentials/fillScript';
import {
  FIXTURE_PASSWORD,
  FIXTURE_USERNAME,
  startAemOrigin,
  type AemOrigin,
} from '../integration/support/testAemServer';
import { launchApp, type ElectronApp } from '../support/e2e/app';
import { loginFieldValues, signInOnLoginForm, waitForLoginForm } from '../support/e2e/fixtureLogin';
import { findHostViewId, paneEvaluate } from '../support/e2e/hostView';
import { createScratchDirs, writeSettings } from '../support/e2e/profile';
import { openBrowserSettingsTab } from '../support/e2e/settingsBrowserTab';
import { byTestId } from '../support/selectors';

/**
 * Saved sign-ins, against the built app:
 *
 * 1. signing in on the fixture's Granite form is remembered automatically -
 *    the plaintext index names the origin and username and never the password;
 * 2. signing out immediately shows a prefilled form, and so does a restart
 *    (with the session cookies cleared, so the host really asks again);
 * 3. the Settings "Browser" tab's **Clear personal data** erases them, through
 *    the shared destructive-confirm prompt, and a further restart proves the
 *    form is empty.
 *
 * The pane is a `WebContentsView`, so its DOM is reached through
 * `app.evaluate` + `executeJavaScript` (`paneEvaluate`/`findHostViewId`), the
 * same way the other pane-driving specs do. The fixture is
 * `tests/integration/support/testAemServer.ts`.
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'saved-sign-ins-scratch');
const VIEW_PARTITION = 'persist:webview';

async function paneText(app: ElectronApp, viewId: number): Promise<string> {
  return paneEvaluate<string>(app, viewId, 'document.body ? document.body.textContent : ""');
}

async function paneLoad(app: ElectronApp, viewId: number, url: string): Promise<void> {
  await app.evaluate(
    async ({ webContents }, args: { id: number; url: string }) => {
      const contents = webContents.fromId(args.id);
      if (contents === undefined) throw new Error('the pane webContents is gone');
      await contents.loadURL(args.url);
    },
    { id: viewId, url },
  );
}

/** Clears the view session's cookies, so the fixture host asks for a sign-in again. */
async function clearViewCookies(app: ElectronApp): Promise<void> {
  await app.evaluate(async ({ session }, partition: string) => {
    await session.fromPartition(partition).clearStorageData({ storages: ['cookies'] });
  }, VIEW_PARTITION);
}

function indexFilePath(localAppData: string): string {
  return path.join(localAppData, 'etoolbox-daisy', 'credentials', 'sign-ins.json');
}

function readIndex(localAppData: string): { entries?: unknown[] } | undefined {
  const file = indexFilePath(localAppData);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as { entries?: unknown[] };
}

test('a sign-in is remembered, prefilled after sign-out and restart, and erased from Settings', async () => {
  test.setTimeout(240_000);

  const aem: AemOrigin = await startAemOrigin();
  const { home, appData, localAppData } = createScratchDirs(scratchBase);

  const base = defaultAppSettings();
  writeSettings(
    home,
    appSettingsSchema.parse({
      ...base,
      hosts: [
        ...base.hosts,
        {
          id: randomUUID(),
          label: 'Saved sign-ins host',
          origin: aem.origin,
          color: { kind: 'swatch', swatch: 'blue' },
          revision: 0,
        },
      ],
    }),
  );

  /** Launches, picks the host (the seeded profile opens the hosts panel), waits for the login form. */
  async function launchOnLoginForm(): Promise<{ app: ElectronApp; viewId: number }> {
    const app = await launchApp({ home, appData, localAppData }, {});
    const page = await app.firstWindow();
    await page.locator(byTestId('browser-address')).waitFor({ state: 'visible', timeout: 60_000 });
    // A remembered page from the previous launch may still be signed in on disk;
    // clearing cookies makes the host ask, which is the state under test.
    await clearViewCookies(app);
    // The seeded profile opens the hosts panel on a first launch (nothing is
    // loaded yet); a later launch restores a page, so the panel starts closed.
    const panel = page.locator(byTestId('hosts-panel'));
    if (!(await panel.isVisible())) {
      await page.locator(byTestId('browser-hosts-button')).click();
    }
    const item = page.locator(`${byTestId('hosts-item')}[data-origin="${aem.origin}"]`);
    await item.waitFor({ state: 'visible', timeout: 30_000 });
    await item.click();
    const viewId = await findHostViewId(app, aem.origin);
    await waitForLoginForm(app, viewId);
    return { app, viewId };
  }

  try {
    // ---------------------------------------------------------------- launch 1
    const first = await launchOnLoginForm();
    try {
      await signInOnLoginForm(first.app, first.viewId);
      await expect
        .poll(() => paneText(first.app, first.viewId), { timeout: 30_000 })
        .not.toContain('Please sign in to AEM');

      // The capture is main-side and asynchronous: the index appears shortly
      // after the submission. It names the origin and the username only.
      await expect
        .poll(() => readIndex(localAppData)?.entries?.length ?? 0, { timeout: 30_000 })
        .toBe(1);
      const indexText = readFileSync(indexFilePath(localAppData), 'utf8');
      expect(indexText).toContain(aem.origin);
      expect(indexText).toContain(FIXTURE_USERNAME);
      expect(indexText).not.toContain(FIXTURE_PASSWORD);

      // The owner's round trip needs no restart: sign out, and the login page
      // that comes back is already prefilled from the submission just captured.
      await paneLoad(first.app, first.viewId, aem.url('/logout'));
      await waitForLoginForm(first.app, first.viewId);
      await expect
        .poll(() => loginFieldValues(first.app, first.viewId), { timeout: 30_000 })
        .toEqual({ username: FIXTURE_USERNAME, password: FIXTURE_PASSWORD });
    } finally {
      await first.app.close();
    }

    // ---------------------------------------------------------------- launch 2
    const second = await launchOnLoginForm();
    try {
      // Nothing is typed: the values are the ones main wrote on `dom-ready`.
      await expect
        .poll(() => loginFieldValues(second.app, second.viewId), { timeout: 30_000 })
        .toEqual({ username: FIXTURE_USERNAME, password: FIXTURE_PASSWORD });

      // The Settings line is the personal-data clear action, and pressing it
      // only raises the shared destructive-confirm prompt in the pane's status
      // row.
      const page = await second.app.firstWindow();
      const panel = await openBrowserSettingsTab(page);
      await panel.locator(byTestId('clear-personal-data')).click();
      const confirm = page.locator(byTestId('banner-confirm'));
      await expect(confirm).toBeVisible();
      await confirm.click();

      // The prompt is answered, not a sticky receipt: it goes away and the
      // erase's outcome takes the row, even when there is nothing to erase.
      await expect(confirm).toHaveCount(0);
      await expect
        .poll(() => existsSync(indexFilePath(localAppData)), { timeout: 30_000 })
        .toBe(false);
    } finally {
      await second.app.close();
    }

    // ---------------------------------------------------------------- launch 3
    const third = await launchOnLoginForm();
    try {
      await expect
        .poll(
          () =>
            paneEvaluate<string>(
              third.app,
              third.viewId,
              'document.querySelector("#username") ? document.querySelector("#username").value : "missing"',
            ),
          { timeout: 30_000 },
        )
        .toBe('');
      expect(
        await paneEvaluate<string>(
          third.app,
          third.viewId,
          'document.querySelector("#password") ? document.querySelector("#password").value : "missing"',
        ),
      ).toBe('');
    } finally {
      await third.app.close();
    }
  } finally {
    await aem.close();
  }
});

/**
 * The email-only first step of an identity provider (Adobe's and HPE's pages):
 * a form that asks who you are, with a password input planted only to decoy
 * password managers. The pane must remember the address, prefill it next time,
 * and offer it in the field's suggestion list.
 */
interface EmailStepOrigin {
  readonly origin: string;
  close(): Promise<void>;
}

async function startEmailStepOrigin(): Promise<EmailStepOrigin> {
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in</title></head>
<body>
  <h1>Sign in</h1>
  <form id="EmailForm">
    <label for="email">E-mail address</label>
    <input id="email" name="username" type="email" autocomplete="username">
    <div class="credential-hide-helper">
      <input name="passwd" type="password" autocomplete="current-password"
             aria-hidden="true" tabindex="-1">
    </div>
    <button id="continue" type="submit">Continue</button>
  </form>
</body></html>`;

  const server: Server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

test('an email-only step is remembered, prefilled, and offered as a suggestion', async () => {
  test.setTimeout(240_000);

  const identityProvider = await startEmailStepOrigin();
  const { home, appData, localAppData } = createScratchDirs(scratchBase);
  const email = 'someone@example.com';

  const base = defaultAppSettings();
  writeSettings(
    home,
    appSettingsSchema.parse({
      ...base,
      hosts: [
        ...base.hosts,
        {
          id: randomUUID(),
          label: 'Identity provider',
          origin: identityProvider.origin,
          color: { kind: 'swatch', swatch: 'blue' },
          revision: 0,
        },
      ],
    }),
  );

  try {
    const app = await launchApp({ home, appData, localAppData }, {});
    try {
      const window = await app.firstWindow();
      await window
        .locator(byTestId('browser-address'))
        .waitFor({ state: 'visible', timeout: 60_000 });
      const panel = window.locator(byTestId('hosts-panel'));
      if (!(await panel.isVisible())) {
        await window.locator(byTestId('browser-hosts-button')).click();
      }
      const item = window.locator(
        `${byTestId('hosts-item')}[data-origin="${identityProvider.origin}"]`,
      );
      await item.waitFor({ state: 'visible', timeout: 30_000 });
      await item.click();
      const viewId = await findHostViewId(app, identityProvider.origin);
      await expect
        .poll(() => paneEvaluate<boolean>(app, viewId, '!!document.querySelector("#email")'), {
          timeout: 30_000,
        })
        .toBe(true);

      // Type the address and continue. The page has no usable password field,
      // so the submission is remembered as a username hint.
      await paneEvaluate<void>(
        app,
        viewId,
        `(() => {
          document.querySelector('#email').value = ${JSON.stringify(email)};
          document.querySelector('#continue').click();
        })()`,
      );
      await expect
        .poll(() => readIndex(localAppData)?.entries?.[0], { timeout: 30_000 })
        .toMatchObject({ username: email, hasPassword: false });

      // A reload prefills the address without a password being involved.
      await paneLoad(app, viewId, `${identityProvider.origin}/`);
      await expect
        .poll(
          () =>
            paneEvaluate<string>(
              app,
              viewId,
              'document.querySelector("#email") ? document.querySelector("#email").value : "missing"',
            ),
          { timeout: 30_000 },
        )
        .toBe(email);

      // Emptying the field and focusing it offers the remembered address; the
      // first suggestion is reachable with the keyboard alone.
      const hostSelector = JSON.stringify(`[${SUGGESTION_HOST_ATTRIBUTE}]`);
      const chosen = await paneEvaluate<string>(
        app,
        viewId,
        `(() => {
          const field = document.querySelector('#email');
          field.value = '';
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
          const open = document.querySelector(${hostSelector}) !== null;
          field.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
          );
          field.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
          );
          return open ? field.value : 'no-list';
        })()`,
      );
      expect(chosen).toBe(email);
    } finally {
      await app.close();
    }
  } finally {
    await identityProvider.close();
  }
});
