import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Swaps a staged `app.asar` over the installed one after this process exits,
 * then relaunches the app. A running process cannot replace its own archive on
 * Windows (the file is locked), so a detached script waits for the exit, does
 * a same-directory rename (keeping the old file as `.bak` and restoring it if
 * the second rename fails) and starts the app again.
 *
 * The script builders are pure so they can be tested without spawning.
 */
export interface ApplyPlan {
  /** The installed archive, `.../resources/app.asar`. */
  readonly targetAsar: string;
  /** The verified download, in the same directory as {@link targetAsar}. */
  readonly stagedAsar: string;
  /** `process.pid` of the app about to quit. */
  readonly pid: number;
  /** Windows: the executable to start. macOS: the `.app` bundle. */
  readonly relaunchPath: string;
}

function batchValue(value: string): string {
  // `%` would expand variables; the rest is inert inside `set "NAME=..."`.
  return value.replace(/%/g, '%%');
}

export function buildWindowsScript(plan: ApplyPlan): string {
  return [
    '@echo off',
    `set "TARGET=${batchValue(plan.targetAsar)}"`,
    `set "NEW=${batchValue(plan.stagedAsar)}"`,
    `set "EXE=${batchValue(plan.relaunchPath)}"`,
    `set "PID=${plan.pid}"`,
    'set /a TRIES=0',
    ':wait',
    'tasklist /FI "PID eq %PID%" 2>NUL | find "%PID%" >NUL',
    'if not errorlevel 1 (',
    '  ping -n 2 127.0.0.1 >NUL',
    '  goto wait',
    ')',
    ':swap',
    'move /Y "%TARGET%" "%TARGET%.bak" >NUL 2>&1',
    'if errorlevel 1 goto retry',
    'move /Y "%NEW%" "%TARGET%" >NUL 2>&1',
    'if errorlevel 1 (',
    '  move /Y "%TARGET%.bak" "%TARGET%" >NUL 2>&1',
    '  goto relaunch',
    ')',
    'del "%TARGET%.bak" >NUL 2>&1',
    'goto relaunch',
    ':retry',
    'set /a TRIES+=1',
    'if %TRIES% GEQ 30 goto relaunch',
    'ping -n 2 127.0.0.1 >NUL',
    'goto swap',
    ':relaunch',
    'del "%NEW%" >NUL 2>&1',
    'start "" "%EXE%"',
    '(goto) 2>NUL & del "%~f0"',
    '',
  ].join('\r\n');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildMacScript(plan: ApplyPlan): string {
  return [
    '#!/bin/sh',
    `TARGET=${shellQuote(plan.targetAsar)}`,
    `NEW=${shellQuote(plan.stagedAsar)}`,
    `APP=${shellQuote(plan.relaunchPath)}`,
    `PID=${plan.pid}`,
    'while kill -0 "$PID" 2>/dev/null; do sleep 1; done',
    'if mv -f "$TARGET" "$TARGET.bak"; then',
    '  if mv -f "$NEW" "$TARGET"; then',
    '    rm -f "$TARGET.bak"',
    '  else',
    '    mv -f "$TARGET.bak" "$TARGET"',
    '  fi',
    'fi',
    'rm -f "$NEW"',
    'xattr -cr "$APP" 2>/dev/null',
    // The swap leaves the bundle's ad-hoc seal describing the old archive; seal it again.
    'codesign --force --deep --sign - "$APP" 2>/dev/null',
    'open "$APP"',
    'rm -f "$0"',
    '',
  ].join('\n');
}

/** Writes the platform's script into `scratchDirectory` and starts it detached. */
export function startApplyScript(
  plan: ApplyPlan,
  platform: NodeJS.Platform,
  scratchDirectory: string,
): void {
  if (platform === 'win32') {
    const script = path.join(scratchDirectory, 'apply-update.cmd');
    writeFileSync(script, buildWindowsScript(plan), 'utf8');
    spawn('cmd.exe', ['/c', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    return;
  }
  const script = path.join(scratchDirectory, 'apply-update.sh');
  writeFileSync(script, buildMacScript(plan), { encoding: 'utf8', mode: 0o700 });
  spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
}

/** The `.app` bundle that contains `<bundle>/Contents/Resources/app.asar`. */
export function macBundlePath(targetAsar: string): string {
  return path.resolve(targetAsar, '..', '..', '..');
}
