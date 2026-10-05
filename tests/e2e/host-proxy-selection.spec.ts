import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';

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

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'host-proxy-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

interface SettingsDoc {
  hosts?: { origin?: string; proxyId?: string }[];
  proxies?: { id?: string }[];
  browser?: { proxy?: string };
}

test('a host uses a library proxy, and removing it clears the reference', async () => {
  test.setTimeout(180_000);

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
    await page.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
    await page.locator('sp-action-button[title="Settings"]').first().click();
    await page.locator('.settings-panel').first().waitFor({ state: 'visible', timeout: 60_000 });

    // --- Add one library proxy on the Proxies tab --------------------------
    await page.locator('sp-tab', { hasText: 'Proxies' }).click();
    const proxies = page.locator('section[aria-label="Proxies"]');
    await proxies.locator('.multifield__add').first().click();
    const proxyItem = proxies.locator('.multifield__item').last();
    await proxyItem
      .locator('sp-textfield[aria-label="Address"] input')
      .fill('https://proxy.example:8080');
    const proxyLabel = proxyItem.locator('sp-textfield[aria-label="Label"] input');
    await proxyLabel.fill('Corporate');
    // Leaving the address (label focus) commits it; Enter commits the label.
    await proxyLabel.press('Enter');
    await expect.poll(() => proxyIdOnDisk(), { timeout: 60_000 }).toBeDefined();

    // --- Add a host and give it that proxy --------------------------------
    await page.locator('sp-tab', { hasText: 'Hosts' }).click();
    const hosts = page.locator('section[aria-label="Hosts"]');
    await hosts.locator('.multifield__add').first().click();
    const hostItem = hosts.locator('.multifield__item').last();
    const hostAddress = hostItem.locator('sp-textfield[aria-label="Address"] input');
    await hostAddress.fill('https://host.example');
    // The host is created on leaving the address; Enter commits it while
    // keeping focus, so the proxy selection below has a persisted host to
    // attach to.
    await hostAddress.press('Enter');
    await expect.poll(() => hostProxyIdOnDisk(), { timeout: 60_000 }).toBeUndefined();

    const picker = hostItem.locator('sp-picker[aria-label="Proxy"]');
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
    await page.locator('sp-tab', { hasText: 'Proxies' }).click();
    await proxies
      .locator('.multifield__item')
      .first()
      .locator('.multifield__action--remove')
      .click();
    await page
      .locator('.surface-status-banner sp-action-button', { hasText: 'OK' })
      .first()
      .click();
    await expect.poll(() => readDoc().proxies ?? [], { timeout: 60_000 }).toEqual([]);
    await expect.poll(() => hostProxyIdOnDisk(), { timeout: 60_000 }).toBeUndefined();

    // And the Hosts combobox now reads "(Default)" - the reference is cleared,
    // so the host inherits `browser.proxy` again.
    await page.locator('sp-tab', { hasText: 'Hosts' }).click();
    const selected = await hosts
      .locator('sp-picker[aria-label="Proxy"]')
      .first()
      .evaluate((element) => (element as HTMLElement & { value: string }).value);
    expect(selected).toBe('__default__');
  } finally {
    await app.close();
  }
});

test('a host can explicitly disable the proxy, and the browser default proxy persists', async () => {
  test.setTimeout(180_000);

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
    await page.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });
    await page.locator('sp-action-button[title="Settings"]').first().click();
    await page.locator('.settings-panel').first().waitFor({ state: 'visible', timeout: 60_000 });

    // Add one library proxy.
    await page.locator('sp-tab', { hasText: 'Proxies' }).click();
    const proxies = page.locator('section[aria-label="Proxies"]');
    await proxies.locator('.multifield__add').first().click();
    const proxyItem = proxies.locator('.multifield__item').last();
    await proxyItem
      .locator('sp-textfield[aria-label="Address"] input')
      .fill('https://proxy.example:8080');
    const proxyLabel = proxyItem.locator('sp-textfield[aria-label="Label"] input');
    await proxyLabel.fill('Corporate');
    // Leaving the address (label focus) commits it; Enter commits the label.
    await proxyLabel.press('Enter');
    await expect.poll(() => proxyIdOnDisk(), { timeout: 60_000 }).toBeDefined();
    const corporateId = proxyIdOnDisk();
    if (corporateId === undefined) throw new Error('proxy id missing on disk');

    // The Browser tab's Default proxy maps to `browser.proxy`.
    await page.locator('sp-tab', { hasText: 'Browser' }).click();
    const browserSection = page.locator('section[aria-label="Browser"]');
    const defaultProxy = browserSection.locator('sp-picker[aria-label="Proxy"]');
    await defaultProxy.evaluate((node, value) => {
      const picker = node as HTMLElement & { value: string };
      picker.value = value;
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    }, corporateId);
    await expect.poll(() => browserProxyOnDisk(), { timeout: 60_000 }).toBe(corporateId);

    // A host set to "(No proxy)" stores the "none" sentinel, not an omission.
    await page.locator('sp-tab', { hasText: 'Hosts' }).click();
    const hosts = page.locator('section[aria-label="Hosts"]');
    await hosts.locator('.multifield__add').first().click();
    const hostItem = hosts.locator('.multifield__item').last();
    const hostAddress = hostItem.locator('sp-textfield[aria-label="Address"] input');
    await hostAddress.fill('https://host.example');
    // The host is created on leaving the address; Enter commits it while
    // keeping focus, so the proxy selection below has a persisted host to
    // attach to.
    await hostAddress.press('Enter');
    await expect.poll(() => hostProxyIdOnDisk(), { timeout: 60_000 }).toBeUndefined();

    await hostItem.locator('sp-picker[aria-label="Proxy"]').evaluate((node) => {
      const picker = node as HTMLElement & { value: string };
      picker.value = '__none__';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect.poll(() => hostProxyIdOnDisk(), { timeout: 60_000 }).toBe('none');
  } finally {
    await app.close();
  }
});
