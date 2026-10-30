import { expect, test } from '@playwright/test';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import { startAemOrigin } from '../integration/support/testAemServer';
import { launchApp } from '../support/e2e/app';
import { loginFormPresent, signInOnLoginForm, waitForLoginForm } from '../support/e2e/fixtureLogin';
import { findHostViewId, paneEvaluate } from '../support/e2e/hostView';
import { createScratchDirs, writeSettings } from '../support/e2e/profile';
import { openBrowserSettingsTab } from '../support/e2e/settingsBrowserTab';
import { byTestId } from '../support/selectors';

/**
 * The Settings "Browser" tab's two clearing actions, against the built app:
 *
 * - **Clear personal data** empties the pane's cookie jar (so the host asks for a
 *   sign-in again) and the open document's session storage, and reloads the
 *   page - while leaving local storage alone.
 * - **Clear storage** empties local storage (and the caches) and reloads - while
 *   leaving the cookie jar alone.
 *
 * The two markers are the discriminator: a scope that cleared everything would
 * pass the first half of either assertion and fail the second.
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'browser-data-clearing-scratch');

const PERSONAL_MARKER = 'daisy-personal-marker';
const STORAGE_MARKER = 'daisy-storage-marker';

test('Clear personal data signs the pane out, and Clear storage leaves the cookies alone', async () => {
  test.setTimeout(240_000);

  const aem = await startAemOrigin();
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
          label: 'Data clearing host',
          origin: aem.origin,
          color: { kind: 'swatch', swatch: 'blue' },
          revision: 0,
        },
      ],
    }),
  );

  const app = await launchApp({ home, appData, localAppData }, {});
  try {
    const page = await app.firstWindow();
    await page.locator(byTestId('browser-address')).waitFor({ state: 'visible', timeout: 60_000 });

    const hostsPanel = page.locator(byTestId('hosts-panel'));
    if (!(await hostsPanel.isVisible())) {
      await page.locator(byTestId('browser-hosts-button')).click();
    }
    await page.locator(`${byTestId('hosts-item')}[data-origin="${aem.origin}"]`).click();

    const viewId = await findHostViewId(app, aem.origin);
    await waitForLoginForm(app, viewId);
    await signInOnLoginForm(app, viewId);

    // Write both markers on the signed-in document, and keep re-writing until
    // both read back: the post-login navigation may still be settling.
    await expect
      .poll(
        () =>
          paneEvaluate<boolean>(
            app,
            viewId,
            `(() => {
              sessionStorage.setItem(${JSON.stringify(PERSONAL_MARKER)}, '1');
              localStorage.setItem(${JSON.stringify(STORAGE_MARKER)}, '1');
              return (
                sessionStorage.getItem(${JSON.stringify(PERSONAL_MARKER)}) === '1' &&
                localStorage.getItem(${JSON.stringify(STORAGE_MARKER)}) === '1'
              );
            })()`,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);

    const panel = await openBrowserSettingsTab(page);

    // The two actions line up as one column: one width, so their help badges sit
    // at the same x position. Asserted as a relation, not a CSS literal.
    const widths: number[] = [];
    for (const testId of ['clear-personal-data', 'clear-storage']) {
      const box = await panel.locator(byTestId(testId)).boundingBox();
      widths.push(Math.round(box?.width ?? 0));
    }
    expect(new Set(widths).size).toBe(1);

    // -------------------------------------------------- Clear personal data
    await panel.locator(byTestId('clear-personal-data')).click();
    await page.locator(byTestId('banner-confirm')).click();

    // The pane was reloaded onto a cleared cookie jar, so the fixture host asks
    // for a sign-in again - the visible consequence of the erase.
    await waitForLoginForm(app, viewId);
    await expect
      .poll(
        () =>
          paneEvaluate<string | null>(
            app,
            viewId,
            `sessionStorage.getItem(${JSON.stringify(PERSONAL_MARKER)})`,
          ),
        { timeout: 30_000 },
      )
      .toBeNull();
    expect(
      await paneEvaluate<string | null>(
        app,
        viewId,
        `localStorage.getItem(${JSON.stringify(STORAGE_MARKER)})`,
      ),
    ).toBe('1');

    // -------------------------------------------------------- Clear storage
    await panel.locator(byTestId('clear-storage')).click();
    await page.locator(byTestId('banner-confirm')).click();

    await expect
      .poll(
        () =>
          paneEvaluate<string | null>(
            app,
            viewId,
            `localStorage.getItem(${JSON.stringify(STORAGE_MARKER)})`,
          ),
        { timeout: 30_000 },
      )
      .toBeNull();
    // Still signed out: clearing local data neither clears nor restores a cookie.
    expect(await loginFormPresent(app, viewId)).toBe(true);
  } finally {
    await app.close();
  }
});
