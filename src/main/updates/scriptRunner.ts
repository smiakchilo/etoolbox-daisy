import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type UpdatePlatform = 'darwin' | 'win32';

export interface StartUpdateScriptOptions {
  /** Where the installed build keeps `resources/install/<script>`. */
  bundledScript: string;
  /** A branch, a tag or an https archive URL, exactly as the script takes it. */
  source: string;
  /** The folder the script replaces. */
  appFolder: string;
  pid: number;
  statusFile: string;
  env: Record<string, string>;
  platform: UpdatePlatform;
  /** The script is copied here first: the install folder is renamed during the swap. */
  scratchDirectory: string;
}

export function installScriptName(platform: UpdatePlatform): string {
  return platform === 'win32' ? 'install.cmd' : 'install.command';
}

export function bundledInstallScript(resourcesPath: string, platform: UpdatePlatform): string {
  return path.join(resourcesPath, 'install', installScriptName(platform));
}

/** The folder the script swaps: next to the exe on Windows, the bundle's parent on a Mac. */
export function installedAppFolder(executablePath: string, platform: UpdatePlatform): string {
  if (platform === 'win32') {
    return path.dirname(executablePath);
  }
  const bundle = path.dirname(path.dirname(path.dirname(executablePath)));
  return path.dirname(bundle);
}

/** Quotes one cmd.exe argument; none of ours may contain a double quote. */
function quoteForCmd(value: string): string {
  return `"${value.replaceAll('"', '')}"`;
}

export function startUpdateScript(options: StartUpdateScriptOptions): void {
  mkdirSync(options.scratchDirectory, { recursive: true });
  const script = path.join(
    options.scratchDirectory,
    `update-${installScriptName(options.platform)}`,
  );
  copyFileSync(options.bundledScript, script);

  const args = [
    '--update',
    options.source,
    options.appFolder,
    String(options.pid),
    options.statusFile,
  ];
  const env = { ...process.env, ...options.env };

  if (options.platform === 'win32') {
    const line = [script, ...args].map(quoteForCmd).join(' ');
    spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
      env,
    }).unref();
    return;
  }

  spawn('/bin/bash', [script, ...args], { detached: true, stdio: 'ignore', env }).unref();
}
