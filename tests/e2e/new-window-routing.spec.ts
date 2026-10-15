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
 * New-window requests from the pane's content are split by Chromium's own
 * `disposition`:
 *
 *  - `target="_blank"` links, bare `window.open(url)`, and
 *    `window.open(url, name, 'noopener'|'noreferrer')` - the last is AEM's own
 *    Sites "Edit" shape - are **tabs** and load in the pane's own view, so the
 *    chat pane keeps describing what is on screen and Back rewinds the hop.
 *  - `window.open(url, name, features)` that actually asks for a window
 *    (`width`/`height`/`popup`) gets `new-window` and is left as a real second
 *    window, the SSO/login dialogs whose opener back-channel must survive.
 *
 * The unit suite (`tests/unit/main/browser/windowOpenPolicy.test.ts`,
 * `windowOpenRouter.test.ts`) proves the classification and the wiring with
 * fakes. Only a real built app can prove the things that actually matter and
 * that a fake cannot: `BrowserWindow.getAllWindows()` does not grow for a tab
 * (and does for a popup), and the routed tab navigation is a real history entry
 * that the toolbar's Back control rewinds.
 *
 * The clicks are driven with `executeJavaScript(code, true)`: the `true` is
 * Electron's user-gesture flag, without which Chromium's popup blocker could
 * swallow the request before the app's handler ever saw it.
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'step05-new-window-scratch');

/**
 * A page whose `/` holds a `target="_blank"` link, a bare `window.open` button
 * and a window-featured `window.open` button, each pointing at a distinct
 * destination so the address bar (and the popup's URL) can tell what happened.
 */
function startNewWindowFixtureServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    if (request.url === '/target-blank') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html lang="en"><head><title>Blank target</title></head><body><h1 id="where">blank-target</h1></body></html>',
      );
      return;
    }
    if (request.url === '/target-js') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html lang="en"><head><title>JS target</title></head><body><h1 id="where">js-target</h1></body></html>',
      );
      return;
    }
    if (request.url === '/target-noopener') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html lang="en"><head><title>Noopener target</title></head><body><h1 id="where">noopener-target</h1></body></html>',
      );
      return;
    }
    if (request.url === '/target-popup') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html lang="en"><head><title>Popup target</title></head><body><h1 id="where">popup-target</h1></body></html>',
      );
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><html lang="en"><head><title>Launcher</title></head><body>
<a id="blank-link" href="/target-blank" target="_blank" style="display:inline-block;padding:40px">open in new window</a>
<button id="js-open" style="display:block;margin-top:20px;padding:40px" onclick="window.open('/target-js','daisy-js')">open via js</button>
<button id="js-noopener" style="display:block;margin-top:20px;padding:40px" onclick="window.open('/target-noopener','daisy-noopener','noopener')">open via js with noopener</button>
<button id="js-popup" style="display:block;margin-top:20px;padding:40px" onclick="window.open('/target-popup','daisy-popup','width=420,height=520')">open popup</button>
</body></html>`,
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

test('target=_blank, bare window.open and noopener window.open load in the same view (no second window, rewindable with Back), while a window-featured window.open stays a real popup', async () => {
  test.setTimeout(180_000);

  const { server, port } = await startNewWindowFixtureServer();
  const { home, appData, localAppData } = createScratchDirs(scratchBase);

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
        label: 'New-window fixture',
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
  // Seeded profile: the hosts panel opens at startup and is not dismissible
  // yet. Picking the seeded host is the sanctioned way out and starts the
  // first (toolbar-initiated) load.
  await page.locator(`${byTestId('hosts-item')}[data-origin="${origin}"]`).click();
  await page.locator(byTestId('browser-address')).waitFor({ state: 'visible', timeout: 30_000 });

  const addressInput = page.locator(byTestId('browser-address') + ' input');
  const toolbar = page.locator('.browser-toolbar');

  // The launcher page is loaded and settled.
  await expect(toolbar.locator(byTestId('browser-refresh'))).toHaveCount(1, { timeout: 60_000 });
  await expect(addressInput).toHaveValue(`${origin}/`, { timeout: 10_000 });

  // Locate the AEM view's own webContents - the only surface that may receive
  // the routed navigation. Polled because it can briefly be absent or still
  // report a pre-commit URL while the first load settles.
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

  const windowCount = () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const viewUrl = () =>
    app.evaluate(({ webContents }, id: number) => webContents.fromId(id)?.getURL() ?? '', viewId);
  const clickInView = (id: string) =>
    app.evaluate(
      ({ webContents }, args: { id: number; elementId: string }) => {
        const view = webContents.fromId(args.id);
        if (!view) throw new Error('AEM view no longer exists');
        return view.executeJavaScript(
          `document.getElementById(${JSON.stringify(args.elementId)}).click(); 'clicked'`,
          true,
        );
      },
      { id: viewId, elementId: id },
    );

  expect(await windowCount()).toBe(1);

  // 1. `target="_blank"`: the content must appear in the pane view.
  await clickInView('blank-link');
  await expect(addressInput).toHaveValue(`${origin}/target-blank`, { timeout: 15_000 });
  await expect.poll(viewUrl, { timeout: 15_000 }).toBe(`${origin}/target-blank`);
  // The defining assertion: no second desktop window was created.
  expect(await windowCount()).toBe(1);

  // The routed navigation is a real history entry: Back returns to the
  // launcher, and the pane is still the only window.
  const back = toolbar.locator(byTestId('browser-back'));
  await expect(back).not.toHaveAttribute('disabled', '');
  await back.click();
  await expect(addressInput).toHaveValue(`${origin}/`, { timeout: 15_000 });
  expect(await windowCount()).toBe(1);

  // 2. `window.open(...)`: same routing, same absence of a second window.
  await clickInView('js-open');
  await expect(addressInput).toHaveValue(`${origin}/target-js`, { timeout: 15_000 });
  await expect.poll(viewUrl, { timeout: 15_000 }).toBe(`${origin}/target-js`);
  expect(await windowCount()).toBe(1);

  await expect(back).not.toHaveAttribute('disabled', '');
  await back.click();
  await expect(addressInput).toHaveValue(`${origin}/`, { timeout: 15_000 });
  expect(await windowCount()).toBe(1);

  // 3. `window.open(url, name, 'noopener')` - AEM's Sites "Edit" shape. The
  //    feature token is non-empty, but Chromium classifies it as a tab, so it
  //    must load in place, not in a window.
  await clickInView('js-noopener');
  await expect(addressInput).toHaveValue(`${origin}/target-noopener`, { timeout: 15_000 });
  await expect.poll(viewUrl, { timeout: 15_000 }).toBe(`${origin}/target-noopener`);
  expect(await windowCount()).toBe(1);

  await expect(back).not.toHaveAttribute('disabled', '');
  await back.click();
  await expect(addressInput).toHaveValue(`${origin}/`, { timeout: 15_000 });
  expect(await windowCount()).toBe(1);

  // 4. A real popup (`window.open` with window features) is left alone: a
  //    second window opens at the target, and the pane stays on the launcher
  //    (no navigation, no history entry).
  await clickInView('js-popup');
  await expect.poll(windowCount, { timeout: 15_000 }).toBe(2);
  await expect
    .poll(
      () =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .map((window) => window.webContents.getURL())
              .find((url) => url.includes('/target-popup')) ?? '',
        ),
      { timeout: 15_000 },
    )
    .toBe(`${origin}/target-popup`);
  await expect(addressInput).toHaveValue(`${origin}/`);
  expect(await viewUrl()).toBe(`${origin}/`);

  // Tidy up the popup before closing the app.
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.webContents.getURL().includes('/target-popup')) {
        window.close();
      }
    }
  });

  await app.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
