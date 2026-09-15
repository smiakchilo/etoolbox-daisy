import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The pieces of Electron/Node state path resolution actually needs, kept as a
 * plain parameter object (instead of importing `electron` here) so this
 * module can be unit tested without a running Electron process and so it
 * stays trivially injectable from `src/main`.
 */
export interface RuntimePathsEnv {
  /** `app.isPackaged` */
  readonly isPackaged: boolean;
  /** `process.resourcesPath` (only read when `isPackaged`). */
  readonly resourcesPath: string;
  /** Project root in dev (only read when not `isPackaged`). */
  readonly devRootDir: string;
}

const SDK_PLATFORM_PACKAGE = '@github/copilot-sdk-win32-x64';
const CLI_PLATFORM_PACKAGE = '@github/copilot-win32-x64';
const RUNTIME_EXE_SEGMENTS = ['prebuilds', 'win32-x64', 'copilot-runtime.exe'];
const CLI_EXE_SEGMENTS = ['copilot.exe'];

/**
 * Directory a platform package's payload lives in, in both dev and packaged
 * builds.
 *
 * - Dev: `node_modules/<package>` under the project root, resolved the
 *   ordinary way.
 * - Packaged: electron-builder auto-unpacks these packages from the asar
 *   because they contain native `.node` files (verified empirically during
 *   this step - see docs/verification.md Step 02), placing them at
 *   `resources/app.asar.unpacked/node_modules/<package>`. That path is a real
 *   file on disk, not a virtual asar path, so `existsSync`/`spawn` work on it
 *   normally.
 */
export function resolvePlatformPackageDir(packageName: string, env: RuntimePathsEnv): string {
  const segments = packageName.split('/');
  if (env.isPackaged) {
    return path.join(env.resourcesPath, 'app.asar.unpacked', 'node_modules', ...segments);
  }
  return path.join(env.devRootDir, 'node_modules', ...segments);
}

function resolveExePath(packageName: string, exeSegments: string[], env: RuntimePathsEnv): string {
  const dir = resolvePlatformPackageDir(packageName, env);
  const exePath = path.join(dir, ...exeSegments);
  if (!existsSync(exePath)) {
    throw new Error(
      `Expected executable not found at "${exePath}". This means the "${packageName}" ` +
        "payload is missing or was trimmed too aggressively by electron-builder's " +
        'files/asarUnpack configuration.',
    );
  }
  return exePath;
}

/** Resolves the absolute path to the bundled `copilot-runtime.exe` (the SDK's runtime). */
export function resolveSdkRuntimeExePath(env: RuntimePathsEnv): string {
  return resolveExePath(SDK_PLATFORM_PACKAGE, RUNTIME_EXE_SEGMENTS, env);
}

/** Resolves the absolute path to the bundled `copilot.exe` (the CLI, used only for `login`). */
export function resolveCliExePath(env: RuntimePathsEnv): string {
  return resolveExePath(CLI_PLATFORM_PACKAGE, CLI_EXE_SEGMENTS, env);
}

/**
 * Directory holding the application's own skills.
 *
 * Shipped as an electron-builder `extraResources` entry so it stays a plain
 * directory on disk (the runtime reads `SKILL.md` files itself and cannot see
 * inside an asar archive), and so it is never confused with the user's own
 * `~/.copilot/skills`. The `extraResources` mapping is `resources -> resources`,
 * hence the nested segment in the packaged branch.
 */
export function resolveBundledSkillsDir(env: RuntimePathsEnv): string {
  const dir = env.isPackaged
    ? path.join(env.resourcesPath, 'resources', 'skills')
    : path.join(env.devRootDir, 'resources', 'skills');
  if (!existsSync(dir)) {
    throw new Error(
      `Bundled skills directory not found at "${dir}". It ships via the ` +
        'electron-builder extraResources entry for resources/skills.',
    );
  }
  return dir;
}
