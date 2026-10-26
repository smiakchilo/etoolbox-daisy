import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Facts about the two build-from-source installers in `install/`, held against
 * the files themselves so an edit cannot silently break a download nobody runs
 * in the test suite (the scripts fetch a Node.js and build the whole app).
 *
 * 1. **Line endings.** `install.cmd` must be CRLF and `install.command` LF-only
 *    (AGENTS.md, `docs/run-from-source.md`). Editors and the `edit` tool rewrite
 *    them without asking, and an LF batch file or a CRLF shebang breaks in ways
 *    nothing else notices.
 * 2. **One Node.js pin.** Both scripts name the same `NODE_VERSION` and pin a
 *    SHA-256 per platform: bumping Node in one file only is caught here instead
 *    of on a customer's machine. `docs/run-from-source.md` states the bump
 *    procedure; this holds it.
 * 3. **The pin is not older than the accepted baseline**, or the fallback
 *    download would contradict the gate an installed Node.js must pass.
 * 4. **Windows tools are called by absolute path.** `certutil` was once called
 *    by name and an install died on "'certutil' is not recognized" with a
 *    misleading SHA-256 mismatch; a trimmed PATH must not decide whether the
 *    build works.
 * 5. **The packaging step can resolve `powershell.exe`.** `scripts/app-build.mjs`
 *    is the one place both installers share, and electron-builder spawns that
 *    bare name, so the build script - not the inherited PATH - has to supply it.
 */
const installDir = path.join(process.cwd(), 'install');
const cmdText = readFileSync(path.join(installDir, 'install.cmd'), 'utf8');
const commandText = readFileSync(path.join(installDir, 'install.command'), 'utf8');
const buildScriptText = readFileSync(path.join(process.cwd(), 'scripts', 'app-build.mjs'), 'utf8');

/** A value from a `set "NAME=value"` line in the batch installer. */
function batchValue(text: string, name: string): string | undefined {
  return new RegExp(`^set "${name}=([^"\r\n]*)"`, 'm').exec(text)?.[1];
}

/** A value from a `NAME=value` / `NAME="value"` line in the shell installer. */
function shellValue(text: string, name: string): string | undefined {
  return new RegExp(`^${name}=("?)([^"\r\n]*)\\1`, 'm').exec(text)?.[2];
}

function versionParts(version: string): number[] {
  return version.split('.').map(Number);
}

describe('build-from-source installers', () => {
  it('keeps install.cmd CRLF and install.command LF-only', () => {
    expect(cmdText.split('\r\n').join('\r\n')).toBe(cmdText);
    expect(commandText).not.toContain('\r');
  });

  it('pins the same Node.js version in both installers', () => {
    const pinned = batchValue(cmdText, 'NODE_VERSION');
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(shellValue(commandText, 'NODE_VERSION')).toBe(pinned);
  });

  it('pins a SHA-256 for every downloaded Node.js build', () => {
    expect(batchValue(cmdText, 'NODE_SHA256')).toMatch(/^[0-9a-f]{64}$/);
    expect(shellValue(commandText, 'NODE_SHA256_X64')).toMatch(/^[0-9a-f]{64}$/);
    expect(shellValue(commandText, 'NODE_SHA256_ARM64')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts an installed Node.js only at or above the pinned version', () => {
    for (const key of ['NODE_BASELINE_MAJOR', 'NODE_BASELINE_MINOR']) {
      expect(batchValue(cmdText, key)).toBe(shellValue(commandText, key));
    }
    const pinned = versionParts(batchValue(cmdText, 'NODE_VERSION') ?? '');
    const baseline = [
      Number(batchValue(cmdText, 'NODE_BASELINE_MAJOR')),
      Number(batchValue(cmdText, 'NODE_BASELINE_MINOR')),
    ];
    expect(pinned[0]).toBeGreaterThan(baseline[0] ?? 0);
  });

  it('calls each Windows tool by absolute path, never by bare name', () => {
    for (const name of ['CURL', 'TAR', 'CERTUTIL', 'POWERSHELL']) {
      expect(batchValue(cmdText, name)).toMatch(/^%SystemRoot%\\System32\\/i);
    }
    const tools = ['curl', 'tar', 'certutil', 'powershell'];
    for (const line of cmdText.split('\r\n')) {
      // Comments, echoed messages and the definitions themselves only establish
      // the paths above; none of them runs a tool.
      if (/^\s*(rem|echo)\b/i.test(line)) continue;
      if (/^set "(CURL|TAR|CERTUTIL|POWERSHELL)=/i.test(line)) continue;
      // Drop the `%NAME%` references, leaving what the command line actually names.
      const withoutVariables = line.replaceAll(/%[A-Za-z_]+%/g, '');
      for (const tool of tools) {
        const bare = new RegExp(`(^|[\\s'"()&|])${tool}\\b`, 'i').test(withoutVariables);
        expect(bare, `bare "${tool}" call: ${line.trim()}`).toBe(false);
      }
    }
  });

  it('makes powershell.exe resolvable for the packaging step', () => {
    // electron-builder's node-module collector spawns `powershell.exe` by bare
    // name on Windows, so Windows resolves it through PATH only - while
    // install.cmd reaches PowerShell by absolute path. A machine whose PATH has
    // no Windows PowerShell therefore built everything and then died at
    // packaging with `spawn powershell.exe ENOENT`. What must hold is the name,
    // not a version or a folder: an entry that already carries the executable is
    // accepted as it stands, "resolvable" is decided by the executable in every
    // PATH entry, both homes Windows PowerShell ships in are the fallback, and
    // whatever is chosen reaches the children.
    expect(buildScriptText).toMatch(
      /if \(isWindows && !resolvesPowerShell\(process\.env\[pathKey]\)\)/,
    );
    expect(buildScriptText).toMatch(/split\(delimiter\)[\s\S]{0,400}powershell\.exe/);
    for (const folder of ['System32', 'SysWOW64']) {
      expect(buildScriptText).toMatch(new RegExp(`${folder}[\\s\\S]{0,80}WindowsPowerShell`));
    }
    expect(buildScriptText).toMatch(/\[pathKey]:[\s\S]{0,200}powerShellDir/);
  });
});
