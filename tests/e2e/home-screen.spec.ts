import { _electron as electron, expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';

/**
 * The left pane's home (welcome) screen: the base layer that guarantees the
 * page-view region is never blank.
 *
 * On a fresh profile (no hosts) the pane lands on the home screen - not a bare
 * native view, and not a Settings panel opened merely to cover the gap. The
 * home screen fills in the app name/version and the user-invocable skill
 * catalogue asynchronously, after the first paint. When a first load fails with
 * no page to restore, the home screen stays put behind the error row.
 *
 * This is exercised against the real built app: the real `.browser-home` DOM,
 * the real async `getAppInfo`/`listSkills` fill, and the real native-view
 * collapse.
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'home-screen-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function startEchoOrigin(): Promise<{ origin: string; close: () => void }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>echo</title><p>ok</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
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

test('a fresh install lands on the home screen, with no panel covering a gap', async () => {
  test.setTimeout(120_000);

  const { env } = launchProfile();
  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    await page.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });

    const homeScreen = page.locator('.browser-home');
    await expect(homeScreen).toBeVisible({ timeout: 10_000 });
    // The native view is collapsed and no panel is auto-opened on a fresh
    // profile - the home screen is the landing surface, not a cover for a
    // blank.
    await expect(page.locator('[data-testid="browser-view-host"]')).toBeHidden();
    await expect(page.locator('.settings-panel')).toBeHidden();
    await expect(page.locator('.hosts-panel')).toBeHidden();

    // Name is static; version arrives from `getAppInfo`; the skill list arrives
    // from the (folder-scanned, non-hardcoded) catalogue.
    await expect(page.locator('.browser-home__name')).toHaveText('EToolbox Daisy');
    await expect(page.locator('.browser-home__version')).toContainText('Version', {
      timeout: 10_000,
    });
    await expect(page.locator('.browser-home__skill-name').first()).toBeVisible({
      timeout: 10_000,
    });
    const skillNames = await page
      .locator('.browser-home__skill-name')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent));
    expect(skillNames).toContain('/search');
    await expect(page.locator('.browser-home__section-title')).toHaveText('Useful commands');

    // No hosts are configured, so "Choose a host" is not offered.
    await expect(page.locator('.browser-home__action').first()).toBeDisabled();

    // The action row is Select a host / History / Settings; History opens the
    // stored-conversations panel (the same one the chat toolbar's button opens).
    const actionLabels = await page
      .locator('.browser-home__action')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent));
    expect(actionLabels).toEqual(['Select a host', 'History', 'Settings']);

    await page.locator('.browser-home__action', { hasText: 'History' }).click();
    await expect(page.locator('.history-panel')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.history-panel__empty')).toContainText('No stored conversations', {
      timeout: 10_000,
    });
    await page.locator('.history-panel .panel__close').click();
    await expect(page.locator('.history-panel')).toBeHidden();
  } finally {
    await app.close();
  }
});

test('a failed first load leaves the home screen in place behind the error row', async () => {
  test.setTimeout(120_000);

  const server = await startEchoOrigin();
  const origin = server.origin;
  // Close the server so the host is configured but unreachable: the first load
  // fails with no page to fall back to.
  server.close();

  const { home, env } = launchProfile();
  const base = defaultAppSettings();
  writeSettings(
    home,
    appSettingsSchema.parse({
      ...base,
      hosts: [
        ...base.hosts,
        {
          id: randomUUID(),
          label: 'Dead',
          origin,
          color: { kind: 'swatch', swatch: 'red' },
          revision: 0,
        },
      ],
    }),
  );

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    const panel = page.locator('.hosts-panel');
    const homeScreen = page.locator('.browser-home');
    const message = page.locator('.browser-toolbar-message');

    // Seeded host: the picker leads at startup.
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await page.locator(`.hosts-item[data-origin="${origin}"]`).click();

    // The load fails and the error row appears below the page-view region.
    await expect(message).toHaveAttribute('open', '', { timeout: 30_000 });
    // No page ever committed, so the home screen - not a blank native view -
    // remains behind the error row.
    await expect(page.locator('[data-testid="browser-view-host"]')).toBeHidden();
    await expect(homeScreen).toBeVisible();
  } finally {
    await app.close();
  }
});

test('the toolbar Home button reveals the home screen over a loaded page, and navigating leaves it', async () => {
  test.setTimeout(120_000);

  const server = await startEchoOrigin();
  const { home, env } = launchProfile();
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
    const homeScreen = page.locator('.browser-home');
    const viewHost = page.locator('[data-testid="browser-view-host"]');

    // Load a page from the startup picker.
    await expect(page.locator('.hosts-panel')).toBeVisible({ timeout: 10_000 });
    await page.locator(`.hosts-item[data-origin="${server.origin}"]`).click();
    await expect(viewHost).toBeVisible({ timeout: 30_000 });
    await expect(homeScreen).toBeHidden();

    // The Home control is leftmost and its icon is really registered (jsdom
    // cannot prove a custom element is registered - see AGENTS.md section 9).
    const homeButton = page.locator('sp-action-button[title="Home"]');
    await expect(homeButton).toBeVisible();
    expect(await page.evaluate(() => Boolean(customElements.get('sp-icon-home')))).toBe(true);

    // Pressing Home reveals the home screen over the loaded page, without
    // navigating away (the view is only collapsed). The veil is not a page:
    // the address bar is blank, Back/Forward are disabled, and a close control
    // gives an obvious way back.
    await homeButton.click();
    await expect(homeScreen).toBeVisible();
    await expect(viewHost).toBeHidden();

    const addressInput = page.locator('#browser-address-bar input');
    await expect(addressInput).toHaveValue('');
    await expect(page.locator('sp-action-button[aria-label="Back"]')).toBeDisabled();
    await expect(page.locator('sp-action-button[aria-label="Forward"]')).toBeDisabled();

    const close = page.locator('.browser-home__close');
    await expect(close).toBeVisible();
    // The close control reuses the panels' own hairline close glyph, which is
    // really registered (jsdom cannot prove a custom element is registered -
    // see AGENTS.md section 9).
    expect(await page.evaluate(() => Boolean(customElements.get('daisy-close-icon')))).toBe(true);

    // Closing returns to the page it covered - the same page, no navigation -
    // with the address and Back control restored.
    await close.click();
    await expect(viewHost).toBeVisible();
    await expect(homeScreen).toBeHidden();
    await expect(addressInput).toHaveValue(`${server.origin}/`, { timeout: 10_000 });
    await expect(close).toBeHidden();

    // Home again, then a real navigation (Refresh) leaves the veil and
    // returns the page - Refresh is a page control, not a veil control.
    await homeButton.click();
    await expect(homeScreen).toBeVisible();
    await page.locator('sp-action-button[aria-label="Refresh"]').click();
    await expect(viewHost).toBeVisible();
    await expect(homeScreen).toBeHidden();
  } finally {
    await app.close();
    server.close();
  }
});

test('the home close control sits exactly where a panel close control does, so opening/closing Settings does not move it', async () => {
  test.setTimeout(120_000);

  const server = await startEchoOrigin();
  const { home, env } = launchProfile();
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
    await expect(page.locator('.hosts-panel')).toBeVisible({ timeout: 10_000 });
    await page.locator(`.hosts-item[data-origin="${server.origin}"]`).click();
    await expect(page.locator('[data-testid="browser-view-host"]')).toBeVisible({
      timeout: 30_000,
    });

    await page.locator('sp-action-button[title="Home"]').click();
    const close = page.locator('.browser-home__close');
    await expect(close).toBeVisible();
    const before = await close.boundingBox();

    // Settings opens over the same slot the welcome screen fills; its own close
    // control must land on the identical screen position, so the cross does not
    // jump when the panel appears (or when it is dismissed and the welcome
    // screen returns).
    await page.locator('.browser-home__action', { hasText: 'Settings' }).click();
    await expect(page.locator('.settings-panel')).toBeVisible();
    const panelClose = await page.locator('.settings-panel .panel__close').boundingBox();

    await page.locator('.settings-panel .panel__close').click();
    await expect(page.locator('.settings-panel')).toBeHidden();
    await expect(close).toBeVisible();
    const after = await close.boundingBox();

    expect(before).not.toBeNull();
    expect(panelClose).not.toBeNull();
    expect(after).not.toBeNull();
    // Same position as the panel's close (within a pixel, for sub-pixel layout).
    expect(Math.abs((before?.x ?? 0) - (panelClose?.x ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((before?.y ?? 0) - (panelClose?.y ?? 0))).toBeLessThanOrEqual(1);
    // And unchanged across the open/close cycle.
    expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
  } finally {
    await app.close();
    server.close();
  }
});
