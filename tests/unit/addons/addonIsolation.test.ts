import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addonPins } from '../../../src/shared/addons/pins';

/**
 * The decoupling invariant: **nothing outside an add-on names it.**
 *
 * An add-on is a self-contained child application, like a DLL. The application
 * knows it only through the generated pins and generic interfaces, so deleting
 * `src/addons/<id>/` must leave the repository green with no other edit. This
 * test is what makes that true rather than aspirational: it scans every text
 * file in the repository - comments included - for an add-on's id, for a
 * third-party library the add-on ships, and for the name of a tool or skill it
 * contributes, and fails on any hit outside the places that are allowed to know:
 *
 * - `src/addons/**` (the add-on itself, its tests and its docs);
 * - `src/shared/addons/pins.json` (the generated pin, which *is* the contract);
 * - `update/**` (the published catalogue and archives folder);
 * - `docs/**` and `AGENTS.md` (the written record).
 *
 * The forbidden words are read from the add-on folders themselves, never typed
 * here, so a new add-on is covered the moment its folder exists.
 */

const root = process.cwd();
const addonsRoot = path.join(root, 'src', 'addons');

/** Folders a scan never walks: build output, dependencies, scratch artefacts. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'out',
  'dist',
  'dist-addons',
  'release',
  '.git',
  '.tsc-out',
  'test-results',
  'playwright-report',
  'blob-report',
  'coverage',
]);

/** The text file types a scan reads. A binary file is skipped, never guessed at. */
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.css',
  '.html',
  '.yml',
  '.yaml',
  '.ps1',
  '.sh',
  '.cmd',
  '.command',
]);

/** Files that are allowed to name an add-on. Repo-relative, `/` separators. */
const ALLOWED_PATHS = ['src/shared/addons/pins.json', 'AGENTS.md'];

const ALLOWED_PREFIXES = ['src/addons/', 'update/', 'docs/'];

/** Lockfiles are generated dependency trees, not application source. */
const SKIPPED_FILES = new Set(['package-lock.json']);

interface AddonFacts {
  readonly id: string;
  readonly dependencies: readonly string[];
  readonly tools: readonly string[];
  readonly skills: readonly string[];
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function addonFacts(): readonly AddonFacts[] {
  if (!existsSync(addonsRoot)) return [];
  return readdirSync(addonsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => existsSync(path.join(addonsRoot, id, 'addon.json')))
    .sort()
    .map((id) => {
      const directory = path.join(addonsRoot, id);
      const descriptor = readJson(path.join(directory, 'addon.json')) ?? {};
      const pkg = readJson(path.join(directory, 'package.json')) ?? {};
      const contributes = (descriptor['contributes'] ?? {}) as { tools?: unknown };
      const declaredTools = Array.isArray(contributes.tools) ? contributes.tools : [];
      const skillsDir = path.join(directory, 'skills');
      const dependencies = Object.keys(pkg['dependencies'] ?? {});
      return {
        id,
        dependencies,
        tools: declaredTools.flatMap((tool) => {
          const name = (tool as { name?: unknown }).name;
          return typeof name === 'string' ? [name] : [];
        }),
        skills: existsSync(skillsDir)
          ? readdirSync(skillsDir, { withFileTypes: true })
              .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
              .filter((entry) => existsSync(path.join(skillsDir, entry.name, 'SKILL.md')))
              .map((entry) => entry.name)
          : [],
      };
    });
}

function relativeFiles(directory: string, prefix = ''): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      files.push(...relativeFiles(path.join(directory, entry.name), `${prefix}${entry.name}/`));
      continue;
    }
    if (!entry.isFile() || SKIPPED_FILES.has(entry.name)) continue;
    files.push(`${prefix}${entry.name}`);
  }
  return files;
}

function isTextFile(relative: string): boolean {
  const base = relative.split('/').at(-1) ?? relative;
  if (base.startsWith('install.')) return true;
  return TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase());
}

function isAllowed(relative: string): boolean {
  return (
    ALLOWED_PATHS.includes(relative) ||
    ALLOWED_PREFIXES.some((prefix) => relative.startsWith(prefix))
  );
}

/** Case-insensitive, whole-word matching: an id must not match a longer word. */
function wordPattern(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

describe('add-on isolation', () => {
  const facts = addonFacts();

  it('reads exactly the add-ons this build pins, so the scan is not vacuous', () => {
    // A build with no add-ons is a valid repository (deleting the folder removes
    // the capability); a pinned add-on the scan cannot read is the failure.
    expect(facts.map((addon) => addon.id).sort()).toEqual(Object.keys(addonPins).sort());
  });

  it('names no add-on, dependency, tool or skill anywhere outside the allowed places', () => {
    const tokens = new Map<string, RegExp>();
    for (const addon of facts) {
      for (const token of [addon.id, ...addon.dependencies, ...addon.tools, ...addon.skills]) {
        if (token.length >= 3) tokens.set(token, wordPattern(token));
      }
    }

    const violations: string[] = [];
    for (const relative of relativeFiles(root)) {
      if (!isTextFile(relative) || isAllowed(relative)) continue;
      const text = readFileSync(path.join(root, ...relative.split('/')), 'utf8');
      for (const [token, pattern] of tokens) {
        if (pattern.test(text)) violations.push(`${relative}: ${token}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
