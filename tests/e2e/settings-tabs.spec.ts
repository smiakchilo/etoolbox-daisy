import { _electron as electron, expect, test } from '@playwright/test';
import path from 'node:path';
import { mainEntry } from '../support/e2e/app';
import { createScratchDirs, scratchEnv } from '../support/e2e/profile';
import { byTestId } from '../support/selectors';

/**
 * Smoke test for the Settings surface's custom elements. jsdom renders
 * `sp-tabs`, `sp-tab`, `sp-tab-panel` and `sp-contextual-help` as inert
 * `HTMLUnknownElement`s, so a unit test would stay green even if their
 * registration imports in `main.ts` were missing - registration, the real
 * shadow root, the tab switch and the help popover are asserted here against
 * the built app.
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'settings-tabs-scratch');

test('Settings tabs and contextual help are registered, switch panels and open', async () => {
  test.setTimeout(120_000);

  const { home, appData, localAppData } = createScratchDirs(scratchBase);

  const env = scratchEnv({ home, appData, localAppData });

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const settings = await app.firstWindow();
    await settings
      .locator(byTestId('browser-address'))
      .waitFor({ state: 'visible', timeout: 60_000 });
    await settings.locator(byTestId('chat-settings')).click();
    await settings
      .locator(byTestId('settings-panel'))
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });

    for (const tag of ['sp-tabs', 'sp-tab', 'sp-tab-panel', 'sp-contextual-help'] as const) {
      expect(await settings.evaluate((name) => customElements.get(name) !== undefined, tag)).toBe(
        true,
      );
    }

    const tabs = settings.locator('.settings-panel__tabs');
    await expect(tabs).toHaveCount(1);
    const tabItems = tabs.locator('sp-tab');
    expect(await tabItems.first().evaluate((node) => node.shadowRoot !== null)).toBe(true);

    // Proxies defines the library entries the Browser tab's default proxy
    // points at, so the definition is listed first.
    const tabValues = await tabItems.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('value')),
    );
    expect(tabValues.indexOf('proxies')).toBe(tabValues.indexOf('browser') - 1);
    expect(
      await tabs
        .locator('.settings-panel__tab-panel')
        .first()
        .evaluate((node) => node.shadowRoot !== null),
    ).toBe(true);

    // Exactly one panel is selected; clicking another tab swaps it.
    const selectedPanel = settings.locator('.settings-panel__tab-panel[selected]');
    await expect(selectedPanel).toHaveCount(1);
    const initialValue = await selectedPanel.first().getAttribute('value');
    await tabItems.nth(3).click();
    await expect(selectedPanel).toHaveCount(1);
    await expect.poll(() => selectedPanel.first().getAttribute('value')).not.toBe(initialValue);

    // The contextual-help badge opens its popover.
    const badge = selectedPanel.locator('sp-contextual-help').first();
    expect(await badge.evaluate((node) => node.shadowRoot !== null)).toBe(true);
    await badge.locator('#trigger').click();
    await expect(badge.locator('#trigger')).toHaveAttribute('aria-expanded', 'true');
    await expect(badge.locator('sp-popover')).toBeVisible();
  } finally {
    await app.close();
  }
});
