import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { defaultAppSettings, type DaisyAppApi } from '../../src/shared';
import { mainEntry } from '../support/e2e/app';
import { createLaunchProfile } from '../support/e2e/profile';

// `tsconfig.test.json` does not include the renderer's `global.d.ts`, so this
// file declares the minimal renderer-side shape its `page.evaluate` callbacks
// need - real at runtime (that callback body re-executes inside the actual
// renderer), just not ambiently declared for this project's Node-side check.
// Mirrors `agent-chat.spec.ts`'s own `TestWindow` note.
declare const window: { readonly daisy: DaisyAppApi };

/**
 * A scratch storage root, exactly like every sibling spec uses. Without it
 * this spec shared the *real* profile's storage root, so a running `npm run
 * dev` instance held the single-instance lock and the test launch was refused
 * at startup ("Target page, context or browser has been closed") - the
 * documented load-correlated `app.spec.ts` flake. It also used to create
 * storage directories in the developer's real profile during a test run.
 */
const scratchBase = path.resolve(__dirname, '../../test-results', 'app-scratch');

test.describe('EToolbox Daisy shell', () => {
  test('opens a window, renders the Spectrum shell, exposes app info, and grants no Node access', async () => {
    const app = await electron.launch({
      args: [mainEntry],
      env: createLaunchProfile(scratchBase).env,
    });

    try {
      const page = await app.firstWindow();
      await page.waitForSelector('.main-shell');

      // A real Spectrum element must be registered, not merely present as an
      // unknown tag: jsdom cannot tell the difference, so this is asserted
      // against the built app in an Electron renderer.
      const themeRegistered = await page.evaluate(() => Boolean(customElements.get('sp-theme')));
      expect(themeRegistered).toBe(true);

      // The real security check: the renderer must have zero Node access,
      // even though contextIsolation + sandbox are on and a preload script
      // ran. `require`/`process` must be entirely undefined in page context.
      const nodeAccess = await page.evaluate(() => ({
        hasRequire: typeof (globalThis as unknown as { require?: unknown }).require,
        hasProcess: typeof (globalThis as unknown as { process?: unknown }).process,
      }));
      expect(nodeAccess.hasRequire).toBe('undefined');
      expect(nodeAccess.hasProcess).toBe('undefined');

      // The versioned preload bridge must still work despite the isolation
      // above: it round-trips through IPC and shared Zod validation.
      const appInfo = await page.evaluate(() => window.daisy.getAppInfo());
      expect(appInfo.name).toBe('EToolbox Daisy');
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
    const app = await electron.launch({
      args: [mainEntry],
      env: createLaunchProfile(scratchBase).env,
    });

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

  // The switch is driven by the Settings "Browser" tab's checkbox, read
  // synchronously before Electron is ready (a change takes effect next launch).
  test('omits the native WebAuthn suppression when the persisted flag is off', async () => {
    const env = createLaunchProfile(scratchBase).env;
    const settingsPath = path.join(
      env['USERPROFILE'] ?? '',
      'etoolbox-daisy',
      'settings',
      'settings.json',
    );
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(
        { ...defaultAppSettings(), browser: { disableNativeWebAuthn: false } },
        null,
        2,
      ),
      'utf8',
    );

    const app = await electron.launch({ args: [mainEntry], env });
    try {
      await app.firstWindow();
      const disabledFeatures = await app.evaluate(({ app: electronApp }) =>
        electronApp.commandLine.getSwitchValue('disable-features'),
      );
      expect(disabledFeatures.split(',')).not.toContain('WebAuthenticationUseNativeWinApi');
    } finally {
      await app.close();
    }
  });
});
