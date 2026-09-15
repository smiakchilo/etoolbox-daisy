import { _electron as electron, expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared/contracts/appSettings';

/**
 * Step 05 success criterion: "Network errors are explicit."
 *
 * The unit suite proves `switchTo` classifies a Chromium `ERR_*` rejection
 * into a structured `network_error` outcome, but it does so against fake
 * views. This spec proves the whole chain instead - real `loadURL` rejection,
 * real IPC, real renderer - by pointing a configured server at a port nothing
 * is listening on and asserting the user is actually TOLD.
 *
 * That matters because the failure mode this replaced was silent: `switchTo`
 * rethrew, `switchServer` never caught, and `ipcMain.handle` forwarded the
 * rejection, so the renderer's `result.ok` check was never reached at all for
 * the app's single most common failure (a server that is down).
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'step05-network-error-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Binds a port, reads it, then releases it - so nothing can be listening there. */
async function reserveClosedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

test('a configured server that is down is reported to the user, not swallowed', async () => {
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

  // No seeding launch is needed: the settings document is written before the
  // app ever starts, which is also a stricter test - it proves the app reads
  // a pre-existing configuration rather than one it just wrote itself.

  // The app writes its settings document lazily, so there is nothing on disk
  // to read after a first launch. The document is therefore built from the
  // app's OWN `defaultAppSettings()` and validated with the real schema -
  // never hand-authored - so a future contract change fails here loudly
  // instead of producing a file the app quietly rejects at runtime.
  const deadPort = await reserveClosedPort();
  const deadOrigin = `http://127.0.0.1:${String(deadPort)}`;
  const serverId = randomUUID();

  const settingsPath = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
  const base = defaultAppSettings();
  const seeded = appSettingsSchema.parse({
    ...base,
    servers: [
      ...base.servers,
      {
        id: serverId,
        label: 'Unreachable fixture',
        origin: deadOrigin,
        color: { kind: 'swatch', swatch: 'red' },
        revision: 0,
      },
    ],
  });
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(seeded, null, 2), 'utf8');

  const app = await electron.launch({ args: [mainEntry], env });
  const page = await app.firstWindow();
  await page.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 30_000 });

  // Drive the real control the user drives: `sp-textfield` renders a native
  // input in its shadow root, which Playwright pierces, so this is genuine
  // typing rather than a synthesised event.
  const addressInput = page.locator('#browser-address-bar input');
  await addressInput.fill(deadOrigin);
  await addressInput.press('Enter');

  const message = page.locator('.browser-toolbar-message__text');
  await expect(message).toBeVisible({ timeout: 60_000 });

  // Explicit means the user can act on it: the message must eventually name
  // the real Chromium failure, not a generic "something went wrong" - and not
  // the transient "Switching servers..." status that precedes it.
  await expect(message).toContainText('ERR_', { timeout: 60_000 });
  const text = (await message.textContent()) ?? '';
  console.error('toolbar message:', JSON.stringify(text));
  expect(text).not.toContain('Switching servers');

  await app.close();
});
