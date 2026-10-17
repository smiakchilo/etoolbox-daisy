import { _electron as electron, expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import { mainEntry } from '../support/e2e/app';
import { createLaunchProfile, writeSettings } from '../support/e2e/profile';
import { byTestId } from '../support/selectors';

/**
 * Regression test for two coupled defects, reproduced by: launch with no last
 * visited URL (the startup hosts picker is showing), pick a host that is not
 * reachable, and - while it is still loading - open Settings.
 *
 *  (a) When the load finally failed, the hosts picker replaced Settings. A
 *      failed navigation must only fall back to the picker when the pane "has
 *      nothing to show"; a panel the user deliberately opened is something to
 *      show, so it must be left alone.
 *  (b) The browser pane's error banner (the "Couldn't load …" row) was hidden
 *      behind whichever whole-size panel was open, because a panel replaced
 *      the whole page panel - banner included. A panel must replace only the
 *      native view's region, exactly like the `WebContentsView` it stands in
 *      for, leaving the status row visible below it.
 *
 * The exact sequence needs a navigation that stays pending long enough to open
 * Settings, then fails: a server that accepts the request but never answers,
 * whose sockets the test destroys. Only the real built app can prove the
 * banner is actually painted under the panel rather than inside a `hidden`
 * subtree, so this drives the real Electron window and reads real geometry.
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'panel-banner-scratch');

/**
 * A server that accepts requests and never responds, so the pane sits in its
 * loading state indefinitely. `fail()` destroys the live sockets, which makes
 * the pending `loadURL` reject as a network error - the "load ends" moment the
 * bug needs, under the test's control rather than a wall-clock timeout.
 */
async function startHangingOrigin(): Promise<{
  origin: string;
  hits: number;
  fail: () => void;
  close: () => void;
}> {
  const state = { hits: 0 };
  const sockets = new Set<Socket>();
  const server: Server = createServer(() => {
    state.hits += 1;
    // Deliberately never respond: the request stays open until `fail()`.
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    get hits() {
      return state.hits;
    },
    fail: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: () => server.close(),
  };
}

test('a failed load does not replace an open panel, and the error banner is visible below it', async () => {
  test.setTimeout(120_000);

  const hanging = await startHangingOrigin();
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
          label: 'Hanging',
          origin: hanging.origin,
          color: { kind: 'swatch', swatch: 'blue' },
          revision: 0,
        },
      ],
    }),
  );

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    const addressBar = page.locator(byTestId('browser-address'));
    await addressBar.waitFor({ state: 'visible', timeout: 30_000 });

    const picker = page.locator(byTestId('hosts-panel'));
    const settingsPanel = page.locator(byTestId('settings-panel'));
    const banner = page.locator('.browser-toolbar-message');
    const viewHost = page.locator('.browser-view-host');

    // Startup hosts picker is open (no last visited URL). Pick the hanging
    // host: the picker closes and a load begins that never settles.
    await expect(picker).toBeVisible({ timeout: 10_000 });
    await page.locator(`${byTestId('hosts-item')}[data-origin="${hanging.origin}"]`).click();
    await expect.poll(() => hanging.hits > 0, { timeout: 30_000 }).toBe(true);
    await expect(picker).toBeHidden();

    // While it is still loading, open Settings from the chat toolbar.
    await page.locator(byTestId('chat-settings')).click();
    await settingsPanel.waitFor({ state: 'visible', timeout: 30_000 });
    await expect(viewHost).toBeHidden();

    // Now let the pending load fail.
    hanging.fail();

    // (a) The failed load must not yank the user out of Settings.
    await expect(banner).toContainText(hanging.origin, { timeout: 60_000 });
    await expect(settingsPanel).toBeVisible();
    await expect(picker).toBeHidden();
    await expect(page.locator(byTestId('browser-hosts-button'))).not.toHaveAttribute('open', '');

    // (b) The banner is a sibling BELOW the panel's slot, so it is genuinely
    // painted under the panel rather than covered by or hidden behind it.
    await expect(banner).toBeVisible();
    await expect(banner).not.toContainText('ERR_');
    // Let the row's reveal animation settle before measuring geometry.
    await page.waitForTimeout(400);

    const panelBox = await settingsPanel.boundingBox();
    const bannerBox = await banner.boundingBox();
    const paneBox = await page.locator('.browser-pane').boundingBox();
    expect(panelBox).not.toBeNull();
    expect(bannerBox).not.toBeNull();
    expect(paneBox).not.toBeNull();
    const panel = panelBox as { y: number; height: number };
    const row = bannerBox as { y: number; height: number };
    const pane = paneBox as { y: number; height: number };

    // Adjacent, not overlapping: the row starts at or below the panel's bottom.
    expect(row.y).toBeGreaterThanOrEqual(panel.y + panel.height - 1);
    // And the row is inside the browser pane (a panel cannot have pushed it
    // out of view).
    expect(row.y + row.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
  } finally {
    await app.close();
    hanging.close();
  }
});

/**
 * Two banner rows can be on screen at once: the pane-owned surface-status row
 * (a Settings confirmation here - the same row History's delete confirmation
 * rides) directly above the browser's own error row. Both are neutral-variant
 * banners of the same dark gray, so stacked they read as one continuous strip
 * (the report behind `browser.css`'s seam rule). The seam - a light
 * `border-block-start` on the lower row, keyed on *both* rows' `open`
 * attributes - must appear only when both are showing: never a stray line
 * against the page while the row above is idle. The `open` attribute, the
 * sibling adjacency and the outer-document win over the component's `:host`
 * `border` shorthand are shadow-DOM facts jsdom cannot prove, so this drives
 * the built app and reads real computed styles.
 */
test('two stacked banner rows are separated only while both are showing', async () => {
  test.setTimeout(120_000);

  const hanging = await startHangingOrigin();
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
          label: 'Hanging',
          origin: hanging.origin,
          color: { kind: 'swatch', swatch: 'blue' },
          revision: 0,
        },
      ],
    }),
  );

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    await page.locator(byTestId('browser-address')).waitFor({ state: 'visible', timeout: 30_000 });

    const errorRow = page.locator('sp-alert-banner.browser-toolbar-message');
    const confirmRow = page.locator('.surface-status-banner[open]');
    const borderTopWidth = () => errorRow.evaluate((node) => getComputedStyle(node).borderTopWidth);

    // Startup hosts picker is open. Pick the hanging host: the picker closes
    // and a load begins that never settles.
    await expect(page.locator(byTestId('hosts-panel'))).toBeVisible({ timeout: 10_000 });
    await page.locator(`${byTestId('hosts-item')}[data-origin="${hanging.origin}"]`).click();
    await expect.poll(() => hanging.hits > 0, { timeout: 30_000 }).toBe(true);

    // Open Settings, then let the pending load fail: the browser's own error
    // row opens, and the surface-status row above it is still idle.
    await page.locator(byTestId('chat-settings')).click();
    await page.locator(byTestId('settings-panel')).waitFor({ state: 'visible', timeout: 30_000 });
    hanging.fail();
    await expect(errorRow).toContainText(hanging.origin, { timeout: 60_000 });
    await expect(errorRow).toBeVisible();

    // Only the lower row is showing: no seam. A rule keyed on the lower row
    // alone would draw a line against the page here, which is the defect the
    // `open` keying exists to prevent.
    expect(await borderTopWidth()).toBe('0px');

    // Raising the Settings removal confirmation (the pane's surface-status
    // row) stacks a second banner above the error row: now the seam appears.
    await page.locator('.multifield__item').first().locator(byTestId('multifield-remove')).click();
    await expect(confirmRow).toBeVisible({ timeout: 60_000 });
    await expect(confirmRow.locator(byTestId('banner-confirm'))).toBeVisible();
    // Wait for the row's reveal animation to settle at its pinned height
    // before measuring geometry (a mid-animation height would read as an
    // overlap that does not exist at rest).
    await expect
      .poll(async () => (await confirmRow.boundingBox())?.height ?? 0, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(40);
    expect(await borderTopWidth()).not.toBe('0px');

    // The two rows are stacked, not overlapped: the error row starts at or
    // below the confirmation's bottom edge - the seam sits between them.
    const confirmBox = await confirmRow.boundingBox();
    const errorBox = await errorRow.boundingBox();
    expect(confirmBox).not.toBeNull();
    expect(errorBox).not.toBeNull();
    expect(errorBox?.y ?? 0).toBeGreaterThanOrEqual(
      (confirmBox?.y ?? 0) + (confirmBox?.height ?? 0) - 1,
    );
  } finally {
    await app.close();
    hanging.close();
  }
});
