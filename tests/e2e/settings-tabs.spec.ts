import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';

/**
 * The Settings surface's sections are organised as Spectrum Tabs
 * (`sp-tabs` / `sp-tab` / `sp-tab-panel`, registered in `main.ts`): one tab
 * per section, Hosts selected by default, exactly one panel visible.
 *
 * Only the real built app can prove this. jsdom renders `sp-tabs`,
 * `sp-tab` and `sp-tab-panel` as inert `HTMLUnknownElement`s, and the
 * panel-show/hide logic lives inside their shadow roots (`display: none`
 * on the unselected panels), so a unit test would stay green even if the
 * registration imports in `main.ts` were missing - custom-element
 * registration and the tab switch are asserted here head-on, exactly like
 * step09-model-selection.spec.ts does for `sp-picker`.
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'settings-tabs-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

test('Settings sections are real tab panels, switching their content', async () => {
  test.setTimeout(120_000);

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

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const settings = await app.firstWindow();
    await settings.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
    await settings.locator('sp-action-button', { hasText: 'Settings' }).first().click();
    await settings
      .locator('.settings-panel')
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });

    // The three tab elements are genuinely registered and upgraded - the
    // assertions jsdom cannot make.
    const tabs = settings.locator('.settings-panel__tabs');
    await expect(tabs).toHaveCount(1);
    for (const tag of ['sp-tabs', 'sp-tab', 'sp-tab-panel'] as const) {
      const registered = await settings.evaluate(
        (tagName) => customElements.get(tagName) !== undefined,
        tag,
      );
      expect(registered).toBe(true);
    }
    const firstTab = tabs.locator('sp-tab').first();
    const firstPanel = tabs.locator('.settings-panel__tab-panel').first();
    await expect(firstTab).toHaveCount(1);
    await expect(firstPanel).toHaveCount(1);
    expect(await firstTab.evaluate((node) => node.shadowRoot !== null)).toBe(true);
    expect(await firstPanel.evaluate((node) => node.shadowRoot !== null)).toBe(true);

    // Every section is one tab, labelled with its former heading. (The
    // certificate-exceptions tab was removed when approval moved into the
    // browser pane's banner - see handoff-steps-09-12.md's deviation note.)
    const labels = ['Hosts', 'Copilot proxy', 'Authentication', 'Models'];
    await expect(tabs.locator('sp-tab')).toHaveCount(labels.length);
    for (const label of labels) {
      await expect(tabs.locator('sp-tab', { hasText: label })).toHaveCount(1);
    }

    // Hosts is selected by default; every other panel is hidden. The panel's
    // node value is `hosts` (not `servers`) - the surface language was renamed
    // even though the underlying data model still calls these servers.
    await expect(settings.locator('section[aria-label="Hosts"]')).toBeVisible();
    const selectedPanel = settings.locator('.settings-panel__tab-panel[selected]');
    await expect(selectedPanel).toHaveCount(1);
    await expect(selectedPanel.first()).toHaveAttribute('value', 'hosts');
    for (const panelValue of ['proxy', 'authentication', 'models']) {
      await expect(
        settings.locator(`.settings-panel__tab-panel[value="${panelValue}"]`),
      ).toBeHidden();
    }

    // Switching tabs swaps the visible content.
    await settings.locator('sp-tab', { hasText: 'Models' }).click();
    await expect(settings.locator('section[aria-label="Models"]')).toBeVisible();
    await expect(settings.locator('section[aria-label="Hosts"]')).toBeHidden();

    await settings.locator('sp-tab', { hasText: 'Authentication' }).click();
    await expect(settings.locator('section[aria-label="Authentication"]')).toBeVisible();
    await expect(settings.locator('sp-button', { hasText: 'Sign in' })).toBeVisible();
    await expect(settings.locator('section[aria-label="Models"]')).toBeHidden();

    await settings.locator('sp-tab', { hasText: 'Hosts' }).click();
    await expect(settings.locator('.multifield__add')).toBeVisible();
  } finally {
    await app.close();
  }
});
