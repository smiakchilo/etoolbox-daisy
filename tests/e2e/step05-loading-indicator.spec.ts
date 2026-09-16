import { _electron as electron, expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';

/**
 * Loading indicators for navigations initiated outside the webview (the
 * toolbar's Refresh/Stop trio && the unified "Loading…" banner).
 *
 * The unit suite proves the renderer's state machine (arm on a chrome
 * action, banner shown while `isLoading`, Refresh⇄Stop swap, disarming on
 * did-stop-loading) with fake IPC. This spec proves the whole chain against
 * the real built app: a real server that deliberately withholds its response
 * long enough to observe the loading phase, real `did-start-navigation` /
 * `did-stop-loading` states, real custom elements.
 *
 * Two things past failures have shown must be asserted here (AGENTS.md §9,
 * "jsdom cannot prove a custom element is registered"): custom element
 * registration (`customElements.get`) and a real shadow root on the banner.
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'step05-loading-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * A server that answers every request only after `delayMs`, so the loading
 * phase is real and long enough to observe. The eventual body is a tiny HTML
 * page whose title proves the page actually rendered after the banner.
 */
function startSlowServer(delayMs: number): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html lang="en"><head><title>Slow page</title></head><body><h1 id="rendered">rendered</h1></body></html>',
      );
    }, delayMs);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

test('an external navigation shows "Loading…" + Stop until the page renders, then restores Refresh', async () => {
  test.setTimeout(120_000);

  const { server, port } = await startSlowServer(2_500);
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

  // Pre-seed a server whose (configured) origin resolves to the slow fixture.
  const origin = `http://127.0.0.1:${String(port)}`;
  const serverId = randomUUID();

  const settingsPath = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
  const base = defaultAppSettings();
  const seeded = appSettingsSchema.parse({
    ...base,
    servers: [
      ...base.servers,
      {
        id: serverId,
        label: 'Slow fixture',
        origin,
        color: { kind: 'swatch', swatch: 'blue' },
        revision: 0,
      },
    ],
  });
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(seeded, null, 2), 'utf8');

  const app = await electron.launch({ args: [mainEntry], env });
  const page = await app.firstWindow();
  await page.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 30_000 });

  const addressInput = page.locator('#browser-address-bar input');
  await addressInput.fill(origin);
  await addressInput.press('Enter');

  // The loading banner is an `sp-alert-banner` with a real shadow root
  // (registered, not an unknown element), carrying the spinner + text.
  const banner = page.locator('sp-alert-banner.browser-toolbar-message');
  await expect(banner).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() => banner.evaluate(() => Boolean(customElements.get('sp-alert-banner'))))
    .toBe(true);
  await expect.poll(() => banner.evaluate((element) => element.shadowRoot !== null)).toBe(true);
  await expect(banner).toContainText('Loading\u2026');
  await expect(banner.locator('sp-progress-circle')).toHaveCount(1);

  // The loading banner is not dismissible - a load in flight is not something
  // to wave away; only error/prompt rows get a close control.
  await expect(banner).not.toHaveAttribute('dismissible', '');

  // The loading presentation ends in a narrow indeterminate progress line
  // pinned to the banner's bottom edge: a hand-copied `sp-progress-bar`
  // size="s" sweep (the light-DOM track + animated fill; see shell.css).
  await expect(banner.locator('.browser-toolbar-message__progress')).toHaveCount(1);
  const progressStyle = await banner.evaluate((element) => {
    const track = element.querySelector<HTMLElement>('.browser-toolbar-message__progress');
    const fill = track?.querySelector<HTMLElement>('.browser-toolbar-message__progress-fill');
    if (!track || !fill) return null;
    const trackCS = getComputedStyle(track);
    const fillCS = getComputedStyle(fill);
    return {
      position: trackCS.position,
      height: trackCS.height,
      borderRadius: trackCS.borderRadius,
      trackBackground: trackCS.backgroundColor,
      fillColor: fillCS.backgroundColor,
      animationIterationCount: fillCS.animationIterationCount,
      animationDuration: fillCS.animationDuration,
    };
  });
  expect(progressStyle).toEqual({
    position: 'absolute',
    height: '4px',
    borderRadius: '4px',
    trackBackground: 'rgb(213, 213, 213)',
    fillColor: 'rgb(2, 101, 220)',
    animationIterationCount: 'infinite',
    animationDuration: '1s',
  });

  // The loading presentation is light-gray (--spectrum-gray-200), not the
  // neutral dark-gray. The fill is decided inside the banner's shadow
  // (`background-color` on `:host`), so the computed style of the host has to
  // be read here - a unit test cannot see the real painted colors.
  await expect
    .poll(() => banner.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe('rgb(230, 230, 230)');

  // The progress circle must itself be registered (AGENTS.md §9: a missing
  // import renders an unknown element that matches the selector but is inert).
  await expect
    .poll(() => page.evaluate(() => Boolean(customElements.get('sp-progress-circle'))))
    .toBe(true);

  // During loading the Refresh button becomes the Stop button.
  const toolbar = page.locator('.browser-toolbar');
  await expect(toolbar.locator('[aria-label="Stop"]')).toHaveCount(1, { timeout: 10_000 });
  await expect(toolbar.locator('[aria-label="Refresh"]')).toHaveCount(0);

  // The page eventually renders and the loading presentation is cleared.
  await expect(banner).not.toBeVisible({ timeout: 60_000 });
  await expect(toolbar.locator('[aria-label="Refresh"]')).toHaveCount(1);
  await expect(toolbar.locator('[aria-label="Stop"]')).toHaveCount(0);

  await app.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('Stop mid-load cancels the loading presentation without an error banner', async () => {
  test.setTimeout(120_000);

  const { server, port } = await startSlowServer(2_500);
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(path.join(scratchBase, 'profile-stop-'));
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

  const origin = `http://127.0.0.1:${String(port)}`;
  const serverId = randomUUID();

  const settingsPath = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
  const base = defaultAppSettings();
  const seeded = appSettingsSchema.parse({
    ...base,
    servers: [
      ...base.servers,
      {
        id: serverId,
        label: 'Slow fixture',
        origin,
        color: { kind: 'swatch', swatch: 'blue' },
        revision: 0,
      },
    ],
  });
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(seeded, null, 2), 'utf8');

  const app = await electron.launch({ args: [mainEntry], env });
  const page = await app.firstWindow();
  await page.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 30_000 });

  const addressInput = page.locator('#browser-address-bar input');
  const banner = page.locator('sp-alert-banner.browser-toolbar-message');
  const toolbar = page.locator('.browser-toolbar');

  // First navigation completes fully so the next one is a fresh external load.
  // The AEM pane is a native WebContentsView above the page DOM, so its
  // content isn't reachable from Playwright's `page`; the loading banner
  // closing (isLoading false = content rendered) is that completion signal.
  await addressInput.fill(origin);
  await addressInput.press('Enter');
  await expect(banner).not.toBeVisible({ timeout: 60_000 });
  await expect(toolbar.locator('[aria-label="Refresh"]')).toHaveCount(1);

  // Second navigation: an ongoing slow load shows Loading + Stop; clicking
  // Stop must cancel it cleanly - the banner closes and, being a voluntary
  // user action, no error banner may appear in its place.
  await addressInput.fill(`${origin}/second`);
  await addressInput.press('Enter');
  await expect(banner).toBeVisible({ timeout: 60_000 });
  await expect(banner).toContainText('Loading\u2026');
  await expect(toolbar.locator('[aria-label="Stop"]')).toHaveCount(1, { timeout: 10_000 });

  await toolbar.locator('[aria-label="Stop"]').click();

  await expect(banner).not.toBeVisible({ timeout: 30_000 });
  await expect(toolbar.locator('[aria-label="Refresh"]')).toHaveCount(1);
  // Cancellation is not an error: no humanised error copy, no raw ERR_ text.
  await expect(banner).not.toBeVisible();
  expect(((await banner.textContent().catch(() => null)) ?? '').length).toBe(0);

  await app.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
