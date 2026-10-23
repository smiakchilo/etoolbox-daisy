import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import {
  FIXTURE_PASSWORD,
  FIXTURE_USERNAME,
  startAemOrigin,
  type AemOrigin,
} from '../integration/support/testAemServer';
import { launchApp, type ElectronApp } from '../support/e2e/app';
import { findHostViewId } from '../support/e2e/hostView';
import { createScratchDirs, writeSettings } from '../support/e2e/profile';
import { byTestId } from '../support/selectors';

/**
 * Saved sign-ins, against the built app:
 *
 * 1. signing in on the fixture's Granite form is remembered automatically -
 *    the plaintext index names the origin and username and never the password;
 * 2. after a restart (with the session cookies cleared, so the host really
 *    asks again) the same form is **prefilled on load**, with nothing typed;
 * 3. the Settings "Browser" tab's one action erases them, through the shared
 *    destructive-confirm prompt, and a further restart proves the form is empty.
 *
 * The pane is a `WebContentsView`, so its DOM is reached through
 * `app.evaluate` + `executeJavaScript` (`findHostViewId`), the same way the
 * other pane-driving specs do. The fixture is `tests/integration/support/testAemServer.ts`.
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'saved-sign-ins-scratch');
const VIEW_PARTITION = 'persist:webview';

interface PaneEvalArgs {
  readonly id: number;
  readonly code: string;
}

async function paneEvaluate<T>(app: ElectronApp, viewId: number, code: string): Promise<T> {
  return (await app.evaluate(
    async ({ webContents }, args: PaneEvalArgs) => {
      const contents = webContents.fromId(args.id);
      if (contents === undefined) throw new Error('the pane webContents is gone');
      return contents.executeJavaScript(args.code) as Promise<unknown>;
    },
    { id: viewId, code },
  )) as T;
}

async function paneText(app: ElectronApp, viewId: number): Promise<string> {
  return paneEvaluate<string>(app, viewId, 'document.body ? document.body.textContent : ""');
}

/** True while the fixture's sign-in form is the document on screen. */
async function loginFormPresent(app: ElectronApp, viewId: number): Promise<boolean> {
  return paneEvaluate<boolean>(app, viewId, 'document.querySelector("#login-form") !== null');
}

async function waitForLoginForm(app: ElectronApp, viewId: number): Promise<void> {
  await expect.poll(() => loginFormPresent(app, viewId), { timeout: 30_000 }).toBe(true);
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

test('a sign-in is remembered, prefilled after a restart, and erased from Settings', async () => {
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
      await paneEvaluate<boolean>(
        first.app,
        first.viewId,
        `(() => {
          const form = document.querySelector('#login-form');
          if (!form) return false;
          document.querySelector('#username').value = ${JSON.stringify(FIXTURE_USERNAME)};
          document.querySelector('#password').value = ${JSON.stringify(FIXTURE_PASSWORD)};
          form.requestSubmit();
          return true;
        })()`,
      );
      await expect
        .poll(() => loginFormPresent(first.app, first.viewId), { timeout: 30_000 })
        .toBe(false);
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
    } finally {
      await first.app.close();
    }

    // ---------------------------------------------------------------- launch 2
    const second = await launchOnLoginForm();
    try {
      // Nothing is typed: the values are the ones main wrote on `dom-ready`.
      await expect
        .poll(
          () =>
            paneEvaluate<{ username: string; password: string }>(
              second.app,
              second.viewId,
              `(() => {
                const username = document.querySelector('#username');
                const password = document.querySelector('#password');
                return { username: username ? username.value : '', password: password ? password.value : '' };
              })()`,
            ),
          { timeout: 30_000 },
        )
        .toEqual({ username: FIXTURE_USERNAME, password: FIXTURE_PASSWORD });

      // The Settings line is the one erase action, and pressing it only raises
      // the shared destructive-confirm prompt in the pane's status row.
      const page = await second.app.firstWindow();
      await page.locator(byTestId('chat-settings')).click();
      await page
        .locator(byTestId('settings-panel'))
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
      await page.locator(byTestId('settings-tab-browser')).click();

      const panel = page.locator('.settings-panel__tab-panel[selected]');
      await panel.locator(byTestId('erase-saved-credentials')).click();
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
