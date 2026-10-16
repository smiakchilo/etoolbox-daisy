import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';
import { launchApp, type ElectronApp } from '../support/e2e/app';
import { createScratchDirs, writeSettings } from '../support/e2e/profile';
import { byTestId } from '../support/selectors';

/**
 * Application-wide keyboard shortcuts, against the built app.
 *
 * The app has no menu bar (`index.ts` clears the application menu), so a
 * shortcut is matched in main via `before-input-event` on *both* `WebContents`
 * - the shell's and the AEM view's (`src/main/shortcuts.ts`). That is
 * main-process wiring a jsdom unit test can only approximate: it can prove the
 * key map and the routing decision, not that a real keystroke reaches them, nor
 * that a keystroke landing in the AEM pane's separate `WebContents` still
 * reaches the shell's handlers.
 *
 * Input is injected from main (`WebContents.sendInputEvent`) rather than through
 * Playwright's `page.keyboard`, because a DevTools-protocol key event does not
 * pass through `before-input-event` at all (see `devtools.spec.ts`). The AEM
 * view must be showing a loaded page and focused for its injected keys to be
 * delivered, hence the seeded host and the picker click.
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'shortcuts-scratch');

interface Fixture {
  readonly app: ElectronApp;
  readonly page: Page;
  readonly origin: string;
}

async function startFixture(): Promise<{ server: Server; origin: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    requests.push(url);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${url}</title><p id="marker">${url}</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server port');
  return { server, origin: `http://127.0.0.1:${String(address.port)}`, requests };
}

async function seedAndLaunch(origin: string): Promise<Fixture> {
  const dirs = createScratchDirs(scratchBase);
  const base = defaultAppSettings();
  writeSettings(
    dirs.home,
    appSettingsSchema.parse({
      ...base,
      hosts: [
        ...base.hosts,
        {
          id: randomUUID(),
          label: 'Shortcut fixture',
          origin,
          color: { kind: 'swatch', swatch: 'blue' },
          revision: 0,
        },
      ],
    }),
  );

  const app = await launchApp(dirs, { fakeAgent: true });
  const page = await app.firstWindow();
  // A seeded host makes the pane loadable; picking it starts the real load that
  // gives the view's WebContents focus later.
  await page.locator(`${byTestId('hosts-item')}[data-origin="${origin}"]`).click();
  await expect(page.locator(byTestId('browser-address'))).toBeVisible({ timeout: 30_000 });
  return { app, page, origin };
}

/** The AEM view's WebContents id, found by its committed origin. */
async function findAemViewId(app: ElectronApp, origin: string): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const id = await app.evaluate(({ webContents }, prefix: string) => {
      return webContents.getAllWebContents().find((c) => c.getURL().startsWith(prefix))?.id ?? -1;
    }, origin);
    if (id !== -1) return id;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('AEM view not found');
}

/** The AEM view's own `isLoading()` flag, read from main. */
function viewIsLoading(app: ElectronApp, aemViewId: number): Promise<boolean> {
  return app.evaluate(
    ({ webContents }, id: number) => webContents.fromId(id)?.isLoading() ?? false,
    aemViewId,
  );
}

/**
 * Waits until the AEM view has finished loading. The address bar updates on
 * `did-start-navigation`, i.e. *before* the load settles, so a navigation key
 * pressed right after an address assertion can otherwise land mid-load.
 */
async function waitForViewIdle(app: ElectronApp, aemViewId: number): Promise<void> {
  await expect.poll(() => viewIsLoading(app, aemViewId), { timeout: 30_000 }).toBe(false);
}

/**
 * Injects one keystroke into `target`'s `WebContents` from main, as the real
 * input pipeline would, and returns whether that WebContents took focus.
 */
function pressOn(
  app: ElectronApp,
  target: 'shell' | 'aem',
  aemViewId: number,
  keyCode: string,
  modifiers: ('control' | 'alt' | 'shift' | 'meta')[],
): Promise<boolean> {
  return app.evaluate(
    (
      { BrowserWindow, webContents },
      args: {
        target: string;
        id: number;
        keyCode: string;
        modifiers: ('control' | 'alt' | 'shift' | 'meta')[];
      },
    ) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.focus();
      const contents = args.target === 'shell' ? win?.webContents : webContents.fromId(args.id);
      if (!contents) throw new Error(`no ${args.target} webContents`);
      contents.focus();
      contents.sendInputEvent({
        type: 'keyDown',
        keyCode: args.keyCode,
        modifiers: args.modifiers,
      });
      contents.sendInputEvent({ type: 'keyUp', keyCode: args.keyCode, modifiers: args.modifiers });
      return contents.isFocused();
    },
    { target, id: aemViewId, keyCode, modifiers },
  );
}

test('application shortcuts work from both panes', async () => {
  test.setTimeout(120_000);

  const { server, origin, requests } = await startFixture();
  const fixture = await seedAndLaunch(origin);
  const { app, page } = fixture;
  const addressInput = page.locator(`${byTestId('browser-address')} input`);
  // Picking the host navigates to the bare origin, which the browser normalizes
  // to a trailing-slash root URL.
  const rootUrl = `${origin}/`;

  try {
    const aemViewId = await findAemViewId(app, origin);
    await expect
      .poll(async () => await addressInput.inputValue(), { timeout: 30_000 })
      .toBe(rootUrl);
    await waitForViewIdle(app, aemViewId);

    // ── F5 on the AEM pane refreshes it ────────────────────────────────────
    const beforeRefresh = requests.filter((url) => url === '/').length;
    expect(await pressOn(app, 'aem', aemViewId, 'F5', [])).toBe(true);
    await expect
      .poll(() => requests.filter((url) => url === '/').length, { timeout: 30_000 })
      .toBeGreaterThan(beforeRefresh);
    await waitForViewIdle(app, aemViewId);

    // ── Alt+Left on the AEM pane goes Back ─────────────────────────────────
    await addressInput.fill(`${origin}/other.html`);
    await addressInput.press('Enter');
    await expect
      .poll(async () => await addressInput.inputValue(), { timeout: 30_000 })
      .toBe(`${origin}/other.html`);
    await waitForViewIdle(app, aemViewId);

    expect(await pressOn(app, 'aem', aemViewId, 'Left', ['alt'])).toBe(true);
    await expect
      .poll(async () => await addressInput.inputValue(), { timeout: 30_000 })
      .toBe(rootUrl);

    // ── Ctrl+H on the shell opens History ──────────────────────────────────
    await pressOn(app, 'shell', aemViewId, 'H', ['control']);
    await expect(page.locator(byTestId('history-panel'))).toBeVisible({ timeout: 15_000 });
    await page.locator(byTestId('history-panel-close')).click();
    await expect(page.locator(byTestId('history-panel'))).toBeHidden();

    // ── Ctrl+, on the shell opens Settings ─────────────────────────────────
    await pressOn(app, 'shell', aemViewId, ',', ['control']);
    await expect(page.locator(byTestId('settings-panel'))).toBeVisible({ timeout: 15_000 });
    await page.locator(byTestId('settings-panel-close')).click();
    await expect(page.locator(byTestId('settings-panel'))).toBeHidden();

    // ── Ctrl+L focuses the address bar, from the AEM pane ──────────────────
    await pressOn(app, 'aem', aemViewId, 'L', ['control']);
    await expect(addressInput).toBeFocused({ timeout: 15_000 });
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
