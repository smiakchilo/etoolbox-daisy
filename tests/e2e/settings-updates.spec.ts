import { _electron as electron, expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { generateTestCa, issueTrustedLeafCert } from '../integration/support/testCa';
import { mainEntry } from '../support/e2e/app';
import { createScratchDirs, scratchEnv } from '../support/e2e/profile';
import { byField, byTestId } from '../support/selectors';

/**
 * The Settings "Updates" tab against the built app, end to end: the tab is last,
 * **Update** is hidden until a check finds a newer version, and applying it
 * downloads, verifies and swaps the archive of a scratch install (the dev/QA
 * sandbox, `EDAISY_UPDATE_SANDBOX`). The manifest is served over real HTTPS by a
 * local server whose CA reaches main through `NODE_EXTRA_CA_CERTS`.
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'settings-updates-scratch');

test('the Updates tab finds a newer version and swaps the archive of the sandbox install', async () => {
  test.setTimeout(180_000);

  const { root, home, appData, localAppData } = createScratchDirs(scratchBase);
  const sandbox = path.join(root, 'install');
  const targetAsar = path.join(sandbox, 'resources', 'app.asar');
  mkdirSync(path.dirname(targetAsar), { recursive: true });
  writeFileSync(targetAsar, 'old archive');

  const newArchive = Buffer.from('new archive bytes');
  const archiveName = 'app-99.0.0.asar';
  const manifest = {
    version: '99.0.0',
    files: {
      [`${process.platform}-${process.arch}`]: {
        name: archiveName,
        sha512: createHash('sha512').update(newArchive).digest('hex'),
        size: newArchive.length,
      },
    },
  };

  const ca = await generateTestCa();
  const leaf = await issueTrustedLeafCert('localhost', ca);
  const caFile = path.join(root, 'ca.pem');
  writeFileSync(caFile, ca.cert);
  const server = createServer({ key: leaf.key, cert: leaf.cert }, (request, response) => {
    if (request.url === '/updates/update.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(manifest));
    } else if (request.url === `/updates/${archiveName}`) {
      response.setHeader('content-type', 'application/octet-stream');
      response.end(newArchive);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const env = {
    ...scratchEnv({ home, appData, localAppData }),
    EDAISY_UPDATE_SANDBOX: sandbox,
    NODE_EXTRA_CA_CERTS: caFile,
  };
  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const shell = await app.firstWindow();
    await shell.locator(byTestId('browser-address')).waitFor({ state: 'visible', timeout: 60_000 });
    await shell.locator(byTestId('chat-settings')).click();
    await shell
      .locator(byTestId('settings-panel'))
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });

    const tabIds = await shell
      .locator('.settings-panel__tabs sp-tab')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));
    expect(tabIds.at(-1)).toBe('settings-tab-updates');

    await shell.locator(byTestId('settings-tab-updates')).click();
    const panel = shell.locator('.settings-panel__tab-panel[selected]');
    const badges = panel.locator('sp-contextual-help');
    await expect(badges).toHaveCount(2);
    expect(await badges.first().evaluate((node) => node.shadowRoot !== null)).toBe(true);

    const checkButton = panel.locator(byTestId('updates-check'));
    const applyButton = panel.locator(byTestId('updates-apply'));
    await expect(checkButton).toBeVisible();
    await expect(applyButton).toBeHidden();

    // Check, then the startup checkbox, then the custom URL; the checkbox is
    // set apart from the button line by a gap.
    const startupBox = await panel.locator(byField('updates-check-on-startup')).boundingBox();
    const urlBox = await panel.locator(byField('updates-url')).boundingBox();
    const buttonBox = await checkButton.boundingBox();
    expect(buttonBox?.y ?? 0).toBeLessThan(startupBox?.y ?? 0);
    expect(startupBox?.y ?? 0).toBeLessThan(urlBox?.y ?? 0);
    expect((startupBox?.y ?? 0) - ((buttonBox?.y ?? 0) + (buttonBox?.height ?? 0))).toBeGreaterThan(
      16,
    );

    // The check button and the Update button share one line.
    const urlInput = panel.locator(byField('updates-url') + ' input');
    await urlInput.fill(`https://localhost:${String(port)}/updates`);
    await urlInput.press('Enter');
    const settingsFile = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
    await expect
      .poll(() => (existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : ''))
      .toContain(`https://localhost:${String(port)}/updates`);

    await checkButton.click();
    await expect(applyButton).toBeVisible({ timeout: 30_000 });
    const fillOf = (node: HTMLElement) => getComputedStyle(node).backgroundColor;
    expect(await applyButton.evaluate(fillOf)).not.toBe(await checkButton.evaluate(fillOf));
    const checkBox = await checkButton.boundingBox();
    const applyBox = await applyButton.boundingBox();
    expect(Math.abs((checkBox?.y ?? 0) - (applyBox?.y ?? 1000))).toBeLessThan(8);

    await applyButton.click();
    await shell.locator(`.surface-status-banner[open] ${byTestId('banner-confirm')}`).click();

    await expect
      .poll(() => (existsSync(targetAsar) ? readFileSync(targetAsar) : Buffer.alloc(0)), {
        timeout: 30_000,
      })
      .toEqual(newArchive);
    expect(readFileSync(`${targetAsar}.bak`, 'utf8')).toBe('old archive');
    await expect(applyButton).toBeHidden();
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
