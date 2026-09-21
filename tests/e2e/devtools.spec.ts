import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';

/**
 * DevTools access, against the built app.
 *
 * The app has no native menu bar (`index.ts` clears the application menu), so
 * `Ctrl+Shift+I` - the default menu's "Toggle Developer Tools" accelerator - is
 * re-created as a menu-less key binding on the relevant `WebContents`
 * (`devTools.ts`). That is main-process wiring a jsdom unit test can only
 * approximate: it can prove the listener and the key predicate, not that a real
 * keystroke reaches them. So the toggle is exercised here with real input.
 *
 * Both halves matter, and they are not the same `WebContents`: the AEM pane is
 * a `WebContentsView`, so its keystrokes land in a *different* `WebContents`
 * from the shell's. The menu accelerator this replaces was window-scoped, so
 * the shortcut must keep toggling the shell's DevTools from either pane - which
 * is exactly what the third phase below asserts.
 *
 * Input is injected from the main process (`WebContents.sendInputEvent`) rather
 * than through Playwright's `page.keyboard`, because a DevTools-protocol key
 * event does not pass through `before-input-event` at all. The AEM view must be
 * showing a loaded page and focused for its injected keys to be delivered,
 * hence the seeded local host and the picker click.
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'devtools-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

test('Ctrl+Shift+I toggles the app shell DevTools from either pane, with no menu bar', async () => {
  test.setTimeout(90_000);

  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>DevTools fixture</title><p>fixture</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server port');
  const origin = `http://127.0.0.1:${String(address.port)}`;

  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(path.join(scratchBase, 'profile-'));
  const home = path.join(root, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });

  const settingsPath = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
  const base = defaultAppSettings();
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify(
      appSettingsSchema.parse({
        ...base,
        hosts: [
          ...base.hosts,
          {
            id: randomUUID(),
            label: 'DevTools fixture',
            origin,
            color: { kind: 'swatch', swatch: 'blue' },
            revision: 0,
          },
        ],
      }),
      null,
      2,
    ),
    'utf8',
  );

  const app = await electron.launch({
    args: [mainEntry],
    env: {
      ...definedEnv(process.env),
      USERPROFILE: home,
      HOME: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
    },
  });

  try {
    const page = await app.firstWindow();
    // A seeded host makes the pane visible and loadable; picking it starts a
    // real load, which is what gives the view's `WebContents` focus later.
    await page.locator(`.hosts-item[data-origin="${origin}"]`).click();
    await page.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 30_000 });

    const shellDevToolsOpened = () =>
      app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.webContents.isDevToolsOpened() ?? false,
      );

    const pressCtrlShiftIOn = (target: 'shell' | 'aem', id = -1) =>
      app.evaluate(
        ({ BrowserWindow, webContents }, args: { target: string; id: number }) => {
          const win = BrowserWindow.getAllWindows()[0];
          win?.focus();
          const contents = args.target === 'shell' ? win?.webContents : webContents.fromId(args.id);
          if (!contents) throw new Error(`no ${args.target} webContents`);
          contents.focus();
          contents.sendInputEvent({
            type: 'keyDown',
            keyCode: 'I',
            modifiers: ['control', 'shift'],
          });
          contents.sendInputEvent({ type: 'keyUp', keyCode: 'I', modifiers: ['control', 'shift'] });
          return contents.isFocused();
        },
        { target, id },
      );

    expect(await shellDevToolsOpened()).toBe(false);
    expect(await pressCtrlShiftIOn('shell')).toBe(true);
    await expect.poll(shellDevToolsOpened, { timeout: 15_000 }).toBe(true);

    // The same key toggles them back off - it is a toggle, not an open.
    await pressCtrlShiftIOn('shell');
    await expect.poll(shellDevToolsOpened, { timeout: 15_000 }).toBe(false);

    // Now from the AEM pane: the keystroke lands in the view's WebContents, but
    // the command still means the *shell's* DevTools (the old menu role).
    let aemViewId = -1;
    for (let attempt = 0; attempt < 40 && aemViewId === -1; attempt += 1) {
      aemViewId = await app.evaluate(({ webContents }, prefix: string) => {
        const view = webContents.getAllWebContents().find((c) => c.getURL().startsWith(prefix));
        return view?.id ?? -1;
      }, origin);
      if (aemViewId === -1) await page.waitForTimeout(500);
    }
    if (aemViewId === -1) throw new Error('AEM view not found');

    expect(await pressCtrlShiftIOn('aem', aemViewId)).toBe(true);
    await expect.poll(shellDevToolsOpened, { timeout: 15_000 }).toBe(true);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
