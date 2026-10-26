import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  discoverLocalClis,
  type DiscoveryEnvironment,
  type DiscoveryFileSystem,
} from '../../../../../src/agents/copilot/cli/discovery';

/**
 * Discovery is "which of the machine's own CLIs may we spawn". The rules that
 * matter: a known root beats `PATH`, a launcher is resolved through and never
 * returned, and the same real file is never reported twice.
 */

const win = path.win32;

const HOME = win.join('C:', 'Users', 'me');
const LOCAL_APPDATA = win.join(HOME, 'AppData', 'Local');
const PROGRAM_FILES = win.join('C:', 'Program Files');
const APPDATA = win.join(HOME, 'AppData', 'Roaming');
const TOOLS = win.join('C:', 'Tools');

function environment(overrides: Partial<DiscoveryEnvironment> = {}): DiscoveryEnvironment {
  return {
    platform: 'win32',
    arch: 'x64',
    homeDir: HOME,
    env: {
      LOCALAPPDATA: LOCAL_APPDATA,
      ProgramFiles: PROGRAM_FILES,
      APPDATA,
      PATH: '',
    },
    ...overrides,
  };
}

/** A filesystem holding exactly `files`, with `links` pointing elsewhere. */
function fileSystem(
  files: readonly string[],
  links: Readonly<Record<string, string>> = {},
): DiscoveryFileSystem {
  // Compare by a platform-neutral key: the tests simulate both flavours on one
  // host, so `\` and `/` must not decide a match.
  const key = (candidate: string): string => candidate.replace(/\\/g, '/').toLowerCase();
  const present = new Set(files.map(key));
  const targets = new Map(Object.entries(links).map(([from, to]) => [key(from), to]));
  return {
    isFile: (candidate) => present.has(key(candidate)),
    isDirectory: () => false,
    realpath: (candidate) => targets.get(key(candidate)) ?? candidate,
  };
}

const PROGRAM_FILES_CLI = win.join(PROGRAM_FILES, 'GitHub Copilot', 'copilot.exe');

describe('discoverLocalClis on Windows', () => {
  it('finds the standalone installer copy', () => {
    const found = discoverLocalClis(environment(), fileSystem([PROGRAM_FILES_CLI]));

    expect(found).toEqual([{ path: PROGRAM_FILES_CLI, origin: 'known-root' }]);
  });

  it('accepts an executable a PATH entry holds directly', () => {
    const binary = win.join(TOOLS, 'copilot.exe');
    const found = discoverLocalClis(
      environment({ env: { ...environment().env, PATH: TOOLS } }),
      fileSystem([binary]),
    );

    expect(found).toEqual([{ path: binary, origin: 'path' }]);
  });

  it('resolves an npm shim through to the platform package instead of running it', () => {
    const npmBin = win.join('D:', 'npm');
    const shim = win.join(npmBin, 'copilot.cmd');
    const binary = win.join(npmBin, 'node_modules', '@github', 'copilot-win32-x64', 'copilot.exe');
    const found = discoverLocalClis(
      environment({ env: { ...environment().env, PATH: npmBin } }),
      fileSystem([shim, binary]),
    );

    expect(found).toEqual([{ path: binary, origin: 'path' }]);
    expect(found.map((candidate) => candidate.path)).not.toContain(shim);
  });

  it('reports the same real file only once, whichever hint found it', () => {
    const link = win.join(LOCAL_APPDATA, 'Microsoft', 'WinGet', 'Links', 'copilot.exe');
    const found = discoverLocalClis(
      environment(),
      fileSystem([link, PROGRAM_FILES_CLI], { [link]: PROGRAM_FILES_CLI }),
    );

    expect(found).toEqual([{ path: PROGRAM_FILES_CLI, origin: 'known-root' }]);
  });

  it('finds nothing when the machine has none', () => {
    expect(discoverLocalClis(environment(), fileSystem([]))).toEqual([]);
  });
});

describe('discoverLocalClis on macOS', () => {
  const darwin = environment({
    platform: 'darwin',
    homeDir: '/Users/me',
    env: { PATH: '/usr/bin:/usr/local/bin' },
  });

  it('finds Homebrew’s copy', () => {
    const found = discoverLocalClis(darwin, fileSystem(['/opt/homebrew/bin/copilot']));

    expect(found).toEqual([{ path: '/opt/homebrew/bin/copilot', origin: 'known-root' }]);
  });

  it('resolves the npm loader symlink through to the package binary', () => {
    const prefix = '/Users/me/.nvm/versions/node/v22';
    const loader = `${prefix}/lib/node_modules/@github/copilot/npm-loader.js`;
    const binary = `${prefix}/lib/node_modules/@github/copilot-darwin-x64/copilot`;
    const found = discoverLocalClis(
      environment({
        platform: 'darwin',
        homeDir: '/Users/me',
        env: { PATH: `${prefix}/bin:/usr/bin` },
      }),
      fileSystem([`${prefix}/bin/copilot`, loader, binary], {
        [`${prefix}/bin/copilot`]: loader,
      }),
    );

    expect(found.map((candidate) => candidate.path)).toEqual([binary]);
  });
});

describe('discoverLocalClis on another platform', () => {
  it('finds nothing rather than guessing', () => {
    expect(
      discoverLocalClis(environment({ platform: 'linux' }), fileSystem([PROGRAM_FILES_CLI])),
    ).toEqual([]);
  });
});
