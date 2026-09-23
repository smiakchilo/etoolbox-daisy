import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defaultAppSettings } from '../../src/shared';

/**
 * The browser toolbar's labelless "Open in external browser" control, against
 * the real built app. jsdom cannot prove a custom element is registered - it
 * renders an unknown tag as `HTMLUnknownElement` and a unit test passes against
 * a missing import - so the icon registration is asserted here through
 * `customElements.get` and a real shadow root (AGENTS.md section 9).
 *
 * The control is deliberately never clicked: that would hand the URL to
 * `shell.openExternal` and launch the real default browser on the test
 * machine. The click -> IPC path is covered by the unit suite; this spec proves
 * the control exists, is icon-led, and its enabled state tracks the address
 * field's validity (an absolute http(s) URL).
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'external-button-scratch');

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

test('the open-in-external-browser control is registered, icon-led, and gated on a valid address', async () => {
  test.setTimeout(60_000);

  const { home, env } = launchProfile();
  writeSettings(home, defaultAppSettings());

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    const addressBar = page.locator('#browser-address-bar');
    await addressBar.waitFor({ state: 'visible', timeout: 30_000 });
    const addressInput = addressBar.locator('input').first();

    const button = page.locator('.browser-toolbar [title="Open in external browser"]');
    await expect(button).toBeVisible();
    // Labelless, like the rest of the toolbar buttons: icon only.
    await expect(button).toHaveText('');
    await expect(button.locator('sp-icon-open-in-light')).toHaveCount(1);
    // Nothing valid in the address field yet.
    await expect(button).toBeDisabled();

    // A real custom element registry entry plus a real shadow root is the only
    // proof the register-imports step ran in the built app.
    const upgraded = await button.evaluate(
      (el) =>
        Boolean(customElements.get('sp-icon-open-in-light')) &&
        el.shadowRoot !== null &&
        el.querySelector('sp-icon-open-in-light')?.shadowRoot != null,
    );
    expect(upgraded).toBe(true);

    // Typing a valid absolute http(s) URL enables it (no navigation needed -
    // the `input` event alone re-derives the state).
    await addressInput.fill('https://author.example/content/page.html');
    await expect(button).toBeEnabled();

    // A scheme-less address and a non-http(s) scheme both disable it.
    await addressInput.fill('author.example/content/page.html');
    await expect(button).toBeDisabled();
    await addressInput.fill('javascript:alert(1)');
    await expect(button).toBeDisabled();
  } finally {
    await app.close();
  }
});
