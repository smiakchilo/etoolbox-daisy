import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Step 04/05 secret boundary, proven against the running application rather
 * than against the storage module in isolation.
 *
 * The unit suite already asserts `toAppSettingsSnapshot` replaces a password
 * with `hasPassword`. That is necessary but not sufficient: it says nothing
 * about what the *live app* writes to disk once a real user types a real
 * password into the Settings panel. A password could still reach the
 * settings document, a diagnostic log, or a Chromium cache entry, and every
 * unit test would stay green.
 *
 * So this spec types a canary into the actual Spectrum password field, saves
 * it through the actual IPC, and then reads every byte the app wrote anywhere
 * under its isolated profile.
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'step05-canary-scratch');

/** Distinctive enough that a substring hit cannot be a coincidence. */
const CANARY = 'Daisy-Canary-Pw-7f3a91c4-DO-NOT-PERSIST';

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

interface ScanResult {
  readonly filesScanned: number;
  readonly hits: string[];
}

/**
 * Reads every file under `root` and looks for the canary in both UTF-8 and
 * UTF-16LE. UTF-16LE matters on Windows: a value that reached a Windows API
 * or a wide-character log would be invisible to a UTF-8-only search.
 */
function scanForCanary(root: string): ScanResult {
  const utf8 = Buffer.from(CANARY, 'utf8');
  const utf16 = Buffer.from(CANARY, 'utf16le');
  const hits: string[] = [];
  let filesScanned = 0;

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(full);
        continue;
      }
      if (!stats.isFile() || stats.size > 32 * 1024 * 1024) continue;
      let contents: Buffer;
      try {
        contents = readFileSync(full);
      } catch {
        continue;
      }
      filesScanned += 1;
      if (contents.includes(utf8) || contents.includes(utf16)) {
        hits.push(full);
      }
    }
  };

  walk(root);
  return { filesScanned, hits };
}

test('a password typed into Settings is never written anywhere in plaintext', async () => {
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

  const app = await electron.launch({ args: [mainEntry], env });
  try {
    const shell = await app.firstWindow();
    await shell.locator('#browser-address-bar').waitFor({ state: 'visible', timeout: 60_000 });

    await shell.locator('sp-action-button', { hasText: 'Settings' }).first().click();
    await shell.locator('.settings-panel').first().waitFor({ state: 'visible', timeout: 60_000 });

    // Settings is tabbed; the proxy library lives behind the "Proxies" tab as
    // a multifield. Create one entry, then set its password.
    await shell.locator('sp-tab', { hasText: 'Proxies' }).click();
    const proxies = shell.locator('section[aria-label="Proxies"]');
    await proxies.locator('.multifield__add').click();

    // A proxy address and username must exist before a password has anywhere
    // to attach; the entry's fields auto-save (no Save button). The settings
    // document on disk is the sync point that makes the password below attach
    // to a proxy the main process already knows about. The callback must not
    // throw while the file does not exist yet - expect.poll fails immediately
    // on a thrown error, it only retries on a matcher mismatch.
    const addressField = proxies.locator('[aria-label="Address"] input');
    await addressField.waitFor({ state: 'visible', timeout: 60_000 });
    await addressField.fill('https://proxy.example:8080');
    const usernameField = proxies.locator('[aria-label="User name"] input');
    await usernameField.fill('canary-user');
    await expect
      .poll(
        () => {
          try {
            return readFileSync(settingsFile, 'utf8');
          } catch {
            return '';
          }
        },
        { timeout: 60_000 },
      )
      .toContain('https://proxy.example:8080');

    const passwordField = proxies.locator('[aria-label="Password"] input');
    await passwordField.waitFor({ state: 'visible', timeout: 60_000 });
    await passwordField.fill(CANARY);
    await proxies.locator('.password-control sp-action-button', { hasText: 'Set' }).click();

    // The app's own confirmation is the sync point - not an arbitrary sleep,
    // which could let the scan run before anything had been written at all.
    // It appears in the panel's one banner (`settings-banner`).
    await expect(shell.locator('.settings-banner')).toHaveText('Password saved', {
      timeout: 60_000,
    });

    // Anti-vacuity: the entry must genuinely carry credentials on disk,
    // otherwise "not found anywhere" would be true for the uninteresting
    // reason that nothing happened. `secretRef` is the persisted pointer whose
    // target the secret store encrypts.
    const onDisk = readFileSync(settingsFile, 'utf8');
    expect(onDisk).toContain('canary-user');
    expect(onDisk).toContain('secretRef');

    // And the renderer must not be holding it either: the field is cleared on
    // save, so the canary must not survive anywhere in the shell document.
    const shellHtml = await shell.content();
    expect(shellHtml).not.toContain(CANARY);
  } finally {
    // Closed before scanning so every buffered log and cache entry is flushed -
    // a scan of a live profile could miss a write still sitting in memory.
    await app.close();
  }

  const scan = scanForCanary(home);
  console.error(`canary scan: ${String(scan.filesScanned)} files under ${home}`);

  // If the walk found nothing to read, the assertion below would be vacuous.
  expect(scan.filesScanned).toBeGreaterThan(5);

  // The secret store must have produced a file, and that file must NOT contain
  // the plaintext - encryption at rest, verified rather than assumed.
  const secretsDir = path.join(home, 'etoolbox-daisy', 'settings', 'secrets');
  const secretFiles = readdirSync(secretsDir);
  expect(secretFiles.length).toBeGreaterThan(0);

  expect(scan.hits, `plaintext password found in: ${scan.hits.join(', ')}`).toEqual([]);
});
