import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Step 05: the Settings surface can actually add and remove servers, and the
 * result survives a restart.
 *
 * The unit suite covers every handler, schema and view-model function, but
 * only driving the real built app proves that the IPC round-trip — preload
 * sender-guard, main-process handler, settingsStore write, and the
 * settings-changed re-fetch in the shell — is wired end-to-end. Settings
 * became a panel in the shell (not a separate child window), so the sender
 * guard trusts only the one shell webContents id; this spec proves that
 * single-window path works.
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'step05-settings-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

test('servers added in the Settings panel persist, and removal persists too', async () => {
  test.setTimeout(180_000);

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
  const settingsFile = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');

  const openSettings = async () => {
    const app = await electron.launch({ args: [mainEntry], env });
    const shell = await app.firstWindow();
    await shell.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
    await shell.locator('sp-action-button', { hasText: 'Settings' }).first().click();
    await shell.locator('.settings-panel').first().waitFor({ state: 'visible', timeout: 60_000 });
    await shell.locator('.add-server-form').first().waitFor({ state: 'visible', timeout: 60_000 });
    return { app, page: shell };
  };

  // --- Launch 1: add a server through the real form -----------------------
  const first = await openSettings();
  try {
    const rows = first.page.locator('.server-row');
    const initialRowCount = await rows.count();

    await first.page.locator('sp-textfield[placeholder="Label"] input').fill('Canary Author');
    await first.page
      .locator('sp-textfield[placeholder="https://author.example"] input')
      .fill('https://canary-author.example');
    await first.page.locator('sp-button', { hasText: 'Add server' }).first().click();

    // The list must grow - proving the mutation round-tripped through IPC and
    // came back as new state, not merely that a button was clickable.
    await expect(rows).toHaveCount(initialRowCount + 1, { timeout: 60_000 });
    await expect(first.page.locator('.server-row')).toContainText(['Canary Author']);
    await expect(first.page.locator('.form-errors')).toHaveText('');
  } finally {
    await first.app.close();
  }

  // Persisted to disk, not just held in renderer memory.
  const afterAdd: unknown = JSON.parse(readFileSync(settingsFile, 'utf8'));
  expect(JSON.stringify(afterAdd)).toContain('https://canary-author.example');

  // --- Launch 2: the server is still there, edit it, then remove it -------
  const second = await openSettings();
  try {
    const row = second.page.locator('.server-row', { hasText: 'Canary Author' });
    await expect(row).toHaveCount(1, { timeout: 60_000 });

    // A row has exactly two buttons: Save and Remove.
    await expect(row.locator('sp-button')).toHaveCount(2);
    const save = row.locator('sp-button', { hasText: 'Save' }).first();

    // Save is inert until something is actually dirty.
    await expect(save).toHaveAttribute('disabled', '');
    await row.locator('sp-textfield[aria-label="Server label"] input').fill('Canary Renamed');
    await expect(save).not.toHaveAttribute('disabled', '');
    // Typing the saved value back makes the row clean again, so Save goes inert.
    await row.locator('sp-textfield[aria-label="Server label"] input').fill('Canary Author');
    await expect(save).toHaveAttribute('disabled', '');
    await row.locator('sp-textfield[aria-label="Server label"] input').fill('Canary Renamed');
    await expect(save).not.toHaveAttribute('disabled', '');
    await save.click();

    const renamed = second.page.locator('.server-row', { hasText: 'Canary Renamed' });
    await expect(renamed).toHaveCount(1, { timeout: 60_000 });

    // An address change takes two clicks: the first only warns.
    const addressField = renamed.locator('sp-textfield[aria-label="Server address"] input');
    await addressField.fill('https://canary-moved.example');
    await renamed.locator('sp-button', { hasText: 'Save' }).first().click();
    await expect(renamed.locator('.server-row__edit-status')).toContainText('Click Save again');
    await expect(addressField).toHaveValue('https://canary-moved.example');

    await renamed.locator('sp-button', { hasText: 'Save' }).first().click();
    // The field is re-rendered from the freshly-fetched snapshot, so this
    // value came back out of the store rather than staying typed in the DOM.
    await expect(
      second.page
        .locator('.server-row', { hasText: 'Canary Renamed' })
        .locator('sp-textfield[aria-label="Server address"] input'),
    ).toHaveValue('https://canary-moved.example', { timeout: 60_000 });

    // Removal takes two clicks as well: the first only warns.
    const current = second.page.locator('.server-row', { hasText: 'Canary Renamed' });
    await current.locator('sp-button', { hasText: 'Remove' }).first().click();
    await expect(current.locator('.server-row__edit-status')).toContainText('Click Remove again');
    await expect(current).toHaveCount(1);

    await current.locator('sp-button', { hasText: 'Remove' }).first().click();
    await expect(second.page.locator('.server-row', { hasText: 'Canary Renamed' })).toHaveCount(0, {
      timeout: 60_000,
    });
  } finally {
    await second.app.close();
  }

  const afterRemove: unknown = JSON.parse(readFileSync(settingsFile, 'utf8'));
  expect(JSON.stringify(afterRemove)).not.toContain('https://canary-author.example');
  expect(JSON.stringify(afterRemove)).not.toContain('https://canary-moved.example');
});
