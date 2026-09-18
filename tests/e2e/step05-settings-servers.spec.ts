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
 *
 * Since step 10 the fields auto-save (debounced ~1s, no Save button): the
 * label/colour edits persist by themselves, while an address change and a
 * removal need the confirmation flows in the panel's one banner
 * (`.settings-banner`). Persistence is asserted by polling `settings.json` on
 * disk, never by trusting the renderer's own re-fetch.
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
    await first.page.locator('sp-button', { hasText: 'Add host' }).first().click();

    // The list must grow - proving the mutation round-tripped through IPC and
    // came back as new state, not merely that a button was clickable.
    await expect(rows).toHaveCount(initialRowCount + 1, { timeout: 60_000 });
    await expect(first.page.locator('.server-row')).toContainText(['Canary Author']);
  } finally {
    await first.app.close();
  }

  // Persisted to disk, not just held in renderer memory.
  const afterAdd: unknown = JSON.parse(readFileSync(settingsFile, 'utf8'));
  expect(JSON.stringify(afterAdd)).toContain('https://canary-author.example');

  // --- Launch 2: the server is still there, rename it, move it, remove it --
  const second = await openSettings();
  try {
    const banner = second.page.locator('.settings-banner').first();
    // Reads the settings document on disk; the poll retries until a save lands.
    // It must not throw while the file is briefly absent, since expect.poll
    // fails immediately on a thrown callback rather than retrying it.
    const readDoc = () => {
      try {
        return readFileSync(settingsFile, 'utf8');
      } catch {
        return '';
      }
    };

    const row = second.page.locator('.server-row', { hasText: 'Canary Author' });
    await expect(row).toHaveCount(1, { timeout: 60_000 });

    // A row has exactly one button now: Remove. The label/colour and address
    // auto-save ~1s after the last edit; there is no Save button left.
    await expect(row.locator('sp-button')).toHaveCount(1);

    // Renaming auto-saves on its own: the row re-renders from the fresh
    // snapshot and the rename reaches disk without any button click.
    const labelField = row.locator('sp-textfield[aria-label="Host label"] input');
    await labelField.fill('Canary Renamed');
    const renamed = second.page.locator('.server-row', { hasText: 'Canary Renamed' });
    await expect(renamed).toHaveCount(1, { timeout: 60_000 });
    await expect.poll(readDoc, { timeout: 60_000 }).toContain('Canary Renamed');

    // An address change is never applied by the auto-save: the debounce only
    // raises a one-button confirmation in the banner, and a single OK click
    // persists it.
    const addressField = renamed.locator('sp-textfield[aria-label="Host address"] input');
    await addressField.fill('https://canary-moved.example');
    await expect(banner).toContainText('Confirm changing the address', { timeout: 60_000 });
    await expect(addressField).toHaveValue('https://canary-moved.example');

    await second.page
      .locator('.settings-banner sp-action-button', { hasText: 'OK' })
      .first()
      .click();
    // The move reaches disk, and the row re-renders from the freshly-fetched
    // snapshot, so the value came back out of the store rather than staying
    // typed in the DOM.
    await expect.poll(readDoc, { timeout: 60_000 }).toContain('https://canary-moved.example');
    await expect(addressField).toHaveValue('https://canary-moved.example', { timeout: 60_000 });

    // Removal is confirmed in the banner too: the Remove click raises the
    // warning, and only the banner's OK button performs it.
    const current = second.page.locator('.server-row', { hasText: 'Canary Renamed' });
    await current.locator('sp-button', { hasText: 'Remove' }).first().click();
    await expect(banner).toContainText('Confirm removing the host. This action cannot be undone');
    await expect(current).toHaveCount(1);

    await second.page
      .locator('.settings-banner sp-action-button', { hasText: 'OK' })
      .first()
      .click();
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

/**
 * The shared banner row (`.banner-row`, lib/alertBanner.ts + banner.css) must
 * hold one height whether or not it contains an action button: a plain
 * status row and a with-button confirmation must measure the same. jsdom has
 * no layout, so only the real built app can prove this - and the fix that
 * pinned it (zeroing the component's `.text` slot margins) is exactly the
 * kind of CSS that would otherwise regress silently.
 */
test('the Settings banner keeps one height with and without an action button', async () => {
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
    const page = await app.firstWindow();
    await page.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
    await page.locator('sp-action-button', { hasText: 'Settings' }).first().click();
    await page.locator('.add-server-form').first().waitFor({ state: 'visible', timeout: 60_000 });
    const banner = page.locator('.settings-banner').first();

    // One host to edit.
    await page.locator('sp-textfield[placeholder="Label"] input').fill('Height Check');
    await page
      .locator('sp-textfield[placeholder="https://author.example"] input')
      .fill('https://height-check.example');
    await page.locator('sp-button', { hasText: 'Add host' }).first().click();
    const added = page.locator('.server-row', { hasText: 'Height Check' });
    await expect(added).toHaveCount(1, { timeout: 60_000 });

    // A plain text row: the label auto-save settles on "Settings saved",
    // which carries no close control and no action button.
    await added.locator('sp-textfield[aria-label="Host label"] input').fill('Height Check 2');
    await expect(banner).toHaveText('Settings saved', { timeout: 60_000 });
    await expect(banner.locator('sp-action-button')).toHaveCount(0);
    const textRowHeight = await banner.evaluate((node) => node.getBoundingClientRect().height);

    // A with-button row: the address change raises the sticky confirmation
    // with its single OK `sp-action-button`.
    const moved = page.locator('.server-row', { hasText: 'Height Check 2' });
    await moved
      .locator('sp-textfield[aria-label="Host address"] input')
      .fill('https://height-moved.example');
    await expect(banner).toContainText('Confirm changing the address', { timeout: 60_000 });
    await expect(banner.locator('sp-action-button')).toHaveCount(1);
    const buttonRowHeight = await banner.evaluate((node) => node.getBoundingClientRect().height);

    // The whole point: the banner does not grow when an action appears. Both
    // rows sit on the theme's 48px banner minimum (the pinned height from
    // banner.css); before the fix the with-button row measured ~63px.
    expect(Math.round(textRowHeight)).toBe(48);
    expect(Math.round(buttonRowHeight)).toBe(48);
  } finally {
    await app.close();
  }
});
