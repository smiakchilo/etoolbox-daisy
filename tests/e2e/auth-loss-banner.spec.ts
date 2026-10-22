import { _electron as electron, expect, test } from '@playwright/test';
import path from 'node:path';
import { BROWSER_AUTH_INCIDENT_CHANNEL } from '../../src/shared';
import { mainEntry } from '../support/e2e/app';
import { createLaunchProfile } from '../support/e2e/profile';
import { byTestId } from '../support/selectors';

/**
 * Main pushes `browser:auth-incident` when a host stops recognising the user
 * mid-run. The broker's detection and latching are unit-tested; this proves the
 * built app's preload subscription reaches the shell, which raises the sticky
 * notice with its Reload action and retracts it when main reports recovery.
 */
const scratchBase = path.resolve(__dirname, '../../test-results', 'auth-loss-banner-scratch');

test('an auth-incident push raises a Reload notice and a recovery push retracts it', async () => {
  test.setTimeout(120_000);

  const { env } = createLaunchProfile(scratchBase);
  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    await page.locator(byTestId('chat-settings')).waitFor({ state: 'visible', timeout: 30_000 });
    const reload = page.locator(byTestId('banner-auth-reload'));

    await app.evaluate(
      ({ BrowserWindow }, args: { channel: string; payload: unknown }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send(args.channel, args.payload);
      },
      {
        channel: BROWSER_AUTH_INCIDENT_CHANNEL,
        payload: { state: 'lost', severity: 'certain', hostLabel: 'Author' },
      },
    );
    await expect(reload).toBeVisible();

    await app.evaluate(
      ({ BrowserWindow }, args: { channel: string; payload: unknown }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send(args.channel, args.payload);
      },
      { channel: BROWSER_AUTH_INCIDENT_CHANNEL, payload: { state: 'recovered' } },
    );
    await expect(reload).toBeHidden();
  } finally {
    await app.close();
  }
});
