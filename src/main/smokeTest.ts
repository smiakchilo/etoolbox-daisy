import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app } from 'electron';
import { ADDON_API_VERSION } from '../shared';
import { isAddonModule, runtimeImport } from './addons/loader';
import { ADDON_DESCRIPTOR_FILE, isSafeRelativePath } from './addons/manifest';

/** The command-line flag the update script passes to a freshly built application. */
export const SMOKE_TEST_FLAG = '--smoke-test';

/**
 * How long the checks may take before the run gives up and reports a failure.
 * Comfortably inside the update script's own 180 s limit, so a check that never
 * settles fails here with a line on stderr instead of looking like a hung test.
 */
export const SMOKE_TEST_DEADLINE_MS = 120_000;

export function isSmokeTestRun(argv: readonly string[]): boolean {
  return argv.includes(SMOKE_TEST_FLAG);
}

export interface SmokeTestOptions {
  /** The folder holding one sub-folder per add-on (`<resources>/addons`). */
  readonly addonsDirectory: string;
  readonly importModule?: (specifier: string) => Promise<unknown>;
}

/** Loads every shipped add-on for real; resolves with the problems found (empty means healthy). */
export async function runSmokeChecks(options: SmokeTestOptions): Promise<readonly string[]> {
  const importModule = options.importModule ?? runtimeImport;
  const problems: string[] = [];
  let ids: string[];
  try {
    ids = readdirSync(options.addonsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [`Add-ons folder is missing: ${options.addonsDirectory}`];
  }
  for (const id of ids) {
    const directory = path.join(options.addonsDirectory, id);
    try {
      const descriptor = JSON.parse(
        readFileSync(path.join(directory, ADDON_DESCRIPTOR_FILE), 'utf8'),
      ) as { apiVersion?: unknown; entry?: unknown };
      if (typeof descriptor.entry !== 'string' || !isSafeRelativePath(descriptor.entry)) {
        problems.push(`${id}: addon.json has no usable entry`);
        continue;
      }
      const loaded: unknown = await importModule(
        pathToFileURL(path.join(directory, descriptor.entry)).href,
      );
      const candidate =
        typeof loaded === 'object' && loaded !== null
          ? (loaded as Record<string, unknown>)['addon']
          : undefined;
      if (!isAddonModule(candidate)) {
        problems.push(`${id}: the entry does not export an add-on`);
      } else if (
        candidate.apiVersion !== ADDON_API_VERSION ||
        descriptor.apiVersion !== ADDON_API_VERSION
      ) {
        problems.push(`${id}: add-on API version does not match this build`);
      }
    } catch (error) {
      problems.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
}

/**
 * Headless check run by the update script against a freshly built application
 * before it replaces the installed one. Reaching this code already proves the
 * main bundle parses; it then loads every shipped add-on. Exits 0 when healthy,
 * 1 otherwise, never opening a window or touching the user's data.
 */
export function runSmokeTest(
  addonsDirectory: string,
  importModule?: (specifier: string) => Promise<unknown>,
): void {
  let scratch: string;
  try {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'edaisy-smoke-'));
  } catch (error) {
    // A full or unwritable %TEMP% is a failed check, never a reason to throw
    // from the composition root and leave the update script waiting on a dialog.
    process.stderr.write(`smoke-test: ${error instanceof Error ? error.message : String(error)}\n`);
    app.exit(1);
    return;
  }
  app.setPath('userData', scratch);
  app.setPath('sessionData', scratch);
  function finish(code: number): void {
    clearTimeout(deadline);
    try {
      // Chromium's child processes can still hold the profile they just closed
      // (Windows reports ENOTEMPTY or EPERM), and a run that kept retrying would
      // look like a hung smoke test to the update script, which would revert a
      // healthy build. The folder is temporary: leak it rather than hang or fail.
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // The result is already decided; %TEMP% is not the install.
    }
    app.exit(code);
  }
  // A check that never settles (an add-on's module graph waiting on something it
  // cannot reach) must not hold the process open: the update script would only
  // kill it at its own limit, and a closed console window must not be the way out.
  const deadline = setTimeout(() => {
    process.stderr.write('smoke-test: timed out\n');
    finish(1);
  }, SMOKE_TEST_DEADLINE_MS);
  void app
    .whenReady()
    .then(() =>
      runSmokeChecks({ addonsDirectory, ...(importModule === undefined ? {} : { importModule }) }),
    )
    .then((problems) => {
      for (const problem of problems) process.stderr.write(`smoke-test: ${problem}\n`);
      finish(problems.length === 0 ? 0 : 1);
    })
    .catch((error: unknown) => {
      process.stderr.write(`smoke-test: ${String(error)}\n`);
      finish(1);
    });
}
