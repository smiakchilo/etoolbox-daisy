import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';

/**
 * The Settings panel's colour picker is a plain `sp-textfield` (holding
 * either a swatch name like `blue` or a `#rrggbb` hex string) plus a
 * separate "picker button" (`sp-action-menu`, `.color-picker-button`) beside
 * it: clicking the button opens a menu of the named swatches, each showing
 * its colour dot. Picking one writes that swatch's name into the field -
 * exactly the same textfield-plus-picker-button pattern as the browser
 * toolbar's address bar/hosts picker (see `address-hosts-picker.spec.ts`).
 * Typing a hex value directly into the field still works too, with no menu
 * interaction at all.
 *
 * Exercised against the real built app for the same reason as that spec:
 * `sp-action-menu` renders its overlay via the native `popover`/top-layer
 * API, which jsdom cannot render.
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'settings-color-picker-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

test("picking a swatch, and typing a custom hex, both set a new server's colour", async () => {
  test.setTimeout(120_000);

  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(path.join(scratchBase, 'profile-'));
  const home = path.join(root, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });

  const env = {
    ...definedEnv(process.env),
    USERPROFILE: home,
    HOME: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
  };

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const settings = await app.firstWindow();
    await settings.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
    await settings.locator('sp-action-button', { hasText: 'Settings' }).first().click();
    await settings
      .locator('.settings-panel')
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });
    const form = settings.locator('.add-server-form').first();
    await form.waitFor({ state: 'visible', timeout: 60_000 });

    const colorField = form.locator('.color-picker input').first();
    const colorMenuButton = form.locator('.color-picker-button').first();

    // Nothing open yet, and the field starts on the first named swatch.
    await expect(settings.getByRole('menuitem')).toHaveCount(0);
    await expect(colorField).toHaveValue('red');

    // Picking a swatch from the menu writes its name into the field.
    await colorMenuButton.click();
    const blueItem = settings.getByRole('menuitem', { name: 'blue' });
    await expect(blueItem).toBeVisible({ timeout: 10_000 });
    await blueItem.click();
    await expect(colorField).toHaveValue('blue');

    await form.locator('sp-textfield[placeholder="Label"] input').fill('Blue Server');
    await form
      .locator('sp-textfield[placeholder="https://author.example"] input')
      .fill('https://blue-server.example');
    await form.locator('sp-button', { hasText: 'Add server' }).first().click();

    const blueRow = settings.locator('.server-row', { hasText: 'Blue Server' });
    await expect(blueRow).toHaveCount(1, { timeout: 60_000 });
    await expect(blueRow.locator('.server-swatch').first()).toHaveCSS(
      'background-color',
      'rgb(38, 128, 235)', // #2680eb, the "blue" swatch
    );

    // Typing a hex value directly - no menu interaction - also works.
    await colorField.fill('#123abc');
    await form.locator('sp-textfield[placeholder="Label"] input').fill('Custom Colour Server');
    await form
      .locator('sp-textfield[placeholder="https://author.example"] input')
      .fill('https://custom-color-server.example');
    await form.locator('sp-button', { hasText: 'Add server' }).first().click();

    const customRow = settings.locator('.server-row', { hasText: 'Custom Colour Server' });
    await expect(customRow).toHaveCount(1, { timeout: 60_000 });
    await expect(customRow.locator('.server-swatch').first()).toHaveCSS(
      'background-color',
      'rgb(18, 58, 188)', // #123abc
    );

    await expect(form.locator('.form-errors')).toHaveText('');
  } finally {
    await app.close();
  }
});
