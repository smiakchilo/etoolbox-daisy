import { _electron as electron, expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import { mainEntry } from '../support/e2e/app';
import { createLaunchProfile, writeSettings } from '../support/e2e/profile';
import { byTestId } from '../support/selectors';

/**
 * The closeability contract for whole-size panels over the page-view region,
 * now that the pane has a home (welcome) screen.
 *
 * A whole-size panel (hosts picker, Settings) *replaces* the native
 * `WebContentsView`: while it is open the view is suspended and the reserved
 * `#browser-view-host` region is hidden underneath it. Dismissing such a panel
 * therefore reveals whatever occupies the slot beneath it:
 *
 *   - the loaded page, while a document is committed, OR
 *   - the home screen, while none is.
 *
 * Because the home screen is always a valid thing to reveal, a panel is now
 * always dismissible: the close (cross) button is enabled, Escape dismisses,
 * and the toolbar hosts-button toggle closes an open panel. A configured-host
 * profile keeps its startup affordance (the picker leads), but dismissing it
 * reveals the home screen rather than a blank view.
 *
 * This is exercised against the real built app: a real `sp-action-button`, real
 * Escape dispatch on `document`, a real `sp-picker-button` toggle, the real
 * hidden/visible native-view region, and the real home screen.
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'panel-closeability-scratch');

async function startEchoOrigin(): Promise<{ origin: string; hits: number; close: () => void }> {
  const state = { hits: 0 };
  const server: Server = createServer((_req, res) => {
    state.hits += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>echo</title><p>ok</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    get hits() {
      return state.hits;
    },
    close: () => server.close(),
  };
}

test('a panel is always dismissible, revealing the home screen or the loaded page beneath', async () => {
  test.setTimeout(120_000);

  const server = await startEchoOrigin();
  const { home, env } = createLaunchProfile(scratchBase);
  const base = defaultAppSettings();
  writeSettings(
    home,
    appSettingsSchema.parse({
      ...base,
      hosts: [
        ...base.hosts,
        {
          id: randomUUID(),
          label: 'Echo',
          origin: server.origin,
          color: { kind: 'swatch', swatch: 'blue' },
          revision: 0,
        },
      ],
    }),
  );

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    const panel = page.locator(byTestId('hosts-panel'));
    const closeButton = page.locator(byTestId('hosts-panel-close'));
    const pickerButton = page.locator(byTestId('browser-hosts-button'));
    const viewHost = page.locator('.browser-view-host');
    const homeScreen = page.locator('.browser-home');

    // A seeded profile keeps its startup affordance: the hosts picker leads.
    // The home screen sits beneath it, so the native view is collapsed and the
    // panel is fully dismissible.
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(homeScreen).toBeHidden();
    await expect(viewHost).toBeHidden();
    await expect(closeButton).toBeEnabled();
    await expect(pickerButton).toHaveAttribute('open', '');

    // Escape dismisses it, revealing the home screen (not a blank region).
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(homeScreen).toBeVisible();

    // Reopen and dismiss through the cross button.
    await pickerButton.click();
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await closeButton.click();
    await expect(panel).toBeHidden();
    await expect(homeScreen).toBeVisible();

    // The hosts-button toggle closes an open panel too.
    await pickerButton.click();
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await pickerButton.click();
    await expect(panel).toBeHidden();
    await expect(homeScreen).toBeVisible();

    // Selecting a host closes the panel AND loads a page, replacing the home
    // screen with the native view.
    await pickerButton.click();
    await page.locator(`${byTestId('hosts-item')}[data-origin="${server.origin}"]`).click();
    await expect.poll(() => server.hits > 0, { timeout: 30_000 }).toBe(true);
    await expect(panel).toBeHidden();
    await expect(homeScreen).toBeHidden();
    await expect(viewHost).toBeVisible();

    // With a page loaded, dismissing a panel reveals the page, not the home
    // screen.
    await pickerButton.click();
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(viewHost).toBeHidden();
    await closeButton.click();
    await expect(panel).toBeHidden();
    await expect(homeScreen).toBeHidden();
    await expect(viewHost).toBeVisible();
  } finally {
    await app.close();
    server.close();
  }
});
