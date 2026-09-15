import { _electron as electron, expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared/contracts/appSettings';

/**
 * The address bar is a plain `sp-textfield` plus a separate "picker button"
 * (`sp-action-menu`, `#server-picker-button`) beside it: clicking the button
 * opens a menu of the configured servers underneath. Picking one fills the
 * address bar with that server's origin and navigates to it - the exact same
 * `navigate()` path a typed address goes through. With zero configured
 * servers the button must never even be shown.
 *
 * This is exercised against the real built app/real Spectrum control rather
 * than jsdom: `sp-action-menu` renders its overlay via the native
 * `popover`/top-layer API, which jsdom cannot render, so only a real
 * Chromium proves the menu actually opens and a click actually selects.
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'address-picker-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function startEchoOrigin(): Promise<{ origin: string; hits: number; close: () => void }> {
  const state = { hits: 0 };
  const server: Server = createServer((_req, res) => {
    state.hits += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>echo</title><p>ok</p>`);
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

function launchProfile(): { home: string; env: Record<string, string> } {
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(path.join(scratchBase, 'profile-'));
  const home = path.join(root, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  return {
    home,
    env: {
      ...definedEnv(process.env),
      USERPROFILE: home,
      HOME: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
    },
  };
}

function writeSettings(home: string, settings: unknown): void {
  const settingsPath = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

test("picking a server from the address bar's picker button navigates to it", async () => {
  test.setTimeout(120_000);

  const serverA = await startEchoOrigin();
  const serverB = await startEchoOrigin();
  const { home, env } = launchProfile();

  const base = defaultAppSettings();
  const seeded = appSettingsSchema.parse({
    ...base,
    servers: [
      ...base.servers,
      {
        id: randomUUID(),
        label: 'Server A',
        origin: serverA.origin,
        color: { kind: 'swatch', swatch: 'blue' },
        revision: 0,
      },
      {
        id: randomUUID(),
        label: 'Server B',
        origin: serverB.origin,
        color: { kind: 'swatch', swatch: 'green' },
        revision: 0,
      },
    ],
  });
  writeSettings(home, seeded);

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    const addressBar = page.locator('#browser-address-bar');
    await addressBar.waitFor({ state: 'visible', timeout: 30_000 });
    const addressInput = addressBar.locator('input').first();
    const pickerButton = page.locator('#server-picker-button');
    await expect(pickerButton).toBeVisible({ timeout: 10_000 });

    // Nothing is visibly open yet.
    await expect(page.getByRole('menuitem', { name: 'Server B' })).toHaveCount(0);

    // Clicking the picker button opens the menu.
    await pickerButton.click();
    const itemA = page.getByRole('menuitem', { name: 'Server A' });
    const itemB = page.getByRole('menuitem', { name: 'Server B' });
    await expect(itemA).toBeVisible({ timeout: 10_000 });
    await expect(itemB).toBeVisible({ timeout: 10_000 });

    await itemB.click();

    // Selecting it both fills the address bar and actually navigates. The
    // final address-bar text comes from the real post-navigation URL (which
    // can add a trailing "/"), not literally the menu item's string.
    await expect
      .poll(async () => await addressInput.inputValue())
      .toMatch(new RegExp(`^${serverB.origin}/?$`));
    await expect.poll(() => serverB.hits > 0, { timeout: 30_000 }).toBe(true);
    expect(serverA.hits).toBe(0);

    const message = page.locator('.browser-toolbar-message__text');
    expect((await message.textContent()) ?? '').toBe('');

    // Opening the button's menu again and picking the other server works
    // too - not a one-shot affordance.
    await pickerButton.click();
    await expect(itemA).toBeVisible({ timeout: 10_000 });
    await itemA.click();
    await expect.poll(() => serverA.hits > 0, { timeout: 30_000 }).toBe(true);

    // Typing directly into the field still works too - the same field, not
    // a separate mode.
    await addressInput.fill(serverB.origin);
    await addressInput.press('Enter');
    await expect.poll(() => serverB.hits > 1, { timeout: 30_000 }).toBe(true);
  } finally {
    await app.close();
    serverA.close();
    serverB.close();
  }
});

test("with no configured servers, the address bar's picker button never appears", async () => {
  test.setTimeout(60_000);

  const { home, env } = launchProfile();
  writeSettings(home, defaultAppSettings());

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    const addressBar = page.locator('#browser-address-bar');
    await addressBar.waitFor({ state: 'visible', timeout: 30_000 });
    const addressInput = addressBar.locator('input').first();

    await expect(page.locator('#server-picker-button')).toBeHidden();

    // The field itself must still be fully usable for typing, and clicking
    // it must never surface any menu when there is nothing to pick from.
    await addressInput.click();
    await page.waitForTimeout(500);
    await expect(page.getByRole('menuitem')).toHaveCount(0);
    await expect(addressInput).toBeEnabled();
  } finally {
    await app.close();
  }
});
