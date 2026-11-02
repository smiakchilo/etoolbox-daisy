import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createScratchDirs } from '../../../support/scratchDirs';

const spawn = vi.hoisted(() => vi.fn());
const unref = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn }));

const { bundledInstallScript, installScriptName, installedAppFolder, startUpdateScript } =
  await import('../../../../src/main/updates/scriptRunner');

const scratch = createScratchDirs('script-runner', 'script-runner-');

beforeEach(() => {
  spawn.mockReset();
  unref.mockReset();
  spawn.mockReturnValue({ unref });
});

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

  it('runs the Windows script through cmd with every argument quoted', () => {
    const given = options('win32');
    startUpdateScript(given);
    const [command, args, spawnOptions] = spawn.mock.calls[0] as [
      string,
      string[],
      { windowsVerbatimArguments: boolean },
    ];
    expect(command).toMatch(/cmd\.exe$/);
    expect(spawnOptions.windowsVerbatimArguments).toBe(true);
    const line = args[args.length - 1] ?? '';
    expect(line).toContain(`"${given.appFolder}"`);
    expect(line).toContain(`"${given.statusFile}"`);
    expect(line).toContain('"--update"');
  });

  it('runs the Windows script without a console window of its own', () => {
    // Measured on Windows: `detached` gives the child a *visible* console window
    // even with `windowsHide` (DETACHED_PROCESS wins over CREATE_NO_WINDOW), and a
    // reader closing that window stops the update mid-build. A non-detached child
    // has no console and still outlives this app.
    const given = options('win32');
    startUpdateScript(given);
    const [, , spawnOptions] = spawn.mock.calls[0] as [
      string,
      string[],
      { detached: boolean; windowsHide: boolean },
    ];
    expect(spawnOptions.windowsHide).toBe(true);
    expect(spawnOptions.detached).toBe(false);
  });

  it('strips double quotes from arguments instead of letting them break out', () => {
    const given = { ...options('win32'), source: 'a" & calc & "b' };
    startUpdateScript(given);
    const args = spawn.mock.calls[0]?.[1] as string[];
    expect(args[args.length - 1]).not.toContain('a" &');
  });
});
