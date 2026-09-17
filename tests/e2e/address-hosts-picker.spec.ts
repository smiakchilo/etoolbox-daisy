import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';

/**
 * The address bar is a plain `sp-textfield` with an `sp-picker-button`
 * (`#hosts-button`) coupled to its right edge. Clicking the button
 * suspends the native `WebContentsView`, hides the reserved
 * `#browser-view-host` region, and reveals a whole-size hosts list panel
 * (`.hosts-panel`) in its place - instead of a dropdown trying to
 * float above the always-composited-above native view. Picking a host (click
 * or Enter on a `.hosts-item` row, or the header's cross close button)
 * restores the view and, for a selection, fills the address bar with that
 * host's origin and navigates to it - the exact same `navigate()` path a
 * typed address goes through. With zero configured hosts the button stays
 * visible but disabled and the panel never opens.
 *
 * This is exercised against the real built app/real Spectrum control rather
 * than jsdom: the whole point is the interaction between real DOM layout, the
 * hidden/suspended native view, and a real custom element.
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'address-picker-scratch');

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
    res.end(`<!doctype html><title>echo</title><p>ok</p>`);
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

/**
 * The `open` attribute must *paint* pressed, not just tag the element: the
 * non-quiet `sp-picker-button` paints its resting fill on `.spectrum-PickerButton-fill`
 * (`.root` itself stays `background-color: initial`) inside the shadow root,
 * and the fill flips to the darker "down" variant under `:host([open]) .root`.
 * Playwright parks the pointer away first so `:hover` contributes nothing,
 * then reads the actual computed background of the fill element.
 */
async function pickerPressedBackground(page: Page): Promise<string | null> {
  await page.mouse.move(2, 2);
  return page.evaluate(() => {
    const el = document.getElementById('hosts-button');
    const fill = el?.shadowRoot?.querySelector('.spectrum-PickerButton-fill') ?? null;
    return fill ? getComputedStyle(fill).backgroundColor : null;
  });
}

test("picking a host from the address bar's hosts panel navigates to it", async () => {
  test.setTimeout(120_000);

  const serverA = await startEchoOrigin();
  const serverB = await startEchoOrigin();
  const { home, env } = launchProfile();

  const base = defaultAppSettings();
  const seeded = appSettingsSchema.parse({
    ...base,
    servers: [
      ...base.servers,
      {
        id: randomUUID(),
        label: 'Server A',
        origin: serverA.origin,
        color: { kind: 'swatch', swatch: 'blue' },
        revision: 0,
      },
      {
        id: randomUUID(),
        label: 'Server B',
        origin: serverB.origin,
        color: { kind: 'swatch', swatch: 'green' },
        revision: 0,
      },
    ],
  });
  writeSettings(home, seeded);

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    const addressBar = page.locator('#browser-address-bar');
    await addressBar.waitFor({ state: 'visible', timeout: 30_000 });
    const addressInput = addressBar.locator('input').first();
    const pickerButton = page.locator('#hosts-button');
    const panel = page.locator('.hosts-panel');
    const viewHost = page.locator('[data-testid="browser-view-host"]');
    await expect(pickerButton).toBeVisible({ timeout: 10_000 });

    // A seeded profile means the hosts panel is already open at startup.
    // Because no page sits under it yet, the panel is not closeable: its
    // cross button is disabled, Escape is inert, and the picker button's
    // toggle does nothing. Selecting a host is the sanctioned way to leave
    // it (it closes the panel AND loads a page in one step).
    const itemA = page.locator(`.hosts-item[data-origin="${serverA.origin}"]`);
    const itemB = page.locator(`.hosts-item[data-origin="${serverB.origin}"]`);
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(itemA).toBeVisible({ timeout: 10_000 });
    await expect(itemB).toBeVisible({ timeout: 10_000 });
    await expect(viewHost).toBeHidden();
    await expect(pickerButton).toHaveAttribute('open', '');

    // Pick Server A directly from the startup panel. The panel closes and
    // navigates in one step: the page-view region is never left bare.
    await itemA.click();
    await expect
      .poll(async () => await addressInput.inputValue())
      .toMatch(new RegExp(`^${serverA.origin}/?$`));
    await expect.poll(() => serverA.hits > 0, { timeout: 30_000 }).toBe(true);
    await expect(panel).toBeHidden();
    await expect(viewHost).toBeVisible();
    await expect(pickerButton).not.toHaveAttribute('open', '');
    // A real custom element registry entry is the only proof the
    // register-imports step ran - see AGENTS.md's "jsdom cannot prove a custom
    // element is registered" rule.
    const registered = await page.evaluate(() => ({
      pickerButton: Boolean(customElements.get('sp-picker-button')),
      closeIcon: Boolean(customElements.get('daisy-close-icon')),
    }));
    expect(registered.pickerButton).toBe(true);
    expect(registered.closeIcon).toBe(true);
    const baselineA = serverA.hits;

    // The page has loaded, so the panel is now closeable. Clicking the picker
    // button opens the panel: the native view region disappears underneath it
    // and the button shows its pressed/open state - both the `open` attribute
    // AND the painted "down" background it triggers.
    const restingBackground = await pickerPressedBackground(page);
    expect(restingBackground).not.toBeNull();
    await pickerButton.click();
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(viewHost).toBeHidden();
    await expect(pickerButton).toHaveAttribute('open', '');
    await page.waitForTimeout(300);
    const pressedBackground = await pickerPressedBackground(page);
    expect(pressedBackground).not.toBe(restingBackground);

    // Deciding to back out: the header's cross button closes the panel and
    // restores the native view region without navigating anywhere.
    await page.locator('.hosts-panel__close').click();
    await expect(panel).toBeHidden();
    await expect(viewHost).toBeVisible();
    await expect(pickerButton).not.toHaveAttribute('open', '');
    expect(serverA.hits).toBe(baselineA);
    expect(serverB.hits).toBe(0);

    // Re-open and actually pick Server B.
    await pickerButton.click();
    await expect(itemB).toBeVisible({ timeout: 10_000 });
    await itemB.click();

    // Selecting fills the address bar and navigates. The final address-bar
    // text comes from the real post-navigation URL (which can add a trailing
    // "/"), not literally the item's string.
    await expect
      .poll(async () => await addressInput.inputValue())
      .toMatch(new RegExp(`^${serverB.origin}/?$`));
    await expect.poll(() => serverB.hits > 0, { timeout: 30_000 }).toBe(true);
    expect(serverA.hits).toBe(baselineA);

    // The panel closed again, the native view region is back, and the button
    // has released its pressed state back to the resting background.
    await expect(panel).toBeHidden();
    await expect(viewHost).toBeVisible();
    await expect(pickerButton).not.toHaveAttribute('open', '');
    await page.waitForTimeout(300);
    expect(await pickerPressedBackground(page)).toBe(restingBackground);

    const message = page.locator('.browser-toolbar-message');
    await expect(message).toBeHidden();
    expect((await message.textContent()) ?? '').toBe('');

    // Opening the picker again and picking the other server works too - not
    // a one-shot affordance.
    await pickerButton.click();
    await expect(itemA).toBeVisible({ timeout: 10_000 });
    await itemA.click();
    await expect.poll(() => serverA.hits > baselineA, { timeout: 30_000 }).toBe(true);

    // Typing directly into the field still works too - the same field, not
    // a separate mode.
    await addressInput.fill(serverB.origin);
    await addressInput.press('Enter');
    await expect.poll(() => serverB.hits > 1, { timeout: 30_000 }).toBe(true);
  } finally {
    await app.close();
    serverA.close();
    serverB.close();
  }
});

test("with no configured hosts, the address bar's hosts button stays visible but disabled", async () => {
  test.setTimeout(60_000);

  const { home, env } = launchProfile();
  writeSettings(home, defaultAppSettings());

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    const addressBar = page.locator('#browser-address-bar');
    await addressBar.waitFor({ state: 'visible', timeout: 30_000 });
    const addressInput = addressBar.locator('input').first();
    const pickerButton = page.locator('#hosts-button');

    // The button is still present (never hidden) but disabled, and clicking
    // it must never surface the panel when there is nothing to pick from.
    await expect(pickerButton).toBeVisible();
    await expect(pickerButton).toBeDisabled();
    await addressInput.click();
    await pickerButton.click({ force: true });
    await page.waitForTimeout(500);
    await expect(page.locator('.hosts-panel')).toBeHidden();
    await expect(addressInput).toBeEnabled();
  } finally {
    await app.close();
  }
});
