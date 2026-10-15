import { _electron as electron, expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mainEntry } from '../support/e2e/app';
import { createScratchDirs, scratchEnv } from '../support/e2e/profile';
import { byField, byTestId } from '../support/selectors';

/**
 * The Hosts multifield's "Proxy" combobox: it offers "(Default)" (inherit
 * `browser.proxy`), "(No proxy)" (an explicit direct connection, stored as the
 * `"none"` sentinel), and one option per proxy-library entry by label. It
 * stores the chosen entry's id on the host, and a host whose entry is removed
 * falls back to "(Default)".
 *
 * Only the real built app can prove the whole loop (Proxies tab -> Hosts
 * combobox -> `settings:update-server-targeting` -> settings.json, and the
 * `removeProxy` reference-clearing). The unit suite covers the pieces.
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'host-proxy-scratch');

interface SettingsDoc {
  hosts?: { origin?: string; proxyId?: string }[];
  proxies?: { id?: string }[];
  browser?: { proxy?: string };
}

test('a host uses a library proxy, and removing it clears the reference', async () => {
  test.setTimeout(180_000);

  const { home, appData, localAppData } = createScratchDirs(scratchBase);

  const env = scratchEnv({ home, appData, localAppData });
  const settingsFile = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');

  const readDoc = (): SettingsDoc => {
    try {
      return JSON.parse(readFileSync(settingsFile, 'utf8')) as SettingsDoc;
    } catch {
      return {};
    }
  };
  const proxyIdOnDisk = (): string | undefined => readDoc().proxies?.[0]?.id;
  const hostProxyIdOnDisk = (): string | undefined =>
    readDoc().hosts?.find((host) => host.origin === 'https://host.example')?.proxyId;

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    await page.locator(byTestId('browser-address')).waitFor({ state: 'visible', timeout: 60_000 });
    await page.locator(byTestId('chat-settings')).click();
    await page
      .locator(byTestId('settings-panel'))
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });

    // --- Add one library proxy on the Proxies tab --------------------------
    await page.locator(byTestId('settings-tab-proxies')).click();
    const proxies = page.locator('.proxies-section');
    await proxies.locator('.multifield__add').first().click();
    const proxyItem = proxies.locator('.multifield__item').last();
    await proxyItem.locator(`${byField('proxy-address')} input`).fill('https://proxy.example:8080');
    const proxyLabel = proxyItem.locator(`${byField('proxy-label')} input`);
    await proxyLabel.fill('Corporate');
    // Leaving the address (label focus) commits it; Enter commits the label.
    await proxyLabel.press('Enter');
    await expect.poll(() => proxyIdOnDisk(), { timeout: 60_000 }).toBeDefined();

    // --- Add a host and give it that proxy --------------------------------
    await page.locator(byTestId('settings-tab-hosts')).click();
    const hosts = page.locator('.hosts-section');
    await hosts.locator('.multifield__add').first().click();
    const hostItem = hosts.locator('.multifield__item').last();
    const hostAddress = hostItem.locator(`${byField('host-address')} input`);
    await hostAddress.fill('https://host.example');
    // The host is created on leaving the address; Enter commits it while
    // keeping focus, so the proxy selection below has a persisted host to
    // attach to.
    await hostAddress.press('Enter');
    await expect.poll(() => hostProxyIdOnDisk(), { timeout: 60_000 }).toBeUndefined();

    const picker = hostItem.locator(byField('host-proxy'));
    const corporateId = proxyIdOnDisk();
    if (corporateId === undefined) throw new Error('proxy id missing on disk');
    // Selecting is done through the picker's own `value` + `change` (the same
    // pattern step09-model-selection uses); clicking the component's overlay is
    // brittle. This still exercises the real change handler and IPC path.
    await picker.evaluate((node, value) => {
      const picker = node as HTMLElement & { value: string };
      picker.value = value;
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    }, corporateId);

    // The host stores the proxy's *id*, not its label.
    await expect.poll(() => hostProxyIdOnDisk(), { timeout: 60_000 }).toBe(corporateId);

    // --- Remove the proxy; the host's reference is cleared ----------------
    await page.locator(byTestId('settings-tab-proxies')).click();
    await proxies
      .locator('.multifield__item')
      .first()
      .locator('.multifield__action--remove')
      .click();
    await page.locator(byTestId('banner-confirm')).first().click();
    await expect.poll(() => readDoc().proxies ?? [], { timeout: 60_000 }).toEqual([]);
    await expect.poll(() => hostProxyIdOnDisk(), { timeout: 60_000 }).toBeUndefined();

    // And the Hosts combobox now reads "(Default)" - the reference is cleared,
    // so the host inherits `browser.proxy` again.
    await page.locator(byTestId('settings-tab-hosts')).click();
    const selected = await hosts
      .locator(byField('host-proxy'))
      .first()
      .evaluate((element) => (element as HTMLElement & { value: string }).value);
    expect(selected).toBe('__default__');
  } finally {
    await app.close();
  }
});

test('a host can explicitly disable the proxy, and the browser default proxy persists', async () => {
  test.setTimeout(180_000);

  const { home, appData, localAppData } = createScratchDirs(scratchBase);

  const env = scratchEnv({ home, appData, localAppData });
  const settingsFile = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');

  const readDoc = (): SettingsDoc => {
    try {
      return JSON.parse(readFileSync(settingsFile, 'utf8')) as SettingsDoc;
    } catch {
      return {};
    }
  };
  const proxyIdOnDisk = (): string | undefined => readDoc().proxies?.[0]?.id;
  const hostProxyIdOnDisk = (): string | undefined =>
    readDoc().hosts?.find((host) => host.origin === 'https://host.example')?.proxyId;
  const browserProxyOnDisk = (): string | undefined => readDoc().browser?.proxy;

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    await page.locator(byTestId('browser-address')).waitFor({ state: 'visible', timeout: 60_000 });
    await page.locator(byTestId('chat-settings')).click();
    await page
      .locator(byTestId('settings-panel'))
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });

    // Add one library proxy.
    await page.locator(byTestId('settings-tab-proxies')).click();
    const proxies = page.locator('.proxies-section');
    await proxies.locator('.multifield__add').first().click();
    const proxyItem = proxies.locator('.multifield__item').last();
    await proxyItem.locator(`${byField('proxy-address')} input`).fill('https://proxy.example:8080');
    const proxyLabel = proxyItem.locator(`${byField('proxy-label')} input`);
    await proxyLabel.fill('Corporate');
    // Leaving the address (label focus) commits it; Enter commits the label.
    await proxyLabel.press('Enter');
    await expect.poll(() => proxyIdOnDisk(), { timeout: 60_000 }).toBeDefined();
    const corporateId = proxyIdOnDisk();
    if (corporateId === undefined) throw new Error('proxy id missing on disk');

    // The Browser tab's Default proxy maps to `browser.proxy`.
    await page.locator(byTestId('settings-tab-browser')).click();
    const browserSection = page.locator('.browser-section');
    const defaultProxy = browserSection.locator(byField('browser-default-proxy'));
    await defaultProxy.evaluate((node, value) => {
      const picker = node as HTMLElement & { value: string };
      picker.value = value;
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    }, corporateId);
    await expect.poll(() => browserProxyOnDisk(), { timeout: 60_000 }).toBe(corporateId);

    // A host set to "(No proxy)" stores the "none" sentinel, not an omission.
    await page.locator(byTestId('settings-tab-hosts')).click();
    const hosts = page.locator('.hosts-section');
    await hosts.locator('.multifield__add').first().click();
    const hostItem = hosts.locator('.multifield__item').last();
    const hostAddress = hostItem.locator(`${byField('host-address')} input`);
    await hostAddress.fill('https://host.example');
    // The host is created on leaving the address; Enter commits it while
    // keeping focus, so the proxy selection below has a persisted host to
    // attach to.
    await hostAddress.press('Enter');
    await expect.poll(() => hostProxyIdOnDisk(), { timeout: 60_000 }).toBeUndefined();

    await hostItem.locator(byField('host-proxy')).evaluate((node) => {
      const picker = node as HTMLElement & { value: string };
      picker.value = '__none__';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect.poll(() => hostProxyIdOnDisk(), { timeout: 60_000 }).toBe('none');
  } finally {
    await app.close();
  }
});
