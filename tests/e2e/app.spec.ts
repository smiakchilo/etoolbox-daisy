import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const mainEntry = path.resolve(__dirname, '../../out/main/index.js');

/**
 * A scratch storage root, exactly like every sibling spec uses. Without it
 * this spec shared the *real* profile's storage root, so a running `npm run
 * dev` instance held the single-instance lock and the test launch was refused
 * at startup ("Target page, context or browser has been closed") - the
 * documented load-correlated `app.spec.ts` flake. It also used to create
 * storage directories in the developer's real profile during a test run.
 */
const scratchBase = path.resolve(__dirname, '../../test-results', 'app-scratch');

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function provisionScratchEnv(): Record<string, string> {
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(path.join(scratchBase, 'profile-'));
  const home = path.join(root, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  return {
    ...definedEnv(process.env),
    USERPROFILE: home,
    HOME: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
  };
}

test.describe('EToolbox Daisy skeleton', () => {
  test('opens a window, renders a Spectrum button, exposes app info, and grants no Node access', async () => {
    const app = await electron.launch({ args: [mainEntry], env: provisionScratchEnv() });

    try {
      const window = await app.firstWindow();
      await window.waitForSelector('#daisy-hello-button');

      const buttonText = await window.locator('#daisy-hello-button').innerText();
      expect(buttonText).toContain('EToolbox Daisy skeleton');

      // The real security check: the renderer must have zero Node access,
      // even though contextIsolation + sandbox are on and a preload script
      // ran. `require`/`process` must be entirely undefined in page context.
      const nodeAccess = await window.evaluate(() => ({
        hasRequire: typeof (globalThis as unknown as { require?: unknown }).require,
        hasProcess: typeof (globalThis as unknown as { process?: unknown }).process,
      }));
      expect(nodeAccess.hasRequire).toBe('undefined');
      expect(nodeAccess.hasProcess).toBe('undefined');

      // The versioned preload bridge must still work despite the isolation
      // above: it round-trips through IPC and shared Zod validation.
      await window.waitForSelector('#daisy-app-info');
      const appInfoText = await window.locator('#daisy-app-info').innerText();
      expect(appInfoText).toContain('EToolbox Daisy');
    } finally {
      await app.close();
    }
  });

  // Windows-only in effect, but the switch is asserted on every platform: the
  // point is that the app always asks Chromium to handle WebAuthn itself, so
  // the native Windows API (and its "unverified app" security-key dialog,
  // which Adobe's IMS login page triggers) is never used. See
  // `mergeDisabledFeatures` and its call site in `src/main/index.ts`.
  test('disables the native Windows WebAuthn API at startup', async () => {
    const app = await electron.launch({ args: [mainEntry], env: provisionScratchEnv() });

    try {
      await app.firstWindow();
      const disabledFeatures = await app.evaluate(({ app: electronApp }) =>
        electronApp.commandLine.getSwitchValue('disable-features'),
      );
      expect(disabledFeatures.split(',')).toContain('WebAuthenticationUseNativeWinApi');
    } finally {
      await app.close();
    }
  });
});
