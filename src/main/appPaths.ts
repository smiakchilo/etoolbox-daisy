import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Name of the application's root directory, created directly under the
 * current user's home directory (docs/requirements-decisions.md §8: "Use an
 * `etoolbox-daisy` directory under the current user's home for settings,
 * history, runtime state, browser data, and temporary files.").
 */
const APP_DIR_NAME = 'etoolbox-daisy';

/**
 * Every path this application writes to, rooted at `<home>/etoolbox-daisy`.
 * This shape is public: `settingsStore`, `secretStore`, and `logger` (built
 * alongside this module in implementation-plan.md step 04) all consume it
 * directly, so its fields must stay stable once those modules depend on it.
 */
export interface AppPaths {
  /** `<home>/etoolbox-daisy` */
  readonly root: string;
  /** Versioned, atomically-written settings - owned by `settingsStore`. */
  readonly settings: string;
  /** Chromium/Electron browser-session data (`userData`/`sessionData`). */
  readonly browser: string;
  /** GitHub Copilot SDK/agent runtime state. */
  readonly copilot: string;
  /** Chat history - intentionally separate from settings/logs (plan step 04). */
  readonly chats: string;
  /** Scratch/temporary files. */
  readonly tmp: string;
  /** Diagnostic logs only: codes/timings/IDs, never prompts/payloads/secrets. */
  readonly logs: string;
}

/**
 * Resolves the current OS user's home directory.
 *
 * Uses Node's `os.homedir()` rather than Electron's `app.getPath("home")`.
 * On Windows both ultimately resolve the same user profile directory, but
 * `os.homedir()` does not depend on a running Electron `app` instance - that
 * is what lets this decision, and every other path in this module, be
 * unit tested with plain vitest and no Electron.
 *
 * Per Node's docs, `os.homedir()` throws instead of returning a fallback
 * value when it cannot determine a home directory; that exception is left
 * to propagate here rather than caught and papered over, matching the
 * requirement that an unusable home directory is an explicit failure, never
 * a silent `process.cwd()` / `os.tmpdir()` / `.` fallback.
 */
export function getOsHomeDirectory(): string {
  return homedir();
}

/**
 * Derives the app's root directory and its six fixed subdirectories from a
 * home directory. Pure: touches no filesystem, imports no Electron API, and
 * can be exercised directly with plain vitest.
 *
 * `homeDir` must be a non-empty, absolute path. Anything else throws instead
 * of substituting `process.cwd()`, `os.tmpdir()`, or `.` - writing app data
 * to the wrong place is worse than failing loudly at startup.
 */
export function resolveAppPaths(homeDir: string): AppPaths {
  if (homeDir.trim().length === 0) {
    throw new Error(
      'Cannot resolve application paths: the home directory is empty or blank. Refusing to ' +
        'fall back to the current working directory or a temporary directory.',
    );
  }
  if (!path.isAbsolute(homeDir)) {
    throw new Error(
      `Cannot resolve application paths: home directory "${homeDir}" is not an absolute path. ` +
        'Refusing to fall back to the current working directory or a temporary directory.',
    );
  }

  const root = path.join(homeDir, APP_DIR_NAME);
  return {
    root,
    settings: path.join(root, 'settings'),
    browser: path.join(root, 'browser'),
    copilot: path.join(root, 'copilot'),
    chats: path.join(root, 'chats'),
    tmp: path.join(root, 'tmp'),
    logs: path.join(root, 'logs'),
  };
}

/**
 * Creates `paths.root` and its six subdirectories if they do not already
 * exist. Idempotent: `fs.mkdirSync(..., { recursive: true })` is a no-op
 * when a directory is already present (it does not throw `EEXIST`), so
 * calling this on every launch of the primary instance is safe.
 */
export function ensureAppDirectories(paths: AppPaths): void {
  const directories: readonly string[] = [
    paths.root,
    paths.settings,
    paths.browser,
    paths.copilot,
    paths.chats,
    paths.tmp,
    paths.logs,
  ];
  for (const dir of directories) {
    mkdirSync(dir, { recursive: true });
  }
}
