import { _electron as electron, expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';

/**
 * Regression test for the Settings panel's dismissal bug: loading a URL from
 * the hosts panel, opening Settings, and closing it via the panel's own
 * cross button left the browser pane with a stale active-panel reference and
 * a permanently suspended native view - the page vanished, and the next
 * Settings click did nothing because `openPanel` short-circuited on the still-
 * armed panel (`browserPane.ts` `if (activePanel === panel) return`).
 *
 * The Settings panel's `onDismiss` used to be a no-op, while the hosts
 * panel's forwards dismissal into the pane's panel host - the asymmetry was
 * the bug. Only the real built app can prove the native view is actually
 * collapsed while the panel is open and *restored* on close, so this spec
 * reads the real `WebContentsView` child bounds through `app.evaluate`
 * exactly like step05-view-bounds.spec.ts.
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'settings-panel-close-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
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

test('closing Settings with its close button restores the AEM view and Settings can open again', async () => {
  test.setTimeout(120_000);

  // A real URL to load from the picker, so the native view carries a page.
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
          origin,
          color: { kind: 'swatch', swatch: 'blue' },
          revision: 0,
        },
      ],
    }),
  );

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    // A seeded profile means the hosts panel is already open at startup. The
    // panel cannot be dismissed yet (no page sits under it — the close button
    // and Escape are inert), so we pick the echo host directly: it loads the
    // page and closes the panel in one step.
    const pickerItem = page.locator(`.hosts-item[data-origin="${origin}"]`);
    await pickerItem.waitFor({ state: 'visible', timeout: 10_000 });
    await pickerItem.click();
    await expect.poll(() => state.hits > 0, { timeout: 30_000 }).toBe(true);
    const viewHost = page.locator('[data-testid="browser-view-host"]');
    await viewHost.waitFor({ state: 'visible', timeout: 30_000 });

    const readNativeBounds = (): Promise<
      { x: number; y: number; width: number; height: number }[]
    > =>
      app.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows();
        if (window === undefined) return [];
        return window.contentView.children.map((child) => child.getBounds());
      });

    const reservedOf = async (): Promise<{ width: number; height: number } | null> =>
      await viewHost
        .boundingBox()
        .then((box) => (box === null ? null : { width: box.width, height: box.height }));

    /**
     * Polls the real native view until it reaches `state`. `collapsed` means
     * the pane collapsed the view to a zero-sized rectangle while a panel is
     * open (the reserved host is itself hidden then, so only the native bounds
     * can prove it); `full` means a child matches the rendered reserved region.
     */
    const waitForNativeView = async (state: 'full' | 'collapsed'): Promise<boolean> => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const native = await readNativeBounds();
        if (state === 'collapsed') {
          if (native.some((bounds) => bounds.width === 0 && bounds.height === 0)) return true;
        } else {
          const reserved = await reservedOf();
          const matched = native.some(
            (bounds) =>
              reserved !== null &&
              Math.abs(bounds.width - reserved.width) <= 1 &&
              Math.abs(bounds.height - reserved.height) <= 1,
          );
          if (matched) return true;
        }
        await page.waitForTimeout(250);
      }
      return false;
    };

    // The native view is full-size after the startup navigation.
    expect(await waitForNativeView('full')).toBe(true);

    // --- Step 2: open Settings ---------------------------------------------
    await page.locator('sp-action-button[title="Settings"]').first().click();
    const settingsPanel = page.locator('.settings-panel');
    await settingsPanel.waitFor({ state: 'visible', timeout: 30_000 });
    // The panel covers the page-view region: the native view is collapsed.
    expect(await waitForNativeView('collapsed')).toBe(true);

    // --- Step 3: close Settings with its own close button ------------------
    await page.locator('.settings-panel__close').click();
    await expect(settingsPanel).toBeHidden();
    // The native view must come back - this was the regression.
    expect(await waitForNativeView('full')).toBe(true);

    // --- Step 4: Settings can be opened again and suspends the view again --
    await page.locator('sp-action-button[title="Settings"]').first().click();
    await settingsPanel.waitFor({ state: 'visible', timeout: 30_000 });
    expect(await waitForNativeView('collapsed')).toBe(true);

    // And Escaping out of the reopened panel restores the view just the same.
    await page.keyboard.press('Escape');
    await expect(settingsPanel).toBeHidden();
    expect(await waitForNativeView('full')).toBe(true);
  } finally {
    await app.close();
    server.close();
  }
});

/**
 * A Settings save's acknowledgement must outlive the panel. The status row is
 * owned by the browser pane (`browserPane.surfaceStatus`), not by the panel,
 * so committing a field and immediately closing the panel still leaves
 * "Settings saved" on screen - and a save *error* would be visible rather than
 * hidden with the panel. Only the real built app proves the row is a sibling
 * of the panel rather than a child that vanishes with it.
 */
test('save feedback survives closing the Settings panel', async () => {
  test.setTimeout(120_000);

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
          origin,
          color: { kind: 'swatch', swatch: 'blue' },
          revision: 0,
        },
      ],
    }),
  );

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    const pickerItem = page.locator(`.hosts-item[data-origin="${origin}"]`);
    await pickerItem.waitFor({ state: 'visible', timeout: 10_000 });
    await pickerItem.click();
    await expect.poll(() => state.hits > 0, { timeout: 30_000 }).toBe(true);

    await page.locator('sp-action-button[title="Settings"]').first().click();
    const settingsPanel = page.locator('.settings-panel');
    await settingsPanel.waitFor({ state: 'visible', timeout: 30_000 });

    // Commit a label edit (leaving the field), then close the panel straight
    // away - the save is still settling.
    const label = page.locator(
      'section[aria-label="Hosts"] sp-textfield[aria-label="Label"] input',
    );
    await label.fill('Echo renamed');
    await label.press('Enter');
    await page.locator('.settings-panel__close').click();
    await expect(settingsPanel).toBeHidden();

    // The acknowledgement is still on screen, in the pane's row - never inside
    // the dismissed panel.
    const banner = page.locator('.surface-status-banner');
    await expect(banner).toHaveText('Settings saved', { timeout: 30_000 });
    await expect(banner).toBeVisible();
    expect(await banner.evaluate((el) => el.closest('.settings-panel') === null)).toBe(true);
  } finally {
    await app.close();
    server.close();
  }
});
