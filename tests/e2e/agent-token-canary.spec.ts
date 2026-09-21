import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The agent personal-access-token secret boundary, proven against the running
 * application rather than against the storage module in isolation.
 *
 * The unit suite asserts `toAppSettingsSnapshot` replaces an agent's token
 * pointer with `hasToken`, and that `settings:set-password` targeting an agent
 * mints a `secretRef` instead of writing the token. That is necessary but not
 * sufficient: it says nothing about what the *live app* writes once a real
 * user types a real token into the Settings panel's Token field.
 *
 * So this spec types a canary into the actual Spectrum field, saves it through
 * the actual IPC, and then reads every byte the app wrote anywhere under its
 * isolated profile. It also asserts the two behavioural consequences: the
 * provider becomes active (badge), and its status light reads "Authenticated
 * with token".
 *
 * Run against the BUILT app (this file never builds it):
 *   npm run build
 *   npx playwright test tests/e2e/agent-token-canary.spec.ts
 */

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');
const scratchBase = path.resolve(__dirname, '../../test-results', 'agent-token-canary-scratch');

/** Distinctive enough that a substring hit cannot be a coincidence. */
const CANARY = 'Daisy-Canary-Token-7f3a91c4-DO-NOT-PERSIST';

/** The deterministic pointer the token is filed under (see `agentTokenSecretRef`). */
const AGENT_TOKEN_REF = 'agent-token:copilot';

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

test('a token typed into Settings is never written in plaintext, and activates the agent', async () => {
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

    await shell.locator('sp-tab', { hasText: 'Agents' }).click();
    const agents = shell.locator('section[aria-label="Agents"]');
    await agents.waitFor({ state: 'visible', timeout: 60_000 });

    // A fresh, signed-out profile: nothing is active (no badge) and the status
    // light is negative. This is the anti-vacuity baseline for the token. The
    // exact signed-out wording comes from the runtime, so only the variant is
    // asserted here.
    await expect(agents.locator('.agent-item__active')).toHaveCount(0);
    const statusLight = agents.locator('.agent-item__auth sp-status-light');
    await expect
      .poll(async () => statusLight.getAttribute('variant'), { timeout: 60_000 })
      .toBe('negative');

    // Type the canary into the real Token field and Set it.
    const tokenField = agents.locator('.password-control [aria-label="Token"] input');
    await tokenField.waitFor({ state: 'visible', timeout: 60_000 });
    await tokenField.fill(CANARY);
    await agents.locator('.password-control sp-action-button', { hasText: 'Set' }).click();

    // The app's own confirmation is the sync point - not an arbitrary sleep,
    // which could let the scan run before anything had been written at all.
    await expect(shell.locator('.settings-banner')).toHaveText('Token saved', {
      timeout: 60_000,
    });

    // Behaviour: a stored token counts as authentication, so the provider is
    // active (badge) and its status light reads authenticated, green.
    await expect(agents.locator('.agent-item__active')).toHaveCount(1);
    await expect(statusLight).toHaveText('Authenticated with token');
    expect(await statusLight.getAttribute('variant')).toBe('positive');

    // Anti-vacuity: the pointer must genuinely be on disk, otherwise "not found
    // anywhere" would be true for the uninteresting reason that nothing
    // happened. `secretRef` is the persisted pointer whose target the secret
    // store encrypts.
    const onDisk = readFileSync(settingsFile, 'utf8');
    expect(onDisk).toContain('secretRef');
    expect(onDisk).toContain(AGENT_TOKEN_REF);
    // And the token itself must not be in the settings document.
    expect(onDisk).not.toContain(CANARY);

    // The renderer must not be holding it either: the field is cleared on save.
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

  expect(scan.hits, `plaintext token found in: ${scan.hits.join(', ')}`).toEqual([]);
});
