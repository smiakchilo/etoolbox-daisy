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
 * The Hosts tab is now a multifield (reusable `lib/multifield.ts`): "Add item"
 * inserts an empty draft, its first valid address creates the host, and the
 * label/colour auto-save (debounced ~1s, no Save button). An address change
 * and a removal still need the confirmation flows in the panel's one banner
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
    await shell.locator('sp-action-button[title="Settings"]').first().click();
    await shell.locator('.settings-panel').first().waitFor({ state: 'visible', timeout: 60_000 });
    await shell.locator('.multifield__add').first().waitFor({ state: 'visible', timeout: 60_000 });
    return { app, page: shell };
  };

  // --- Launch 1: add a server through the multifield ----------------------
  const first = await openSettings();
  try {
    const items = first.page.locator('.multifield__item');
    const initialRowCount = await items.count();

    // "Add item" inserts the first (and only) empty draft.
    await first.page.locator('.multifield__add').first().click();
    const draft = items.last();
    await expect(draft).toHaveCount(1);

    // The placeholder is the theme's gray-500, distinct from the value colour
    // (which Spectrum's textfield otherwise shares with the placeholder).
    const draftAddress = draft.locator('sp-textfield[aria-label="Address"] input');
    const placeholderColor = await draftAddress.evaluate(
      (el) => getComputedStyle(el, '::placeholder').color,
    );
    const valueColor = await draftAddress.evaluate((el) => getComputedStyle(el).color);
    expect(placeholderColor).toBe('rgb(144, 144, 144)');
    expect(valueColor).not.toBe(placeholderColor);

    await draftAddress.fill('https://canary-author.example');
    await draft.locator('sp-textfield[aria-label="Label"] input').fill('Canary Author');

    // The draft's first valid address creates the host. The disk read is the
    // real proof (a draft already counts as one row before it is saved), and it
    // also guarantees the write landed before the app is closed.
    await expect
      .poll(
        () => {
          try {
            return readFileSync(settingsFile, 'utf8');
          } catch {
            return '';
          }
        },
        { timeout: 60_000 },
      )
      .toContain('https://canary-author.example');
    await expect(items).toHaveCount(initialRowCount + 1, { timeout: 60_000 });
    await expect(items.last().locator('sp-textfield[aria-label="Label"] input')).toHaveValue(
      'Canary Author',
      { timeout: 60_000 },
    );
  } finally {
    await first.app.close();
  }

  // Persisted to disk, not just held in renderer memory. The document node
  // is `hosts` (schema v2), never `servers`.
  const afterAdd: unknown = JSON.parse(readFileSync(settingsFile, 'utf8'));
  expect(JSON.stringify(afterAdd)).toContain('https://canary-author.example');
  expect(JSON.stringify(afterAdd)).toContain('"hosts"');
  expect(JSON.stringify(afterAdd)).not.toContain('"servers"');
  expect(JSON.stringify(afterAdd)).not.toContain('"activeServerId"');

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

    const items = second.page.locator('.multifield__item');
    await expect(items).toHaveCount(1, { timeout: 60_000 });

    // A host row has its three icon actions (up/down/remove) and no Save
    // button: the fields auto-save ~1s after the last edit.
    await expect(items.first().locator('.multifield__action')).toHaveCount(3);

    // Renaming auto-saves on its own: the row re-renders from the fresh
    // snapshot and the rename reaches disk without any button click.
    const labelField = items.first().locator('sp-textfield[aria-label="Label"] input');
    await labelField.fill('Canary Renamed');
    await expect.poll(readDoc, { timeout: 60_000 }).toContain('Canary Renamed');
    await expect(labelField).toHaveValue('Canary Renamed', { timeout: 60_000 });

    // An address change is never applied by the auto-save: the debounce only
    // raises a one-button confirmation in the banner, and a single OK click
    // persists it.
    const addressField = items.first().locator('sp-textfield[aria-label="Address"] input');
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

    // Removal is confirmed in the banner too: the remove click raises the
    // warning, and only the banner's OK button performs it.
    await expect(items).toHaveCount(1);
    await items.first().locator('.multifield__action--remove').click();
    await expect(banner).toContainText('Confirm removing the host. This action cannot be undone');
    await expect(items).toHaveCount(1);

    await second.page
      .locator('.settings-banner sp-action-button', { hasText: 'OK' })
      .first()
      .click();
    await expect(items).toHaveCount(0, { timeout: 60_000 });
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
    await page.locator('sp-action-button[title="Settings"]').first().click();
    await page.locator('.multifield__add').first().waitFor({ state: 'visible', timeout: 60_000 });
    const banner = page.locator('.settings-banner').first();

    // One host to edit.
    await page.locator('.multifield__add').first().click();
    const item = page.locator('.multifield__item').last();
    await item
      .locator('sp-textfield[aria-label="Address"] input')
      .fill('https://height-check.example');
    await item.locator('sp-textfield[aria-label="Label"] input').fill('Height Check');
    await expect(page.locator('.multifield__item')).toHaveCount(1, { timeout: 60_000 });

    // A plain text row: the label auto-save settles on "Settings saved",
    // which carries no close control and no action button.
    await item.locator('sp-textfield[aria-label="Label"] input').fill('Height Check 2');
    await expect(banner).toHaveText('Settings saved', { timeout: 60_000 });
    await expect(banner.locator('sp-action-button')).toHaveCount(0);
    const textRowHeight = await banner.evaluate((node) => node.getBoundingClientRect().height);

    // A with-button row: the address change raises the sticky confirmation
    // with its single OK `sp-action-button`.
    await item
      .locator('sp-textfield[aria-label="Address"] input')
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

/**
 * The "Settings saved" feedback follows an auto-save, and that auto-save also
 * triggers a snapshot re-read. That re-read must not rebuild the rows while the
 * user is still typing in one: `replaceItems` detaches the focused field, so
 * the banner would look like it had stolen focus and the caret would be lost
 * mid-edit. Only the real app proves the fix, because it hinges on Spectrum's
 * textfield retargeting `document.activeElement` to its shadow host (jsdom's
 * un-upgraded field has no shadow root).
 */
test('an auto-save does not steal focus from the field being typed in', async () => {
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
  const readDoc = (): string => {
    try {
      return readFileSync(settingsFile, 'utf8');
    } catch {
      return '';
    }
  };

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    await page.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
    await page.locator('sp-action-button[title="Settings"]').first().click();
    await page.locator('.multifield__add').first().waitFor({ state: 'visible', timeout: 60_000 });

    // One persisted host (a draft counts as a row, so the disk read is what
    // proves the address save landed and the row is no longer a draft).
    await page.locator('.multifield__add').first().click();
    const item = page.locator('.multifield__item').last();
    await item
      .locator('sp-textfield[aria-label="Address"] input')
      .fill('https://focus-check.example');
    await expect.poll(readDoc, { timeout: 60_000 }).toContain('https://focus-check.example');

    // Let the host-creation feedback auto-clear, so the next "Settings saved"
    // unambiguously belongs to the label save below.
    const banner = page.locator('.settings-banner').first();
    await expect(banner).toHaveText('', { timeout: 60_000 });

    // Type into the label; the debounced save settles on "Settings saved" and
    // fires the snapshot re-read that used to tear the row down.
    const labelHost = item.locator('sp-textfield[aria-label="Label"]');
    await labelHost.locator('input').fill('Focus Check');
    await expect.poll(readDoc, { timeout: 60_000 }).toContain('Focus Check');
    await expect(banner).toHaveText('Settings saved', { timeout: 60_000 });
    // The banner is announced before the reload continuation runs, so give the
    // re-read time to land before asserting.
    await page.waitForTimeout(1000);

    // The very same field node is still focused and still connected: had the
    // reload rebuilt the rows, it would have been detached from the document.
    expect(
      await labelHost.evaluate(
        (el) => el.isConnected && el === el.ownerDocument.activeElement,
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
});

/**
 * Reordering is part of the requirement, and its persistence is a real IPC
 * round trip (`settings:reorder-servers`), so it is proven here rather than
 * only against the store in isolation. This also pins the bound recomputation:
 * up is disabled on the first row and down on the last, and those must follow
 * the *new* order immediately after a move.
 */
test('reordering hosts persists, and the move buttons follow the new order', async () => {
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

  const readOrigins = (): string[] => {
    try {
      const doc = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
        hosts?: { origin?: string }[];
      };
      return (doc.hosts ?? []).map((server) => server.origin ?? '');
    } catch {
      return [];
    }
  };

  const openSettings = async (app: Awaited<ReturnType<typeof electron.launch>>) => {
    const page = await app.firstWindow();
    await page.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
    await page.locator('sp-action-button[title="Settings"]').first().click();
    await page.locator('.multifield__item').first().waitFor({ state: 'visible', timeout: 60_000 });
    return page;
  };

  // --- Launch 1: add two hosts, then close --------------------------------
  const first = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await first.firstWindow();
    await page.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
    await page.locator('sp-action-button[title="Settings"]').first().click();
    await page.locator('.multifield__add').first().waitFor({ state: 'visible', timeout: 60_000 });

    const add = async (label: string, origin: string): Promise<void> => {
      await page.locator('.multifield__add').first().click();
      const item = page.locator('.multifield__item').last();
      await item.locator('sp-textfield[aria-label="Address"] input').fill(origin);
      await item.locator('sp-textfield[aria-label="Label"] input').fill(label);
      await expect.poll(readOrigins, { timeout: 60_000 }).toContain(origin);
    };
    await add('Order A', 'https://order-a.example');
    await add('Order B', 'https://order-b.example');
  } finally {
    await first.close();
  }

  // --- Launch 2: every row is a persisted host (no drafts), so the reorder
  // is deterministic. The bounds must follow the new order immediately. ---
  const second = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await openSettings(second);
    const rows = page.locator('.multifield__item');
    await expect(rows).toHaveCount(2, { timeout: 60_000 });

    const up = (index: number) => rows.nth(index).locator('.multifield__action--up');
    const down = (index: number) => rows.nth(index).locator('.multifield__action--down');
    await expect(up(0)).toHaveAttribute('disabled', '');
    await expect(down(0)).not.toHaveAttribute('disabled', '');
    await expect(up(1)).not.toHaveAttribute('disabled', '');
    await expect(down(1)).toHaveAttribute('disabled', '');

    // Focus the first host's address field, then move that host down with the
    // button - which steals focus. The field must come back focused *and*
    // visibly accented, since all the items' fields look alike.
    const movedFrom = rows.nth(0).locator('sp-textfield[aria-label="Address"]');
    await movedFrom.click();
    await down(0).click();
    await expect
      .poll(readOrigins, { timeout: 60_000 })
      .toEqual(['https://order-b.example', 'https://order-a.example']);

    // The bounds flip immediately, with the moved row's own buttons correct.
    await expect(up(0)).toHaveAttribute('disabled', '');
    await expect(down(1)).toHaveAttribute('disabled', '');
    await expect(down(0)).not.toHaveAttribute('disabled', '');
    await expect(up(1)).not.toHaveAttribute('disabled', '');

    // The moved field (now the second row) still holds focus: the caret stays
    // in the field the user was editing.
    const movedTo = rows.nth(1).locator('sp-textfield[aria-label="Address"]');
    expect(await movedTo.evaluate((el) => el === el.ownerDocument.activeElement)).toBe(true);

    // Moving again without having focused a field (the button was clicked
    // straight away) still forces focus into the moved item's first field.
    await down(0).click();
    await expect
      .poll(readOrigins, { timeout: 60_000 })
      .toEqual(['https://order-a.example', 'https://order-b.example']);
    const forced = rows.nth(1).locator('sp-textfield[aria-label="Address"]');
    expect(await forced.evaluate((el) => el === el.ownerDocument.activeElement)).toBe(true);
  } finally {
    await second.close();
  }
});
