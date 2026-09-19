import { _electron as electron, expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';

/**
 * The closeability contract for whole-size panels over the page-view region.
 *
 * A whole-size panel (hosts picker, Settings) *replaces* the native
 * `WebContentsView`: while it is open the view is suspended and the reserved
 * `#browser-view-host` region is hidden underneath it. Dismissing such a panel
 * therefore reveals the bare page-view region, which is only meaningful once a
 * real page has loaded into the native view. So the browser pane gates every
 * *user-facing* dismissal affordance on "has a page loaded under the panel
 * yet":
 *
 *   - the close (cross) button is `disabled`,
 *   - Escape is inert,
 *   - the toolbar hosts-button toggle does nothing,
 *
 * until the first `onStateChanged` push arrives from the main process (any
 * navigation start/stop, successful or not). The latch is one-way for the
 * session. Selecting a host is the sanctioned exit while locked: it closes the
 * panel AND loads a page in the one gesture, so the region is never left bare.
 *
 * This is exercised against the real built app: the disabled attribute on a
 * real `sp-action-button`, real Escape dispatch on `document`, a real
 * `sp-picker-button` toggle, and the real hidden/visible native-view region.
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'panel-closeability-scratch');

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

test('a whole-size panel cannot be dismissed until a page sits under it, then every dismissal works', async () => {
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
    const panel = page.locator('.hosts-panel');
    const closeButton = page.locator('.hosts-panel__close');
    const pickerButton = page.locator('#hosts-button');
    const viewHost = page.locator('[data-testid="browser-view-host"]');

    // A seeded profile means the hosts picker is already open at startup, and
    // because no page has loaded under it yet, it is LOCKED: the cross button
    // is disabled (so a click can never activate it), Escape is inert, and the
    // toolbar hosts-button toggle does nothing.
    await panel.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(closeButton).toBeDisabled();
    await expect(viewHost).toBeHidden();
    await expect(pickerButton).toHaveAttribute('open', '');

    await page.keyboard.press('Escape');
    await expect(panel).toBeVisible();
    await expect(closeButton).toBeDisabled();
    await expect(viewHost).toBeHidden();

    await pickerButton.click();
    await expect(panel).toBeVisible();
    await expect(closeButton).toBeDisabled();
    await expect(viewHost).toBeHidden();

    // Selecting a host is the sanctioned way out of a locked panel: it closes
    // the panel AND loads a page in one gesture, leaving a real page under the
    // restored region - never a bare one. The latch is one-way, so the panel
    // is closeable from now on.
    await page.locator(`.hosts-item[data-origin="${server.origin}"]`).click();
    await expect.poll(() => server.hits > 0, { timeout: 30_000 }).toBe(true);
    await expect(panel).toBeHidden();
    await expect(viewHost).toBeVisible();

    // --- Unlocked: reopen through the toolbar toggle -------------------------
    await pickerButton.click();
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(closeButton).toBeEnabled();

    // 1. The cross button now dismisses and restores the native view region.
    await closeButton.click();
    await expect(panel).toBeHidden();
    await expect(viewHost).toBeVisible();

    // 2. Escape now dismisses too.
    await pickerButton.click();
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(viewHost).toBeVisible();

    // 3. The hosts-button toggle now closes the open panel as well.
    await pickerButton.click();
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await pickerButton.click();
    await expect(panel).toBeHidden();
    await expect(viewHost).toBeVisible();
    await expect(pickerButton).not.toHaveAttribute('open', '');
  } finally {
    await app.close();
    server.close();
  }
});
