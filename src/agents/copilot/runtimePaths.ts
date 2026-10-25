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
  /** `process.platform`; defaults to the running process's. Injectable for tests. */
  readonly platform?: NodeJS.Platform;
  /** `process.arch`; defaults to the running process's. Injectable for tests. */
  readonly arch?: string;
}

/** Where a platform's Copilot payload lives and what its executable is called. */
interface PlatformLayout {
  readonly sdkPackage: string;
  readonly runtimeSegments: string[];
}

function resolvePlatformLayout(env: RuntimePathsEnv): PlatformLayout {
  const platform = env.platform ?? process.platform;
  const arch = env.arch ?? process.arch;
  const suffix = `${platform}-${arch}`;
  if (suffix !== 'win32-x64' && suffix !== 'darwin-x64' && suffix !== 'darwin-arm64') {
    throw new Error(`The Copilot runtime is not bundled for ${suffix}`);
  }
  const exe = platform === 'win32' ? '.exe' : '';
  return {
    sdkPackage: `@github/copilot-sdk-${suffix}`,
    runtimeSegments: ['prebuilds', suffix, `copilot-runtime${exe}`],
  };
}

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
        'files/asarUnpack configuration',
    );
  }
  return exePath;
}

/** Resolves the absolute path to the bundled `copilot-runtime` executable (the SDK's runtime). */
export function resolveSdkRuntimeExePath(env: RuntimePathsEnv): string {
  const layout = resolvePlatformLayout(env);
  return resolveExePath(layout.sdkPackage, layout.runtimeSegments, env);
}

/**
 * The nearest ancestor of `start` holding a `package.json`, else `start`. The
 * dev-mode runtime lives under the project's `node_modules`; the bundled
 * module's depth below `out/main` is a bundler detail, so it is searched for
 * rather than counted.
 */
export function findProjectRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}
