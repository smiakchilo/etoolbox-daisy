import path from 'node:path';

/**
 * Where a Copilot CLI already installed on this machine may be.
 *
 * The CLI is GitHub's release channel and nobody ships it for us, so the first
 * rung of the resolver is "use what the user already has". That
 * means discovering candidate paths deterministically:
 *
 * - a fixed list of known install roots (the npm platform package, the
 *   standalone installers, Homebrew), then
 * - every `PATH` entry, in order.
 *
 * A `PATH` hit is a *hint*: on Windows it is normally `copilot.cmd` and on
 * macOS a symlink to the npm loader, neither of which can be spawned with
 * `shell: false` (and neither of which we would want to execute). Those are
 * resolved through to the platform package's binary instead of being run.
 *
 * Path arithmetic uses the *simulated* platform's flavour (`path.win32` /
 * `path.posix`), not the host's, so every rule below is exercised on any
 * machine. Pure: every filesystem answer arrives through
 * {@link DiscoveryFileSystem}.
 */

export interface DiscoveryFileSystem {
  isFile(candidate: string): boolean;
  isDirectory(candidate: string): boolean;
  /** Absolute target of a link, or the path itself. May throw for a missing path. */
  realpath(candidate: string): string;
}

export interface DiscoveryEnvironment {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
}

/** Scripts and launchers: never spawned, always resolved through. */
const SHIM_SUFFIXES = ['.cmd', '.bat', '.ps1', '.js', '.mjs', '.cjs'] as const;

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function cliExecutableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'copilot.exe' : 'copilot';
}

function packageName(environment: DiscoveryEnvironment): string {
  return `copilot-${environment.platform}-${environment.arch}`;
}

/** The npm platform package's binary, given a directory holding `node_modules`. */
function packageBinary(directory: string, environment: DiscoveryEnvironment): string {
  return pathFor(environment.platform).join(
    directory,
    'node_modules',
    '@github',
    packageName(environment),
    cliExecutableName(environment.platform),
  );
}

/**
 * Directories that hold the executable itself. Only the platforms this
 * application ships for; anywhere else there is nothing to find, and the
 * resolver falls through to its download rung.
 */
export function knownInstallRoots(environment: DiscoveryEnvironment): readonly string[] {
  const { platform, env, homeDir } = environment;
  const joined = (...segments: string[]): string => pathFor(platform).join(...segments);
  if (platform === 'win32') {
    return [
      ...(env['LOCALAPPDATA'] === undefined
        ? []
        : [joined(env['LOCALAPPDATA'], 'Programs', 'GitHub Copilot')]),
      ...(env['ProgramFiles'] === undefined ? [] : [joined(env['ProgramFiles'], 'GitHub Copilot')]),
      ...(env['ProgramFiles(x86)'] === undefined
        ? []
        : [joined(env['ProgramFiles(x86)'], 'GitHub Copilot')]),
      ...(env['APPDATA'] === undefined
        ? []
        : [joined(env['APPDATA'], 'npm', 'node_modules', '@github', packageName(environment))]),
      // WinGet installs a link/shim here that points at the package binary.
      ...(env['LOCALAPPDATA'] === undefined
        ? []
        : [joined(env['LOCALAPPDATA'], 'Microsoft', 'WinGet', 'Links')]),
    ];
  }
  if (platform === 'darwin') {
    return [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      joined(homeDir, '.local', 'bin'),
      joined(homeDir, '.npm-global', 'bin'),
      joined('/usr/local/lib', 'node_modules', '@github', packageName(environment)),
      joined('/opt/homebrew/lib', 'node_modules', '@github', packageName(environment)),
    ];
  }
  return [];
}

function isShim(candidate: string): boolean {
  const lower = candidate.toLowerCase();
  return SHIM_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** Whether this path is a program we may spawn directly. */
export function isRunnableBinary(candidate: string, platform: NodeJS.Platform): boolean {
  if (isShim(candidate)) return false;
  return platform === 'win32' ? candidate.toLowerCase().endsWith('.exe') : true;
}

/** Every `PATH` entry, in order; `Path` and `PATH` are both seen on Windows. */
function pathEntries(environment: DiscoveryEnvironment): readonly string[] {
  const raw = environment.env['PATH'] ?? environment.env['Path'] ?? '';
  return raw
    .split(pathFor(environment.platform).delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Turns a launcher into the real platform binary, when the launcher's location
 * makes that derivable. Covers the two shapes we meet in practice:
 *
 * - `%APPDATA%\npm\copilot.cmd` (npm's Windows shim) - the packages live in
 *   `%APPDATA%\npm\node_modules`;
 * - `/usr/local/bin/copilot` -> `.../lib/node_modules/@github/copilot/npm-loader.js`
 *   (npm's POSIX shim) - the packages sit beside that `node_modules`.
 */
function throughShim(shimPath: string, environment: DiscoveryEnvironment): readonly string[] {
  const platformPath = pathFor(environment.platform);
  const derived = [packageBinary(platformPath.dirname(shimPath), environment)];
  // `<prefix>/lib/node_modules/@github/copilot/npm-loader.js`
  const segments = shimPath.split(platformPath.sep);
  const nodeModulesIndex = segments.lastIndexOf('node_modules');
  if (nodeModulesIndex > 0) {
    // `packageBinary` appends `node_modules` itself, so stop before it.
    const prefixRoot = segments.slice(0, nodeModulesIndex).join(platformPath.sep);
    derived.push(packageBinary(prefixRoot, environment));
  }
  return derived;
}

export interface DiscoveredCli {
  /** An absolute path to a regular executable file. */
  readonly path: string;
  /** Where the hint came from, for the log line. */
  readonly origin: 'known-root' | 'path';
}

/**
 * Candidate executables, in discovery order, de-duplicated by their real path.
 * Nothing is executed here - the resolver probes each one with `--version` and
 * keeps only those that answer.
 */
export function discoverLocalClis(
  environment: DiscoveryEnvironment,
  fileSystem: DiscoveryFileSystem,
): readonly DiscoveredCli[] {
  const joined = (...segments: string[]): string => pathFor(environment.platform).join(...segments);
  const executable = cliExecutableName(environment.platform);
  const found: DiscoveredCli[] = [];
  const seen = new Set<string>();

  const consider = (candidate: string, origin: DiscoveredCli['origin']): void => {
    if (!fileSystem.isFile(candidate)) return;
    let identity = candidate;
    try {
      identity = fileSystem.realpath(candidate);
    } catch {
      // A broken link is not a candidate; `isFile` said it existed, so keep the
      // literal path as its identity rather than dropping it.
    }
    // A launcher - by its own name or by the file it links to - is resolved
    // through to the binary it would run, and never executed.
    if (isShim(candidate) || isShim(identity)) {
      for (const derived of throughShim(isShim(identity) ? identity : candidate, environment)) {
        consider(derived, origin);
      }
      return;
    }
    if (!isRunnableBinary(identity, environment.platform)) return;
    if (seen.has(identity)) return;
    seen.add(identity);
    found.push({ path: identity, origin });
  };

  for (const root of knownInstallRoots(environment)) {
    consider(joined(root, executable), 'known-root');
    // A known root may itself hold an npm prefix rather than the binary.
    consider(
      joined(root, `copilot${environment.platform === 'win32' ? '.cmd' : ''}`),
      'known-root',
    );
  }
  for (const entry of pathEntries(environment)) {
    for (const name of [executable, 'copilot.exe', 'copilot.cmd', 'copilot']) {
      consider(joined(entry, name), 'path');
    }
  }
  return found;
}
