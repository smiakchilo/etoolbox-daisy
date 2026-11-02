import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createScratchDirs } from '../../../support/scratchDirs';

const spawn = vi.hoisted(() => vi.fn());
const unref = vi.hoisted(() => vi.fn());
const on = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn }));

const {
  bundledInstallScript,
  installScriptName,
  installedAppFolder,
  startUpdateScript,
  windowsPowerShellPath,
} = await import('../../../../src/main/updates/scriptRunner');

const scratch = createScratchDirs('script-runner', 'script-runner-');

beforeEach(() => {
  spawn.mockReset();
  unref.mockReset();
  on.mockReset();
  spawn.mockReturnValue({ unref, on });
});

/** The hidden command a Windows launch runs: PowerShell -EncodedCommand, decoded. */
function windowsCommand(): string {
  const [command, args] = spawn.mock.calls[0] as [string, string[]];
  expect(command).toMatch(/powershell\.exe$/i);
  const index = args.indexOf('-EncodedCommand');
  expect(index).toBeGreaterThanOrEqual(0);
  return Buffer.from(args[index + 1] ?? '', 'base64').toString('utf16le');
}

describe('install script location', () => {
  it('names the script after the platform', () => {
    expect(installScriptName('win32')).toMatch(/\.cmd$/);
    expect(installScriptName('darwin')).toMatch(/\.command$/);
  });

  it('looks for the script in the bundled install folder', () => {
    const resources = path.join('app', 'resources');
    expect(bundledInstallScript(resources, 'win32')).toBe(
      path.join(resources, 'install', installScriptName('win32')),
    );
  });

  it('treats the executable folder as the Windows install', () => {
    const exe = path.join('apps', 'daisy', 'EToolbox Daisy.exe');
    expect(installedAppFolder(exe, 'win32')).toBe(path.join('apps', 'daisy'));
  });

  it('treats the folder holding the .app bundle as the Mac install', () => {
    const exe = path.join('apps', 'daisy', 'Daisy.app', 'Contents', 'MacOS', 'Daisy');
    expect(installedAppFolder(exe, 'darwin')).toBe(path.join('apps', 'daisy'));
  });
});

describe('startUpdateScript', () => {
  function options(platform: 'darwin' | 'win32') {
    const root = scratch.create();
    const bundledScript = path.join(root, installScriptName(platform));
    writeFileSync(bundledScript, 'original script');
    return {
      bundledScript,
      source: 'master',
      appFolder: path.join(root, 'app'),
      pid: 4242,
      statusFile: path.join(root, 'status.txt'),
      env: { HTTPS_PROXY: 'http://proxy.test:3128' },
      platform,
      scratchDirectory: path.join(root, 'scratch'),
    };
  }

  it('runs a copy of the script so the installed one can be replaced', () => {
    const given = options('darwin');
    startUpdateScript(given);
    const args = spawn.mock.calls[0]?.[1] as string[];
    const copy = args[0] ?? '';
    expect(copy).not.toBe(given.bundledScript);
    expect(existsSync(copy)).toBe(true);
    expect(readFileSync(copy, 'utf8')).toBe('original script');
  });

  it('hands the script the update mode, source, folder, pid and status file', () => {
    const given = options('darwin');
    startUpdateScript(given);
    const [command, args, spawnOptions] = spawn.mock.calls[0] as [
      string,
      string[],
      { detached: boolean; env: Record<string, string> },
    ];
    expect(command).toMatch(/bash$/);
    expect(args.slice(1)).toEqual([
      '--update',
      given.source,
      given.appFolder,
      '4242',
      given.statusFile,
    ]);
    expect(spawnOptions.detached).toBe(true);
    expect(spawnOptions.env['HTTPS_PROXY']).toBe('http://proxy.test:3128');
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('quotes every Windows argument into the hidden command line', () => {
    const given = options('win32');
    startUpdateScript(given);
    const decoded = windowsCommand();
    expect(decoded).toContain(`"${given.appFolder}"`);
    expect(decoded).toContain(`"${given.statusFile}"`);
    expect(decoded).toContain('"--update"');
    expect(decoded).toContain(`"${given.source}"`);
    expect(decoded).toContain('"4242"');
  });

  it('starts the Windows script in a hidden window that outlives this app', () => {
    // Measured on Windows: a `detached` child gets a *visible* console however
    // `windowsHide` is set (closing it aborts the build, and QuickEdit freezes the
    // script), while a non-detached one is killed when the app quits (the script
    // died right after writing "ready", so nothing was ever swapped). The launch
    // therefore goes through a throwaway hidden PowerShell that starts cmd with
    // SW_HIDE; that cmd belongs to nobody and survives.
    const given = options('win32');
    startUpdateScript(given);
    const [, , spawnOptions] = spawn.mock.calls[0] as [
      string,
      string[],
      { detached: boolean; windowsHide: boolean },
    ];
    expect(spawnOptions.windowsHide).toBe(true);
    expect(spawnOptions.detached).toBe(false);
    const decoded = windowsCommand();
    expect(decoded).toMatch(/Start-Process .*cmd\.exe/);
    expect(decoded).toContain('-WindowStyle Hidden');
  });

  it('refuses to start when Windows PowerShell is missing', () => {
    const given = {
      ...options('win32'),
      env: { SystemRoot: path.join('C:', 'no-such-windows') },
    };
    expect(() => startUpdateScript(given)).toThrow(/PowerShell/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('strips double quotes from arguments instead of letting them break out', () => {
    const given = { ...options('win32'), source: 'a" & calc & "b' };
    startUpdateScript(given);
    const decoded = windowsCommand();
    expect(decoded).not.toContain('a" &');
    expect(decoded).toContain('"a & calc & b"');
  });
});

describe('windowsPowerShellPath', () => {
  it('names the Windows PowerShell inside SystemRoot', () => {
    expect(windowsPowerShellPath({ SystemRoot: 'C:\\Windows' })).toBe(
      path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    );
  });

  it('falls back to the bare name when SystemRoot is not set', () => {
    expect(windowsPowerShellPath({})).toBe('powershell.exe');
    expect(windowsPowerShellPath({ SystemRoot: '' })).toBe('powershell.exe');
  });
});
