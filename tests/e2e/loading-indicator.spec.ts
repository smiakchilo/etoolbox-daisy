import { _electron as electron, expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import { mainEntry } from '../support/e2e/app';
import { createScratchDirs, scratchEnv } from '../support/e2e/profile';
import { byTestId } from '../support/selectors';

/**
 * Loading indicators for navigations initiated outside the webview (the
 * toolbar's Refresh/Stop trio && the unified "Loading…" banner).
 *
 * The unit suite proves the renderer's state machine (arm on a chrome
 * action, banner shown while `isLoading`, Refresh⇄Stop swap, disarming on
 * did-stop-loading, the 200ms loading-banner debounce) with fake IPC. This
 * spec proves the whole chain against the real built app: a real server
 * that deliberately withholds its response long enough to observe the
 * loading phase, real `did-start-navigation` / `did-stop-loading` states,
 * real custom elements.
 *
 * Two things past failures have shown must be asserted here (AGENTS.md §9,
 * "jsdom cannot prove a custom element is registered"): custom element
 * registration (`customElements.get`) and a real shadow root on the banner.
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'step05-loading-scratch');

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

/**
 * A server whose `/` answers immediately with a page holding a real link to
 * `/next`; `/next` answers only after `nextDelayMs`. The test clicks that link
 * with a genuine input event, so the hop is a real in-webview
 * (page-initiated) navigation - nothing in the toolbar started it - exactly
 * like clicking a link inside AEM.
 */
function startLinkFixtureServer(nextDelayMs: number): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    if (request.url === '/next') {
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(
          '<!doctype html><html lang="en"><head><title>Next page</title></head><body><h1 id="next">next</h1></body></html>',
        );
      }, nextDelayMs);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    // A real, clickable link; the test clicks it with a genuine input event
    // (not a script `.click()`), because Chromium marks script-initiated
    // navigations as skippable client redirects and Back would skip them.
    response.end(
      `<!doctype html><html lang="en"><head><title>First page</title></head><body><a id="go" href="/next" style="display:inline-block;padding:60px">go to next</a></body></html>`,
    );
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
  const { home, appData, localAppData } = createScratchDirs(scratchBase);

  const env = scratchEnv({ home, appData, localAppData });

  // Pre-seed a server whose (configured) origin resolves to the slow fixture.
  const origin = `http://127.0.0.1:${String(port)}`;
  const serverId = randomUUID();

  const settingsPath = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
  const base = defaultAppSettings();
  const seeded = appSettingsSchema.parse({
    ...base,
    hosts: [
      ...base.hosts,
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
  // Seeded profile: the hosts panel opens at startup and is NOT dismissible
  // yet (no page sits under it - see panel.ts `setCloseable`). Picking the
  // seeded host is the sanctioned way out: it closes the panel AND starts the
  // slow external navigation, so the loading-banner assertions land on the
  // visible page-view region.
  await page.locator(`${byTestId('hosts-item')}[data-origin="${origin}"]`).click();
  await page.locator(byTestId('browser-address')).waitFor({ state: 'visible', timeout: 30_000 });

  // The loading banner is an `sp-alert-banner` with a real shadow root
  // (registered, not an unknown element), carrying the loading text and the
  // CSS progress line (the spinner was removed in b9dc6b0 — see below).
  const banner = page.locator('sp-alert-banner.browser-toolbar-message');
  await expect(banner).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() => banner.evaluate(() => Boolean(customElements.get('sp-alert-banner'))))
    .toBe(true);
  await expect.poll(() => banner.evaluate((element) => element.shadowRoot !== null)).toBe(true);
  await expect(banner).toHaveText(/\S/);

  // The loading banner is not dismissible - a load in flight is not something
  // to wave away; only error/prompt rows get a close control.
  await expect(banner).not.toHaveAttribute('dismissible', '');

  // The loading presentation ends in a narrow indeterminate progress line
  // pinned to the banner's top edge: a hand-copied `sp-progress-bar`
  // size="s" sweep (the light-DOM track + animated fill; the shared
  // `.banner-row--loading` presentation in banner.css).
  await expect(banner.locator('.banner-row__progress')).toHaveCount(1);
  const progressStyle = await banner.evaluate((element) => {
    const track = element.querySelector<HTMLElement>('.banner-row__progress');
    const fill = track?.querySelector<HTMLElement>('.banner-row__progress-fill');
    if (!track || !fill) return null;
    const trackCS = getComputedStyle(track);
    const fillCS = getComputedStyle(fill);
    return {
      position: trackCS.position,
      insetBlockStart: trackCS.insetBlockStart,
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
    insetBlockStart: '0px',
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

  // During loading the Refresh button becomes the Stop button.
  const toolbar = page.locator('.browser-toolbar');
  await expect(toolbar.locator(byTestId('browser-stop'))).toHaveCount(1, { timeout: 10_000 });
  await expect(toolbar.locator(byTestId('browser-refresh'))).toHaveCount(0);

  // The page eventually renders and the loading presentation is cleared.
  await expect(banner).not.toBeVisible({ timeout: 60_000 });
  await expect(toolbar.locator(byTestId('browser-refresh'))).toHaveCount(1);
  await expect(toolbar.locator(byTestId('browser-stop'))).toHaveCount(0);

  await app.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('Stop mid-load cancels the loading presentation without an error banner', async () => {
  test.setTimeout(120_000);

  const { server, port } = await startSlowServer(2_500);
  const { home, appData, localAppData } = createScratchDirs(scratchBase, 'profile-stop-');

  const env = scratchEnv({ home, appData, localAppData });

  const origin = `http://127.0.0.1:${String(port)}`;
  const serverId = randomUUID();

  const settingsPath = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
  const base = defaultAppSettings();
  const seeded = appSettingsSchema.parse({
    ...base,
    hosts: [
      ...base.hosts,
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
  // Seeded profile: the hosts panel opens at startup and is NOT dismissible
  // yet (no page sits under it - see panel.ts `setCloseable`). Picking the
  // seeded host is the sanctioned way out: it closes the panel AND starts the
  // first slow external navigation.
  await page.locator(`${byTestId('hosts-item')}[data-origin="${origin}"]`).click();
  await page.locator(byTestId('browser-address')).waitFor({ state: 'visible', timeout: 30_000 });

  const addressInput = page.locator(`${byTestId('browser-address')} input`);
  const banner = page.locator('sp-alert-banner.browser-toolbar-message');
  const toolbar = page.locator('.browser-toolbar');

  // The first navigation (from the picker selection) completes fully so the
  // next one is a fresh external load. The AEM pane is a native
  // WebContentsView above the page DOM, so its content isn't reachable from
  // Playwright's `page`; the loading banner closing (isLoading false =
  // content rendered) is that completion signal.
  await expect(banner).not.toBeVisible({ timeout: 60_000 });
  await expect(toolbar.locator(byTestId('browser-refresh'))).toHaveCount(1);

  // Second navigation: an ongoing slow load shows Loading + Stop; clicking
  // Stop must cancel it cleanly - the banner closes and, being a voluntary
  // user action, no error banner may appear in its place.
  await addressInput.fill(`${origin}/second`);
  await addressInput.press('Enter');
  await expect(banner).toBeVisible({ timeout: 60_000 });
  await expect(banner).toHaveText(/\S/);
  await expect(toolbar.locator(byTestId('browser-stop'))).toHaveCount(1, { timeout: 10_000 });

  await toolbar.locator(byTestId('browser-stop')).click();

  await expect(banner).not.toBeVisible({ timeout: 30_000 });
  await expect(toolbar.locator(byTestId('browser-refresh'))).toHaveCount(1);
  // Cancellation is not an error: no humanised error copy, no raw ERR_ text.
  await expect(banner).not.toBeVisible();
  expect(((await banner.textContent().catch(() => null)) ?? '').length).toBe(0);

  await app.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// A fast external navigation (<200ms) must never show the loading banner:
// the presentation is debounced, so a load that finishes inside the window
// moves no layout at all. Unit tests prove the timing deterministically with
// fake timers; this proves the real IPC chain also finishes within the
// window for a quick localhost answer.
test('a navigation that finishes inside the 200ms debounce window shows no loading banner', async () => {
  test.setTimeout(120_000);

  const { server, port } = await startSlowServer(100);
  const { home, appData, localAppData } = createScratchDirs(scratchBase, 'profile-fast-');

  const env = scratchEnv({ home, appData, localAppData });

  const origin = `http://127.0.0.1:${String(port)}`;
  const serverId = randomUUID();

  const settingsPath = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
  const base = defaultAppSettings();
  const seeded = appSettingsSchema.parse({
    ...base,
    hosts: [
      ...base.hosts,
      {
        id: serverId,
        label: 'Fast fixture',
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
  // Seeded profile: the hosts panel opens at startup and is NOT dismissible
  // yet (no page sits under it - see panel.ts `setCloseable`). Picking the
  // seeded host is the sanctioned way out: it closes the panel AND starts the
  // fast navigation (~100ms, inside the 200ms debounce).
  await page.locator(`${byTestId('hosts-item')}[data-origin="${origin}"]`).click();
  await page.locator(byTestId('browser-address')).waitFor({ state: 'visible', timeout: 30_000 });

  const banner = page.locator('sp-alert-banner.browser-toolbar-message');
  const toolbar = page.locator('.browser-toolbar');

  // Sample across the whole first-load duration plus the debounce window: the
  // banner must never appear (it would move layout). The Refresh→Stop swap is
  // deliberately immediate now, independent of the banner debounce, so Stop
  // showing is expected and is no longer a proxy for "the banner showed".
  await expect
    .poll(async () => banner.isVisible().catch(() => false), {
      intervals: [100, 100, 100, 100, 100, 100],
      timeout: 2000,
    })
    .toBe(false);
  // The load completed: Refresh restored, still no banner.
  await expect(toolbar.locator(byTestId('browser-refresh'))).toHaveCount(1);
  await expect(banner).not.toBeVisible();
  await expect(toolbar.locator(byTestId('browser-stop'))).toHaveCount(0);

  await app.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// An in-webview navigation (a real click on a link inside the page, exactly
// like clicking a link or button inside AEM) must drive the same controls as a
// toolbar-initiated one: the address bar shows the destination as the load
// starts, Refresh becomes Stop, and the Loading banner appears. Before this,
// only toolbar-initiated loads did any of that. The click also proves the hop
// is a real history entry, so the Back control becomes usable.
test('a page-initiated navigation drives the same address, Stop, Loading and Back controls', async () => {
  test.setTimeout(120_000);

  const { server, port } = await startLinkFixtureServer(3_000);
  const { home, appData, localAppData } = createScratchDirs(scratchBase, 'profile-inpage-');

  const env = scratchEnv({ home, appData, localAppData });

  const origin = `http://127.0.0.1:${String(port)}`;
  const serverId = randomUUID();

  const settingsPath = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
  const base = defaultAppSettings();
  const seeded = appSettingsSchema.parse({
    ...base,
    hosts: [
      ...base.hosts,
      {
        id: serverId,
        label: 'Self-navigating fixture',
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
  // Seeded profile: the hosts panel opens at startup and is NOT dismissible
  // yet (no page sits under it). Picking the seeded host is the sanctioned way
  // out: it closes the panel AND starts the first (toolbar-initiated) load.
  await page.locator(`${byTestId('hosts-item')}[data-origin="${origin}"]`).click();
  await page.locator(byTestId('browser-address')).waitFor({ state: 'visible', timeout: 30_000 });

  const addressInput = page.locator(`${byTestId('browser-address')} input`);
  const banner = page.locator('sp-alert-banner.browser-toolbar-message');
  const toolbar = page.locator('.browser-toolbar');

  // The first, toolbar-initiated load completes and the address bar holds its
  // URL before the page navigates itself away.
  await expect(toolbar.locator(byTestId('browser-refresh'))).toHaveCount(1, { timeout: 60_000 });
  await expect(addressInput).toHaveValue(`${origin}/`, { timeout: 10_000 });

  // Click the in-page link with a genuine user-gesture input event (script
  // `.click()` and `location.href` produce skippable client redirects that a
  // real browser's Back would skip too - not what a human click does). The view
  // is looked up by polling: its webContents can be briefly absent or still
  // report a pre-commit URL while the first navigation settles.
  let viewId = -1;
  for (let attempt = 0; attempt < 40 && viewId === -1; attempt += 1) {
    viewId = await app.evaluate(({ webContents }, prefix: string) => {
      const view = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith(prefix));
      return view?.id ?? -1;
    }, origin);
    if (viewId === -1) await page.waitForTimeout(500);
  }
  if (viewId === -1) throw new Error('AEM view not found');
  await app.evaluate(({ webContents }, id: number) => {
    const view = webContents.fromId(id);
    if (!view) throw new Error('AEM view no longer exists');
    view.focus();
    const point = { x: 30, y: 30 };
    view.sendInputEvent({
      type: 'mouseDown',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
    view.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }, viewId);

  // Nothing in the toolbar started that navigation, yet: the address bar shows
  // the destination as the load starts...
  await expect(addressInput).toHaveValue(`${origin}/next`, { timeout: 15_000 });
  // ...Refresh becomes Stop...
  await expect(toolbar.locator(byTestId('browser-stop'))).toHaveCount(1, { timeout: 10_000 });
  // ...and the Loading banner appears.
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toHaveText(/\S/);

  // The slow destination eventually renders and everything restores.
  await expect(banner).not.toBeVisible({ timeout: 60_000 });
  await expect(toolbar.locator(byTestId('browser-refresh'))).toHaveCount(1);
  await expect(toolbar.locator(byTestId('browser-stop'))).toHaveCount(0);
  await expect(addressInput).toHaveValue(`${origin}/next`);

  // The user-gesture click is a real history entry: Back is enabled, and
  // clicking it returns to the first page.
  const back = toolbar.locator(byTestId('browser-back'));
  await expect(back).not.toHaveAttribute('disabled', '');
  await back.click();
  await expect(addressInput).toHaveValue(`${origin}/`, { timeout: 15_000 });

  await app.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
