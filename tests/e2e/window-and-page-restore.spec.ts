import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';

/**
 * Two pieces of per-run state remembered across a full quit and relaunch,
 * exercised against the real built app:
 *
 *  - the main window's size and maximized-ness, owned by the main process
 *    (`src/main/windowState.ts`); and
 *  - the AEM pane's last opened page, owned by the renderer
 *    (`src/renderer/src/lib/lastPageStore.ts`) and replayed at startup.
 *
 * Neither is provable in jsdom: `localStorage` persistence and native window
 * geometry only exist across two real Electron processes sharing one profile,
 * which is exactly what these tests launch.
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'startup-state-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** A profile directory both launches share - localStorage/window state live under it. */
function createProfile(): Record<string, string> {
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(path.join(scratchBase, 'profile-'));
  const home = path.join(root, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  return {
    ...definedEnv(process.env),
    USERPROFILE: home,
    HOME: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
  };
}

function windowStatePath(env: Record<string, string>): string {
  return path.join(env['USERPROFILE'] ?? '', 'etoolbox-daisy', 'window-state.json');
}

function readWindowStateFile(env: Record<string, string>): {
  width: number;
  height: number;
  maximized: boolean;
} {
  return JSON.parse(readFileSync(windowStatePath(env), 'utf8')) as {
    width: number;
    height: number;
    maximized: boolean;
  };
}

function writeSettings(home: string, settings: unknown): void {
  const settingsPath = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

/** The main window's stored geometry, read from inside the main process. */
function readGeometryWindow(app: ElectronApplication): Promise<
  | {
      readonly width: number;
      readonly height: number;
      readonly maximized: boolean;
    }
  | undefined
> {
  return app.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows();
    if (window === undefined) return undefined;
    const bounds = window.getNormalBounds();
    return { width: bounds.width, height: bounds.height, maximized: window.isMaximized() };
  });
}

test.describe('startup state', () => {
  test('restores the main window size and maximized-ness across a relaunch', async () => {
    test.setTimeout(180_000);
    const env = createProfile();

    // --- first run: size the window, then maximize it ------------------------
    const first = await electron.launch({ args: [mainEntry], env });
    await first.firstWindow();
    await first.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(900, 650);
    });
    // Let the debounced save land before maximizing, so the normal bounds are
    // unambiguously the size set above.
    await new Promise((resolve) => setTimeout(resolve, 800));
    await first.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.maximize();
    });
    await first.close();

    const stored = readWindowStateFile(env);
    expect(Math.abs(stored.width - 900)).toBeLessThanOrEqual(2);
    expect(Math.abs(stored.height - 650)).toBeLessThanOrEqual(2);
    expect(stored.maximized).toBe(true);

    // --- second run: both facts are restored ---------------------------------
    const second = await electron.launch({ args: [mainEntry], env });
    await second.firstWindow();
    const restored = await readGeometryWindow(second);
    expect(restored).toBeDefined();
    expect(Math.abs((restored as { width: number }).width - 900)).toBeLessThanOrEqual(2);
    expect(Math.abs((restored as { height: number }).height - 650)).toBeLessThanOrEqual(2);
    expect((restored as { maximized: boolean }).maximized).toBe(true);
    await second.close();
  });

  test('reopens the last AEM page instead of the hosts picker after a relaunch', async () => {
    test.setTimeout(180_000);
    const env = createProfile();

    const state = { hits: 0 };
    const server: Server = createServer((_req, res) => {
      state.hits += 1;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>echo</title><p>ok</p>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const base = defaultAppSettings();
    writeSettings(
      env['USERPROFILE'] ?? '',
      appSettingsSchema.parse({
        ...base,
        hosts: [
          ...base.hosts,
          {
            id: randomUUID(),
            label: 'Echo',
            origin,
            color: { kind: 'swatch', swatch: 'blue' },
            revision: 0,
          },
        ],
      }),
    );

    // --- first run: pick the seeded host, which loads and is remembered ------
    const first = await electron.launch({ args: [mainEntry], env });
    const firstPage = await first.firstWindow();
    await firstPage.locator(`.hosts-item[data-origin="${origin}"]`).click();
    await expect.poll(() => state.hits > 0, { timeout: 30_000 }).toBe(true);
    // Wait until the address bar reflects the load: the same state push the
    // last-page subscription consumes, so the URL is guaranteed remembered.
    await expect
      .poll(
        () =>
          firstPage
            .locator('#browser-address-bar')
            .evaluate((element) => (element as unknown as { value: string }).value),
        { timeout: 30_000 },
      )
      .toContain(origin);
    await first.close();

    // --- second run: the page reopens without the startup hosts picker -------
    const second = await electron.launch({ args: [mainEntry], env });
    const secondPage = await second.firstWindow();
    await expect.poll(() => state.hits > 1, { timeout: 30_000 }).toBe(true);

    const restoredAddress = await secondPage
      .locator('#browser-address-bar')
      .evaluate((element) => (element as unknown as { value: string }).value);
    expect(restoredAddress).toContain(origin);
    // The picker is the "no page remembered" affordance; a restore must not
    // also open it over the page the user left.
    await expect(secondPage.locator(`.hosts-item[data-origin="${origin}"]`)).not.toBeVisible();

    await second.close();
    server.close();
  });
});
