import type { Locator, Page } from '@playwright/test';
import { byTestId } from '../selectors';

/**
 * Opens the Settings panel on its **Browser** tab and returns that tab's panel
 * element, so a spec can click the browser-data actions without re-deriving the
 * panel's internals.
 */
export async function openBrowserSettingsTab(page: Page): Promise<Locator> {
  await page.locator(byTestId('chat-settings')).click();
  await page
    .locator(byTestId('settings-panel'))
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator(byTestId('settings-tab-browser')).click();
  return page.locator('.settings-panel__tab-panel[selected]');
}
