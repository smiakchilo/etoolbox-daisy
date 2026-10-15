import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { mainEntry } from '../support/e2e/app';
import { definedEnv } from '../support/e2e/env';
import { createScratchDirs } from '../support/e2e/profile';

/**
 * Electron-level verification for docs/implementation-plan.md step 04
 * ("Implement Paths, Settings, and Secure Storage"). Step 04's unit tests all
 * run under plain vitest with no Electron, so they never actually prove:
 *
 *   A. that the app writes under a scratch home instead of the real user
 *      home (isolation - see below for why USERPROFILE alone is not enough),
 *   B. that the visible (home) and technical (LOCALAPPDATA) directories are
 *      really created on disk, and no technical data lands in the visible one,
 *   C. that `app.setPath(...)` in src/main/index.ts really takes effect, and
 *   D. that `electron.safeStorage` is really available and DPAPI-backed on
 *      this machine, and genuinely satisfies `SecretCipher` at runtime -
 *      every unit test injects a fake AES-GCM cipher instead.
 *
 * It also investigates (E) the call ordering in src/main/index.ts, where
 * `app.requestSingleInstanceLock()` runs before `app.setPath("userData", ...)`.
 *
 * Run with the BUILT app, matching tests/e2e/app.spec.ts:
 *   npm run build && npx playwright test tests/e2e/step04-storage.spec.ts
 */

const testResultsRoot = path.resolve(__dirname, '../../test-results');
const scratchBase = path.join(testResultsRoot, 'step04-storage-scratch');
const CANARY = 'CANARY-SECRET-d41d8cd98f00b204';

type LaunchedApp = Awaited<ReturnType<typeof electron.launch>>;

interface ScratchProfile {
  /** The mkdtemp'd scratch directory this profile lives under, inside test-results/. */
  readonly root: string;
  /** The fake "home" directory: this becomes USERPROFILE/HOME for the child process. */
  readonly home: string;
  /** A fake roaming AppData directory: this becomes APPDATA. */
  readonly appData: string;
  /** A fake local AppData directory: this becomes LOCALAPPDATA. */
  readonly localAppData: string;
}

const scratchRoots: string[] = [];

/**
 * Creates an isolated fake Windows user profile under test-results/, never
 * under the real home directory.
 *
 * Empirically (verified against this Electron 44.3.0 on this machine, by
 * launching real Electron processes with each combination of overrides
 * before writing this test), overriding only USERPROFILE/HOME - as one might
 * naively do, since `os.homedir()` reads only USERPROFILE on Windows - is
 * NOT enough: the child process crashes on startup (exit code
 * 0x80000003/STATUS_BREAKPOINT) before `app.whenReady()` ever resolves,
 * because Electron/Chromium's default (pre-`setPath`) `appData` path comes
 * from the APPDATA env var, not USERPROFILE, and something downstream
 * chokes on a USERPROFILE that doesn't agree with the real APPDATA. Electron
 * only starts cleanly when APPDATA/LOCALAPPDATA are overridden to a matching
 * scratch location too. Without that, the process would also briefly write a
 * couple of bootstrap files (`Local State`, `DevToolsActivePort`) into the
 * REAL `%APPDATA%\EToolbox Daisy` before any of our code runs - exactly the
 * real-data pollution this test must prevent. So all four variables are
 * overridden together for every launch in this file.
 */
function createScratchProfile(label: string): ScratchProfile {
  const { root, home, appData, localAppData } = createScratchDirs(scratchBase, `${label}-`);
  scratchRoots.push(root);
  return { root, home, appData, localAppData };
}

/** Drops `undefined` values so the result is assignable to Playwright's `env`. */

/**
 * Builds the launch `env` for `profile`. `process.env` is spread through
 * explicitly (Playwright's `env` replaces rather than merges), so PATH,
 * SystemRoot, etc. all survive; only USERPROFILE/HOME/APPDATA/LOCALAPPDATA
 * are overridden. `appDataOverride`/`localAppDataOverride` let the
 * single-instance investigation below vary APPDATA independently of
 * USERPROFILE.
 */
function envFor(
  profile: ScratchProfile,
  appDataOverride?: { appData: string; localAppData: string },
): Record<string, string> {
  return {
    ...definedEnv(process.env),
    USERPROFILE: profile.home,
    HOME: profile.home,
    APPDATA: appDataOverride?.appData ?? profile.appData,
    LOCALAPPDATA: appDataOverride?.localAppData ?? profile.localAppData,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupScratchRoots(): Promise<void> {
  const roots = scratchRoots.splice(0);
  for (const root of roots) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        // Windows can briefly hold file handles open right after an
        // Electron process exits; retry rather than failing cleanup.
        await delay(200);
      }
    }
  }
}

test.afterEach(async () => {
  await cleanupScratchRoots();
});

/**
 * Launches a second instance with `env` and asserts it never stays alive:
 * a losing `app.requestSingleInstanceLock()` calls `app.quit()` immediately,
 * before any window is created. Empirically that usually makes
 * `electron.launch()` itself reject (the child process exits while
 * Playwright is still attaching its CDP session), which this treats as the
 * expected outcome. If `launch()` resolves anyway, the returned app must
 * still close on its own almost immediately - that is asserted via the
 * `close` event (bounded by a timeout), not a fixed sleep, so a genuine
 * failure (the second instance actually staying alive) still fails the test
 * instead of being swallowed.
 */
async function expectSecondInstanceRefused(
  env: Record<string, string>,
  label: string,
): Promise<void> {
  let application: LaunchedApp | undefined;
  try {
    application = await electron.launch({ args: [mainEntry], env });
  } catch (launchError) {
    console.log(
      `[${label}] second launch() rejected before producing a live app: ${String(launchError)}`,
    );
    return;
  }
  try {
    await application.waitForEvent('close', { timeout: 10_000 });
    console.log(
      `[${label}] second instance's launch() resolved, but its process exited (close event) right after.`,
    );
  } finally {
    await application.close().catch(() => {});
  }
}

test.describe('Step 04 storage - Electron-level verification', () => {
  test("A-D: isolates storage, splits visible and technical directories, redirects Electron's paths, and exposes real DPAPI", async () => {
    const profile = createScratchProfile('primary');
    const appRoot = path.join(profile.home, 'etoolbox-daisy');
    const dataRoot = path.join(profile.localAppData, 'etoolbox-daisy');

    // --- A: prove the scratch profile itself never touches the real home,
    // before Electron is even launched. ------------------------------------
    expect(
      profile.root.startsWith(testResultsRoot),
      'scratch profile must live under test-results/, never the real home',
    ).toBe(true);

    const app = await electron.launch({ args: [mainEntry], env: envFor(profile) });
    try {
      await app.firstWindow();

      // --- B: the visible root holds only user-facing data; the technical
      // root (under LOCALAPPDATA) holds the rest ---------------------------
      const visibleDirs = ['settings', 'chats', 'logs'] as const;
      const technicalDirs = ['secrets', 'browser', 'agents', 'tmp'] as const;
      for (const dirPath of [
        ...visibleDirs.map((dir) => path.join(appRoot, dir)),
        ...technicalDirs.map((dir) => path.join(dataRoot, dir)),
      ]) {
        expect(existsSync(dirPath), `expected ${dirPath} to exist`).toBe(true);
        expect(statSync(dirPath).isDirectory(), `expected ${dirPath} to be a directory`).toBe(true);
      }
      for (const technical of ['browser', 'copilot', 'copilot-home', 'tmp', 'window-state.json']) {
        expect(
          existsSync(path.join(appRoot, technical)),
          `technical entry "${technical}" must not live in the user-visible root`,
        ).toBe(false);
      }
      expect(existsSync(path.join(appRoot, 'settings', 'secrets'))).toBe(false);

      // --- C: app.setPath(...) took effect, and stayed inside the scratch
      // tree (the other half of the part-A isolation proof: this is what
      // the running app actually used, not just what we intended). -------
      const electronPaths = await app.evaluate(({ app: electronApp }) => ({
        userData: electronApp.getPath('userData'),
        sessionData: electronApp.getPath('sessionData'),
        temp: electronApp.getPath('temp'),
        logs: electronApp.getPath('logs'),
      }));
      expect(electronPaths.userData).toBe(path.join(dataRoot, 'browser'));
      expect(electronPaths.sessionData).toBe(path.join(dataRoot, 'browser'));
      expect(electronPaths.temp).toBe(path.join(dataRoot, 'tmp'));
      expect(electronPaths.logs).toBe(path.join(appRoot, 'logs'));
      for (const resolved of Object.values(electronPaths)) {
        expect(
          resolved.startsWith(testResultsRoot),
          `Electron path "${resolved}" must resolve inside the test-results scratch tree`,
        ).toBe(true);
      }

      // --- D: real DPAPI-backed safeStorage -------------------------------
      const dpapi = await app.evaluate(({ safeStorage }, canary) => {
        const shape = {
          isEncryptionAvailableIsFunction: typeof safeStorage.isEncryptionAvailable === 'function',
          encryptStringIsFunction: typeof safeStorage.encryptString === 'function',
          decryptStringIsFunction: typeof safeStorage.decryptString === 'function',
        };
        const available = safeStorage.isEncryptionAvailable();
        let roundTripSurvived = false;
        let ciphertextIsBuffer = false;
        let ciphertextContainsPlaintext = false;
        if (available) {
          const ciphertext = safeStorage.encryptString(canary);
          ciphertextIsBuffer = Buffer.isBuffer(ciphertext);
          ciphertextContainsPlaintext = ciphertext.includes(Buffer.from(canary, 'utf8'));
          roundTripSurvived = safeStorage.decryptString(ciphertext) === canary;
        }
        return {
          ...shape,
          available,
          roundTripSurvived,
          ciphertextIsBuffer,
          ciphertextContainsPlaintext,
        };
      }, CANARY);

      console.log(
        `[DPAPI] safeStorage.isEncryptionAvailable() on this machine: ${String(dpapi.available)}`,
      );

      expect(dpapi.isEncryptionAvailableIsFunction).toBe(true);
      expect(dpapi.encryptStringIsFunction).toBe(true);
      expect(dpapi.decryptStringIsFunction).toBe(true);

      // Do NOT make this conditional: an unavailable DPAPI is itself the
      // finding to report, never a reason to skip or weaken the assertion.
      expect(
        dpapi.available,
        'electron.safeStorage must report Windows-DPAPI encryption as available on this machine',
      ).toBe(true);

      expect(dpapi.roundTripSurvived).toBe(true);
      expect(dpapi.ciphertextIsBuffer).toBe(true);
      expect(dpapi.ciphertextContainsPlaintext).toBe(false);
    } finally {
      await app.close();
    }
  });

  test.describe('E: single-instance investigation', () => {
    test('a second launch against the SAME storage root is refused and does not disturb the primary window', async () => {
      const profile = createScratchProfile('single-same');
      const primary = await electron.launch({ args: [mainEntry], env: envFor(profile) });
      try {
        await primary.firstWindow();

        await expectSecondInstanceRefused(envFor(profile), 'same-storage-root');

        // The primary must still be alive and responsive, not merely "some
        // window handle object still exists in this process".
        const stillPresent = await primary.firstWindow();
        expect(Boolean(stillPresent)).toBe(true);
        const name = await primary.evaluate(({ app: electronApp }) => electronApp.getName());
        expect(name).toBe('EToolbox Daisy');
      } finally {
        await primary.close();
      }
    });

    test('investigation: two DIFFERENT scratch USERPROFILE values with the SAME LOCALAPPDATA conflict', async () => {
      // The single-instance lock follows the setPath'd userData, which now
      // lives under LOCALAPPDATA. Vary ONLY USERPROFILE/HOME (the visible
      // root), holding APPDATA/LOCALAPPDATA identical: both launches share one
      // userData, so the second is refused.
      const profileA = createScratchProfile('diff-home-a');
      const profileB = createScratchProfile('diff-home-b');
      const sharedAppData = { appData: profileA.appData, localAppData: profileA.localAppData };

      const appA = await electron.launch({
        args: [mainEntry],
        env: envFor(profileA, sharedAppData),
      });
      try {
        await appA.firstWindow();

        await expectSecondInstanceRefused(envFor(profileB, sharedAppData), 'diff-home-same-local');
        console.log(
          '[diff-home, same-localappdata] second instance was refused: the single-instance ' +
            "lock follows the technical root (setPath'd userData under LOCALAPPDATA), not the visible home root.",
        );
      } finally {
        await appA.close();
      }
    });

    test('investigation: the SAME home with a DIFFERENT LOCALAPPDATA does NOT conflict', async () => {
      // The complementary half: hold USERPROFILE/HOME fixed and vary only
      // APPDATA/LOCALAPPDATA. The technical roots (and so the userData lock)
      // differ, so the second instance gets its own window.
      const profile = createScratchProfile('same-home-diff-appdata');
      const altAppData = createScratchProfile('same-home-diff-appdata-alt');

      const primary = await electron.launch({ args: [mainEntry], env: envFor(profile) });
      try {
        await primary.firstWindow();

        const secondEnv = envFor(profile, {
          appData: altAppData.appData,
          localAppData: altAppData.localAppData,
        });
        let second: LaunchedApp | undefined;
        try {
          second = await electron.launch({ args: [mainEntry], env: secondEnv });
          expect(Boolean(await second.firstWindow())).toBe(true);
          console.log(
            '[same-home, diff-localappdata] second instance got its OWN window: the lock ' +
              'follows the technical root, not the visible home root.',
          );
        } finally {
          await second?.close().catch(() => {});
        }
      } finally {
        await primary.close();
      }
    });
  });
});
