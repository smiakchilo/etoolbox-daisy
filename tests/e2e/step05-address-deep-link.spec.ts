import { _electron as electron, expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultAppSettings } from '../../src/shared';

/**
 * The address bar displays the full current URL, so it must also ACCEPT one.
 * Before this was fixed it did not: the navigation path reused `parseOrigin`,
 * which exists to guard what may be stored as a *server setting* and therefore
 * rejects any path. A user could copy the URL the app was showing them, paste
 * it straight back, and be told "not a valid address" - while pasting a deep
 * AEM page link is the primary way an author navigates.
 *
 * This spec is the end-to-end guard for that: real typing into the real
 * Spectrum control, real IPC, real `loadURL`, and the loaded URL read back
 * from the address bar the main process drives.
 *
 * It also pins the half of the behaviour that must NOT change: authorization
 * is still decided on the origin alone, so a deep link into an unconfigured
 * origin still prompts instead of navigating (requirements-decisions.md
 * section 3 - "never silently navigate and never auto-create the entry").
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'step05-deep-link-scratch');

const DEEP_PATH = '/editor.html/content/site/en.html';

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * A server that echoes the path it was asked for, so "did the deep link
 * actually reach the origin?" is answered by the origin itself rather than
 * inferred from the renderer alone.
 */
async function startEchoOrigin(): Promise<{ origin: string; paths: string[]; close: () => void }> {
  const paths: string[] = [];
  const server: Server = createServer((req, res) => {
    paths.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>echo</title><p id="p">${req.url ?? ''}</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    paths,
    close: () => server.close(),
  };
}

test('a pasted deep link navigates to that page, while an unconfigured origin still prompts', async () => {
  test.setTimeout(120_000);

  const aem = await startEchoOrigin();
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

  // Built from the app's own defaults and validated with the real schema, so
  // a contract change fails loudly here instead of producing a file the app
  // silently rejects at runtime.
  const base = defaultAppSettings();
  const seeded = appSettingsSchema.parse({
    ...base,
    servers: [
      ...base.servers,
      {
        id: randomUUID(),
        label: 'Echo fixture',
        origin: aem.origin,
        color: { kind: 'swatch', swatch: 'blue' },
        revision: 0,
      },
    ],
  });
  const settingsPath = path.join(home, 'etoolbox-daisy', 'settings', 'settings.json');
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(seeded, null, 2), 'utf8');

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const page = await app.firstWindow();
    await page.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 30_000 });

    const addressInput = page.locator('#browser-address-bar input');
    const deepUrl = `${aem.origin}${DEEP_PATH}`;
    await addressInput.fill(deepUrl);
    await addressInput.press('Enter');

    // The origin itself confirms the request arrived with the full path - the
    // strongest available evidence that nothing stripped it down to the root.
    await expect.poll(() => aem.paths.includes(DEEP_PATH), { timeout: 60_000 }).toBe(true);

    // And the address bar, which the main process drives from the view's real
    // URL, must show that same page rather than the server root.
    await expect
      .poll(async () => await addressInput.inputValue(), { timeout: 60_000 })
      .toBe(deepUrl);

    const message = page.locator('.browser-toolbar-message');
    expect((await message.textContent()) ?? '').not.toContain('not a valid address');

    // The other half of the contract: a path must not become a way to reach an
    // origin the user never configured.
    const unknownDeepUrl = 'https://unconfigured.example/editor.html/content/x.html';
    await addressInput.fill(unknownDeepUrl);
    await addressInput.press('Enter');

    await expect(message).toContainText('is not a configured server', { timeout: 60_000 });
    // The prompt must name the ORIGIN, not the full URL - that is what the
    // user would be adding as a server.
    await expect(message).toContainText('https://unconfigured.example');
    expect((await message.textContent()) ?? '').not.toContain('editor.html');
  } finally {
    await app.close();
    aem.close();
  }
});
