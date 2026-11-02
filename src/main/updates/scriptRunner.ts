import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
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

/** Where Windows keeps Windows PowerShell; the bare name only as a last resort. */
export function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env['SystemRoot'];
  return root === undefined || root === ''
    ? 'powershell.exe'
    : path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
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
    // The script must outlive this app (it only swaps the folders once the app has
    // quit) and must not own a console window (closing one aborts the update, and
    // QuickEdit freezes the script's own `tasklist | findstr` probe). Measured on
    // Windows: a `detached` child gets a *visible* console however `windowsHide` is
    // set, and a non-detached one is killed when this app quits. So a one-shot,
    // hidden PowerShell starts cmd hidden (`Start-Process -WindowStyle Hidden`);
    // cmd then belongs to nobody and survives. -EncodedCommand carries the quoted
    // command line past every shell's quoting rules, which is where the script's
    // own `for /f` relaunch and a plain `cmd /c` argument both broke.
    const line = [script, ...args].map(quoteForCmd).join(' ');
    const command = `Start-Process -FilePath 'cmd.exe' -ArgumentList '/d /s /c "${line.replaceAll(
      "'",
      "''",
    )}"' -WindowStyle Hidden`;
    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    const powershell = windowsPowerShellPath(env);
    if (path.isAbsolute(powershell) && !existsSync(powershell)) {
      throw new Error('Windows PowerShell was not found, so the update cannot start');
    }
    const child = spawn(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { detached: false, stdio: 'ignore', windowsHide: true, env },
    );
    // A spawn failure arrives as an event, not as a throw; without a listener it
    // would take the app down after the status already said "applying".
    child.on('error', () => undefined);
    child.unref();
    return;
  }

  spawn('/bin/bash', [script, ...args], { detached: true, stdio: 'ignore', env }).unref();
}
