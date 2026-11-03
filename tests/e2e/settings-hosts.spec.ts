import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mainEntry } from '../support/e2e/app';
import { verticalGap } from '../support/e2e/layout';
import { createScratchDirs, scratchEnv } from '../support/e2e/profile';
import { byField, byTestId } from '../support/selectors';

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
 * inserts an empty draft, its first valid address (committed when the field is
 * left) creates the host, and the label/colour commit on the same leave with
 * no Save button. An address change and a removal still need the confirmation
 * flows in the pane-owned surface-status banner (`.surface-status-banner`,
 * which outlives the panel). Persistence is asserted by polling `settings.json`
 * on disk, never by trusting the renderer's own re-fetch.
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'step05-settings-scratch');

/**
 * Launches the app, opens Settings, selects the Hosts tab and waits for its
 * "Add item" action - the state every host-field case below starts from.
 */
async function openHostsTab(app: ElectronApplication) {
  const page = await app.firstWindow();
  await page.locator(byTestId('browser-address')).waitFor({ state: 'visible', timeout: 60_000 });
  await page.locator(byTestId('chat-settings')).click();
  await page.locator(byTestId('settings-tab-hosts')).click();
  await page.locator('.multifield__add').first().waitFor({ state: 'visible', timeout: 60_000 });
  return page;
}

test('servers added in the Settings panel persist, and removal persists too', async () => {
  test.setTimeout(180_000);

  const { home, appData, localAppData } = createScratchDirs(scratchBase);

  const env = scratchEnv({ home, appData, localAppData }, { fakeAgent: true });
  const settingsFile = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');

  const openSettings = async () => {
    const app = await electron.launch({ args: [mainEntry], env });
    const shell = await app.firstWindow();
    await shell.locator(byTestId('browser-address')).waitFor({ state: 'visible', timeout: 60_000 });
    await shell.locator(byTestId('chat-settings')).click();
    await shell.locator(byTestId('settings-panel')).waitFor({ state: 'visible', timeout: 60_000 });
    // The panel opens on its first tab (General); the host fields live on Hosts.
    await shell.locator(byTestId('settings-tab-hosts')).click();
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
    const draftAddress = draft.locator(byField('host-address') + ' input');
    const placeholderColor = await draftAddress.evaluate(
      (el) => getComputedStyle(el, '::placeholder').color,
    );
    const valueColor = await draftAddress.evaluate((el) => getComputedStyle(el).color);
    expect(placeholderColor).toBe('rgb(144, 144, 144)');
    expect(valueColor).not.toBe(placeholderColor);

    await draftAddress.fill('https://canary-author.example');
    const draftLabel = draft.locator(byField('host-label') + ' input');
    await draftLabel.fill('Canary Author');
    // A value commits when its field is left, never on a typing pause: taking
    // focus for the label commits the address, and Enter commits the label.
    await draftLabel.press('Enter');

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
    await expect(items.last().locator(byField('host-label') + ' input')).toHaveValue(
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
    const banner = second.page.locator('.surface-status-banner').first();
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
    // button: the fields commit when they are left.
    await expect(items.first().locator('.multifield__action')).toHaveCount(3);

    // Renaming commits when the field is left; Enter is that commit without
    // moving focus. The row then re-renders from the fresh snapshot and the
    // rename reaches disk without any button click.
    const labelField = items.first().locator(byField('host-label') + ' input');
    await labelField.fill('Canary Renamed');
    await labelField.press('Enter');
    await expect.poll(readDoc, { timeout: 60_000 }).toContain('Canary Renamed');
    await expect(labelField).toHaveValue('Canary Renamed', { timeout: 60_000 });

    // An address change is never applied by the commit: leaving the field only
    // raises a one-button confirmation in the banner, and a single OK click
    // persists it.
    const addressField = items.first().locator(byField('host-address') + ' input');
    await addressField.fill('https://canary-moved.example');
    await addressField.press('Enter');
    await expect(banner.locator('sp-action-button')).toHaveCount(1, { timeout: 60_000 });
    await expect(addressField).toHaveValue('https://canary-moved.example');

    await second.page.locator(byTestId('banner-confirm')).first().click();
    // The move reaches disk, and the row re-renders from the freshly-fetched
    // snapshot, so the value came back out of the store rather than staying
    // typed in the DOM.
    await expect.poll(readDoc, { timeout: 60_000 }).toContain('https://canary-moved.example');
    await expect(addressField).toHaveValue('https://canary-moved.example', { timeout: 60_000 });

    // Removal is confirmed in the banner too: the remove click raises the
    // warning, and only the banner's OK button performs it.
    await expect(items).toHaveCount(1);
    await items.first().locator('.multifield__action--remove').click();
    await expect(banner.locator('sp-action-button')).toHaveCount(1);
    await expect(items).toHaveCount(1);

    await second.page.locator(byTestId('banner-confirm')).first().click();
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

  const { home, appData, localAppData } = createScratchDirs(scratchBase);

  const env = scratchEnv({ home, appData, localAppData }, { fakeAgent: true });

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await openHostsTab(app);
    const banner = page.locator('.surface-status-banner').first();

    // One host to edit.
    await page.locator('.multifield__add').first().click();
    const item = page.locator('.multifield__item').last();
    await item.locator(byField('host-address') + ' input').fill('https://height-check.example');
    await item.locator(byField('host-label') + ' input').fill('Height Check');
    await expect(page.locator('.multifield__item')).toHaveCount(1, { timeout: 60_000 });

    // A plain text row: committing the label settles on a status message,
    // which carries no close control and no action button.
    const heightLabel = item.locator(byField('host-label') + ' input');
    await heightLabel.fill('Height Check 2');
    await heightLabel.press('Enter');
    await expect(banner).toHaveText(/\S/, { timeout: 60_000 });
    await expect(banner.locator('sp-action-button')).toHaveCount(0);
    // The row reveals by animating its block-size; measure once it has settled.
    await expect
      .poll(async () =>
        Math.round(await banner.evaluate((node) => node.getBoundingClientRect().height)),
      )
      .toBe(48);
    const textRowHeight = await banner.evaluate((node) => node.getBoundingClientRect().height);

    // A with-button row: committing the address change raises the sticky
    // confirmation with its single OK `sp-action-button`.
    const heightAddress = item.locator(byField('host-address') + ' input');
    await heightAddress.fill('https://height-moved.example');
    await heightAddress.press('Enter');
    await expect(banner.locator('sp-action-button')).toHaveCount(1, { timeout: 60_000 });
    await expect
      .poll(async () =>
        Math.round(await banner.evaluate((node) => node.getBoundingClientRect().height)),
      )
      .toBe(48);
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
 * A field commit (leaving the field) triggers a snapshot re-read. That re-read
 * must not rebuild the rows while the user is still working in one:
 * `replaceItems` detaches the focused field, so the caret would be lost
 * mid-edit. Enter commits without moving focus, which is exactly the case the
 * `containsFocus` guard defends. Only the real app proves the fix, because it
 * hinges on Spectrum's textfield retargeting `document.activeElement` to its
 * shadow host (jsdom's un-upgraded field has no shadow root).
 */
test('a commit does not steal focus from the field being typed in', async () => {
  test.setTimeout(180_000);

  const { home, appData, localAppData } = createScratchDirs(scratchBase);

  const env = scratchEnv({ home, appData, localAppData }, { fakeAgent: true });
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
    const page = await openHostsTab(app);

    // One persisted host (a draft counts as a row, so the disk read is what
    // proves the address save landed and the row is no longer a draft).
    await page.locator('.multifield__add').first().click();
    const item = page.locator('.multifield__item').last();
    const focusAddress = item.locator(byField('host-address') + ' input');
    await focusAddress.fill('https://focus-check.example');
    // Enter commits while the field keeps focus: the commit's own reload must
    // not rebuild the row out from under the caret.
    await focusAddress.press('Enter');
    await expect.poll(readDoc, { timeout: 60_000 }).toContain('https://focus-check.example');

    // Let the host-creation feedback auto-clear, so the next "Settings saved"
    // unambiguously belongs to the label commit below.
    const banner = page.locator('.surface-status-banner').first();
    await expect(banner).toHaveText('', { timeout: 60_000 });

    // Commit the label without leaving it: the reload that follows the commit
    // used to tear the row down.
    const labelHost = item.locator(byField('host-label'));
    await labelHost.locator('input').fill('Focus Check');
    await labelHost.locator('input').press('Enter');
    await expect.poll(readDoc, { timeout: 60_000 }).toContain('Focus Check');
    await expect(banner).toHaveText(/\S/, { timeout: 60_000 });
    // The banner is announced before the reload continuation runs, so give the
    // re-read time to land before asserting.
    await page.waitForTimeout(1000);

    // The very same field node is still focused and still connected: had the
    // reload rebuilt the rows, it would have been detached from the document.
    expect(
      await labelHost.evaluate((el) => el.isConnected && el === el.ownerDocument.activeElement),
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

  const { home, appData, localAppData } = createScratchDirs(scratchBase);

  const env = scratchEnv({ home, appData, localAppData }, { fakeAgent: true });
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

  // --- Launch 1: add two hosts, then close --------------------------------
  const first = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await openHostsTab(first);

    const add = async (label: string, origin: string): Promise<void> => {
      await page.locator('.multifield__add').first().click();
      const item = page.locator('.multifield__item').last();
      await item.locator(byField('host-address') + ' input').fill(origin);
      const labelInput = item.locator(byField('host-label') + ' input');
      await labelInput.fill(label);
      // Leaving the address (label focus) commits it; Enter commits the label.
      await labelInput.press('Enter');
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
    const page = await openHostsTab(second);
    const rows = page.locator('.multifield__item');
    await expect(rows).toHaveCount(2, { timeout: 60_000 });

    // Multifield items are separated by a doubled gap (a subsection boundary),
    // while the fields inside one item keep the plain gap. Asserted relationally
    // so neither exact value is pinned - and this one `.multifield__list` rule
    // is what Hosts, Projects and Proxies all share.
    const itemGap = await verticalGap(rows.nth(0), rows.nth(1));
    const fieldBlocks = rows.nth(0).locator('.host-field');
    const fieldGap = await verticalGap(fieldBlocks.nth(0), fieldBlocks.nth(1));
    expect(itemGap).toBeGreaterThan(fieldGap);

    const up = (index: number) => rows.nth(index).locator('.multifield__action--up');
    const down = (index: number) => rows.nth(index).locator('.multifield__action--down');
    await expect(up(0)).toHaveAttribute('disabled', '');
    await expect(down(0)).not.toHaveAttribute('disabled', '');
    await expect(up(1)).not.toHaveAttribute('disabled', '');
    await expect(down(1)).toHaveAttribute('disabled', '');

    // Focus the first host's address field, then move that host down with the
    // button - which steals focus. The field must come back focused *and*
    // visibly accented, since all the items' fields look alike.
    const movedFrom = rows.nth(0).locator(byField('host-address'));
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
    const movedTo = rows.nth(1).locator(byField('host-address'));
    expect(await movedTo.evaluate((el) => el === el.ownerDocument.activeElement)).toBe(true);

    // Moving again without having focused a field (the button was clicked
    // straight away) still forces focus into the moved item's first field.
    await down(0).click();
    await expect
      .poll(readOrigins, { timeout: 60_000 })
      .toEqual(['https://order-a.example', 'https://order-b.example']);
    const forced = rows.nth(1).locator(byField('host-address'));
    expect(await forced.evaluate((el) => el === el.ownerDocument.activeElement)).toBe(true);
  } finally {
    await second.close();
  }
});

/**
 * The Hosts row at the narrowest browser pane. Colour tag, Label and Type share
 * one line, and only the label is flexible - it used to collapse to nothing and
 * let the Type field's label paint over the Label field's ("LaType"), because
 * the row's two fixed fields already filled the pane. jsdom has no layout, so
 * only the built app can measure this.
 */
test('the Hosts row keeps the label at least as wide as the type at the pane minimum', async () => {
  test.setTimeout(180_000);

  const { home, appData, localAppData } = createScratchDirs(scratchBase);
  const env = scratchEnv({ home, appData, localAppData }, { fakeAgent: true });

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await openHostsTab(app);
    await page.locator('.multifield__add').first().click();
    const item = page.locator('.multifield__item').last();
    const address = item.locator(`${byField('host-address')} input`);
    await address.fill('https://narrow.example');
    await address.press('Enter');
    await expect(page.locator('.multifield__item')).toHaveCount(1, { timeout: 60_000 });

    // Ask for a pane far below its floor; `sp-split-view` clamps to `primary-min`
    // (the floor the shell derives from this very row).
    await page.locator('sp-split-view').evaluate((node) => {
      (node as HTMLElement & { primarySize: string }).primarySize = '200px';
    });

    const row = item.locator('.host-field-row');
    const measure = () =>
      row.evaluate((node) => {
        const children = [...node.children].map((child) => {
          const box = child.getBoundingClientRect();
          return { left: box.left, right: box.right, width: box.width };
        });
        return { children, width: node.getBoundingClientRect().width };
      });

    // Wait for the clamp to settle on the layout under test.
    await expect
      .poll(
        async () => {
          const [color, label, type] = (await measure()).children;
          if (!color || !label || !type) return false;
          return label.width >= type.width && type.width > 0;
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    const { children, width } = await measure();
    const [color, label, type] = children;
    if (!color || !label || !type) throw new Error('expected the three one-line fields');

    // The label is never the squeezed remnant: it is at least the type's width,
    // and the three blocks stand side by side instead of overlapping.
    expect(label.width).toBeGreaterThanOrEqual(type.width);
    expect(color.right).toBeLessThanOrEqual(label.left + 1);
    expect(label.right).toBeLessThanOrEqual(type.left + 1);
    // Nothing spills past the row (the one-line layout still fits the pane).
    expect(type.right).toBeLessThanOrEqual(color.left + width + 1);
  } finally {
    await app.close();
  }
});

/**
 * The host "Type" picker: a real `sp-picker` (jsdom only ever sees an
 * un-upgraded tag) whose choice is presentation metadata - it says which half
 * of a multi-host system the row points at. Selecting one must reach the
 * settings document through `settings:update-server-presentation` without
 * touching the host's revision, come back out of the snapshot, and clear again
 * on "(Default)".
 */
test('a host remembers the type picked for it, and "(Default)" clears it', async () => {
  test.setTimeout(180_000);

  const { home, appData, localAppData } = createScratchDirs(scratchBase);
  const env = scratchEnv({ home, appData, localAppData }, { fakeAgent: true });
  const settingsFile = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');

  const storedHost = (): { readonly type?: string; readonly revision?: number } | undefined => {
    try {
      const doc = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
        hosts?: { origin?: string; type?: string; revision?: number }[];
      };
      return doc.hosts?.find((host) => host.origin === 'https://typed.example');
    } catch {
      return undefined;
    }
  };

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await openHostsTab(app);

    await page.locator('.multifield__add').first().click();
    const item = page.locator('.multifield__item').last();
    const address = item.locator(`${byField('host-address')} input`);
    await address.fill('https://typed.example');
    // Enter commits the address, which creates the host the type attaches to.
    await address.press('Enter');
    await expect.poll(() => storedHost(), { timeout: 60_000 }).toBeDefined();

    const picker = item.locator(byField('host-type'));
    await expect(picker.locator('sp-menu-item')).toHaveCount(3);

    // Selecting is driven through the picker's own `value` + `change` (the same
    // pattern host-proxy-selection uses); clicking a Spectrum overlay is
    // brittle, while this still exercises the real change handler and IPC path.
    await picker.evaluate((node) => {
      const pickerNode = node as HTMLElement & { value: string };
      pickerNode.value = 'author';
      pickerNode.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await expect.poll(() => storedHost()?.type, { timeout: 60_000 }).toBe('author');
    // Presentation, not targeting: the stored revision is untouched.
    expect(storedHost()?.revision).toBe(0);
    // The row shows the role's own label, not the picker's placeholder. The
    // picker's own button label comes first; each menu item carries a `#label`
    // of its own inside its shadow root.
    await expect(picker.locator('#label').first()).toHaveText('Author');

    // Leaving the tab and coming back re-reads the document, so the selection
    // shown again came back through the snapshot rather than staying in memory.
    await page.locator(byTestId('settings-tab-browser')).click();
    await page.locator(byTestId('settings-tab-hosts')).click();
    const reloaded = page.locator('.multifield__item').last().locator(byField('host-type'));
    await expect
      .poll(async () =>
        reloaded.evaluate((node) => (node as HTMLElement & { value: string }).value),
      )
      .toBe('author');

    // "(Default)" is the sentinel the picker's own first option carries.
    const defaultOption = await reloaded.locator('sp-menu-item').first().getAttribute('value');
    if (defaultOption === null) throw new Error('the default option carries no value');
    await reloaded.evaluate((node, value) => {
      const pickerNode = node as HTMLElement & { value: string };
      pickerNode.value = value;
      pickerNode.dispatchEvent(new Event('change', { bubbles: true }));
    }, defaultOption);

    await expect.poll(() => storedHost()?.type, { timeout: 60_000 }).toBeUndefined();
    await expect(reloaded.locator('#label').first()).toHaveText('(Default)');
  } finally {
    await app.close();
  }
});
