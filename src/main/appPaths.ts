import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Name of both application directories (docs/requirements-decisions.md §8).
 * Application data is split in two so the folder a user is invited to open
 * holds only what they may read or edit:
 *
 * - `<home>/etoolbox-daisy` - the *visible* root: settings, chat history, logs
 *   (and, later, the user's own skills and instructions);
 * - `%LOCALAPPDATA%\etoolbox-daisy` (Windows; `~/Library/Application Support/`
 *   on macOS, `$XDG_DATA_HOME` or `~/.local/share/` elsewhere) - the *technical*
 *   root: browser profile and
 *   cache, agent runtime state, encrypted secrets, window geometry, scratch.
 *   Local, not Roaming: the profile is large, and the DPAPI secrets and
 *   Chromium's cookie key are bound to this user on this machine.
 */
const APP_DIR_NAME = 'etoolbox-daisy';

/**
 * Every path this application writes to. This shape is public:
 * `settingsStore`, `secretStore`, and `logger` all consume it directly, so its
 * fields must stay stable once those modules depend on it.
 */
export interface AppPaths {
  /** `<home>/etoolbox-daisy` - the user-visible root. */
  readonly root: string;
  /** Versioned, atomically-written settings - owned by `settingsStore`. */
  readonly settings: string;
  /** Chat history - intentionally separate from settings/logs (plan step 04). */
  readonly chats: string;
  /** The user's own skills, one folder per skill - read at startup (docs/skill-subsystem-plan.md). */
  readonly skills: string;
  /** The user's own rules, one `.md` file per rule - read at startup. */
  readonly rules: string;
  /** Self-learning memos, one `.md` file per lesson - read fresh, written by the `memo` tool. */
  readonly memos: string;
  /** Diagnostic logs only: codes/timings/IDs, never prompts/payloads/secrets. */
  readonly logs: string;
  /** `%LOCALAPPDATA%\etoolbox-daisy` - the technical root nobody needs to open. */
  readonly dataRoot: string;
  /** DPAPI-encrypted secrets - owned by `secretStore`. */
  readonly secrets: string;
  /**
   * The main window's persisted geometry file. A file, not a directory:
   * unlike the storage roots it is written directly by `windowState.ts` (see
   * that module for why it is not part of the settings document).
   */
  readonly windowState: string;
  /** Chromium/Electron browser-session data (`userData`/`sessionData`). */
  readonly browser: string;
  /**
   * Parent of every agent's own state directory (`<agents>/<agentId>`, handed
   * to an agent as `AgentHost.stateDirectory`).
   */
  readonly agents: string;
  /** Scratch/temporary files. */
  readonly tmp: string;
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
 * Resolves the parent of the technical root: the per-user, per-machine, local
 * (never roaming) application-data directory of the platform.
 *
 * - Windows: `%LOCALAPPDATA%` (an unset value is an explicit failure; Electron
 *   itself would not start without it);
 * - macOS: `~/Library/Application Support`;
 * - elsewhere: `$XDG_DATA_HOME` when it is set to an absolute path, otherwise
 *   `~/.local/share`.
 *
 * Environment, platform and home are parameters with real defaults, for the
 * same reason as {@link getOsHomeDirectory}: no Electron `app` is needed, so
 * every platform's rule is unit tested on any machine.
 */
export function getLocalDataDirectory(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: () => string = getOsHomeDirectory,
): string {
  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'];
    if (localAppData === undefined) {
      throw new Error(
        'Cannot resolve application paths: LOCALAPPDATA is not set. Refusing to fall back to ' +
          'the current working directory or a temporary directory',
      );
    }
    return localAppData;
  }
  if (platform === 'darwin') {
    return path.join(homeDir(), 'Library', 'Application Support');
  }
  const xdgDataHome = env['XDG_DATA_HOME'];
  if (xdgDataHome !== undefined && path.isAbsolute(xdgDataHome)) {
    return xdgDataHome;
  }
  return path.join(homeDir(), '.local', 'share');
}

function assertAbsoluteDirectory(label: string, directory: string): void {
  if (directory.trim().length === 0) {
    throw new Error(
      `Cannot resolve application paths: the ${label} is empty or blank. Refusing to ` +
        'fall back to the current working directory or a temporary directory',
    );
  }
  if (!path.isAbsolute(directory)) {
    throw new Error(
      `Cannot resolve application paths: ${label} "${directory}" is not an absolute path. ` +
        'Refusing to fall back to the current working directory or a temporary directory',
    );
  }
}

/**
 * Derives both application roots and their fixed subdirectories from the home
 * and local-data directories. Pure: touches no filesystem, imports no
 * Electron API, and can be exercised directly with plain vitest.
 *
 * Both arguments must be non-empty, absolute paths. Anything else throws
 * instead of substituting `process.cwd()`, `os.tmpdir()`, or `.` - writing app
 * data to the wrong place is worse than failing loudly at startup.
 */
export function resolveAppPaths(homeDir: string, localDataDir: string): AppPaths {
  assertAbsoluteDirectory('home directory', homeDir);
  assertAbsoluteDirectory('local data directory', localDataDir);

  const root = path.join(homeDir, APP_DIR_NAME);
  const dataRoot = path.join(localDataDir, APP_DIR_NAME);
  return {
    root,
    settings: path.join(root, 'settings'),
    chats: path.join(root, 'chats'),
    skills: path.join(root, 'skills'),
    rules: path.join(root, 'rules'),
    memos: path.join(root, 'memos'),
    logs: path.join(root, 'logs'),
    dataRoot,
    secrets: path.join(dataRoot, 'secrets'),
    windowState: path.join(dataRoot, 'window-state.json'),
    browser: path.join(dataRoot, 'browser'),
    agents: path.join(dataRoot, 'agents'),
    tmp: path.join(dataRoot, 'tmp'),
  };
}

/**
 * Creates both roots and their subdirectories if they do not already exist.
 * Idempotent: `fs.mkdirSync(..., { recursive: true })` is a no-op when a
 * directory is already present (it does not throw `EEXIST`), so calling this
 * on every launch of the primary instance is safe.
 */
export function ensureAppDirectories(paths: AppPaths): void {
  const directories: readonly string[] = [
    paths.root,
    paths.settings,
    paths.chats,
    paths.skills,
    paths.logs,
    paths.dataRoot,
    paths.secrets,
    paths.browser,
    paths.agents,
    paths.tmp,
  ];
  for (const dir of directories) {
    mkdirSync(dir, { recursive: true });
  }
}
