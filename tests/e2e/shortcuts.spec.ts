import path from 'node:path';
import { expect, test } from '@playwright/test';
import { findAemViewId, pressOn, waitForViewIdle } from '../support/e2e/aemView';
import { closeFixtureServer, seedHostAndLaunch, startFixtureServer } from '../support/e2e/aemHost';
import { byTestId } from '../support/selectors';

/**
 * Application-wide keyboard shortcuts, against the built app.
 *
 * The app has no menu bar (`index.ts` clears the application menu), so a
 * shortcut is matched in main via `before-input-event` on *both* `WebContents`
 * - the shell's and the AEM view's (`src/main/shortcuts.ts`). That is
 * main-process wiring a jsdom unit test can only approximate: it can prove the
 * key map and the routing decision, not that a real keystroke reaches them, nor
 * that a keystroke landing in the AEM pane's separate `WebContents` still
 * reaches the shell's handlers.
 *
 * Input is injected from main (`WebContents.sendInputEvent`) rather than through
 * Playwright's `page.keyboard`, because a DevTools-protocol key event does not
 * pass through `before-input-event` at all (see `devtools.spec.ts`). The AEM
 * view must be showing a loaded page and focused for its injected keys to be
 * delivered, hence the seeded host and the picker click.
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'shortcuts-scratch');

test('application shortcuts work from both panes', async () => {
  test.setTimeout(120_000);

  const { server, origin, requests } = await startFixtureServer(
    (url) => `<!doctype html><title>${url}</title><p id="marker">${url}</p>`,
  );
  const { app, page } = await seedHostAndLaunch(scratchBase, origin, 'Shortcut fixture');
  const addressInput = page.locator(`${byTestId('browser-address')} input`);
  // Picking the host navigates to the bare origin, which the browser normalizes
  // to a trailing-slash root URL.
  const rootUrl = `${origin}/`;

  try {
    const aemViewId = await findAemViewId(app, origin);
    await expect
      .poll(async () => await addressInput.inputValue(), { timeout: 30_000 })
      .toBe(rootUrl);
    await waitForViewIdle(app, aemViewId);

    // ── F5 on the AEM pane refreshes it ────────────────────────────────────
    const beforeRefresh = requests.filter((url) => url === '/').length;
    expect(await pressOn(app, 'aem', aemViewId, 'F5', [])).toBe(true);
    await expect
      .poll(() => requests.filter((url) => url === '/').length, { timeout: 30_000 })
      .toBeGreaterThan(beforeRefresh);
    await waitForViewIdle(app, aemViewId);

    // ── Alt+Left on the AEM pane goes Back ─────────────────────────────────
    await addressInput.fill(`${origin}/other.html`);
    await addressInput.press('Enter');
    await expect
      .poll(async () => await addressInput.inputValue(), { timeout: 30_000 })
      .toBe(`${origin}/other.html`);
    await waitForViewIdle(app, aemViewId);

    expect(await pressOn(app, 'aem', aemViewId, 'Left', ['alt'])).toBe(true);
    await expect
      .poll(async () => await addressInput.inputValue(), { timeout: 30_000 })
      .toBe(rootUrl);

    // ── Ctrl+H on the shell opens History ──────────────────────────────────
    await pressOn(app, 'shell', aemViewId, 'H', ['control']);
    await expect(page.locator(byTestId('history-panel'))).toBeVisible({ timeout: 15_000 });
    await page.locator(byTestId('history-panel-close')).click();
    await expect(page.locator(byTestId('history-panel'))).toBeHidden();

    // ── Ctrl+, on the shell opens Settings ─────────────────────────────────
    await pressOn(app, 'shell', aemViewId, ',', ['control']);
    await expect(page.locator(byTestId('settings-panel'))).toBeVisible({ timeout: 15_000 });
    await page.locator(byTestId('settings-panel-close')).click();
    await expect(page.locator(byTestId('settings-panel'))).toBeHidden();

    // ── Ctrl+L focuses the address bar, from the AEM pane ──────────────────
    await pressOn(app, 'aem', aemViewId, 'L', ['control']);
    await expect(addressInput).toBeFocused({ timeout: 15_000 });
  } finally {
    await app.close();
    await closeFixtureServer(server);
  }
});
