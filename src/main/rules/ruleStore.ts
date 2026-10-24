import type { Dirent } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { normalizeProjectLabel, parseRuleMarkdown } from './ruleFrontMatter';

/**
 * The reader of the user's own rules: `*.md` files, top level only, in the
 * application-fixed `<home>/etoolbox-daisy/rules` folder. Like skills, they are
 * read at startup (`load()`) and again on request (`reload()`, the Settings
 * reload button); without that, a change on disk applies after a restart.
 *
 * A rule with no `project` front matter is generic and joins the session
 * instructions; a rule naming projects is handed to the model by the chat
 * controller while the browser pane is on a host of such a project (see
 * `ruleRendering.ts`). The store never rejects: a missing folder is no rules,
 * and a file that fails validation is excluded and reported through
 * `onRejected`.
 */

export const RULE_FILE_MAX_BYTES = 32 * 1024;
export const GENERIC_RULES_MAX_BYTES = 64 * 1024;
export const PROJECT_RULES_MAX_BYTES = 16 * 1024;

export interface LoadedRule {
  /** The file name without `.md`. */
  readonly name: string;
  /** Normalized project labels; empty for a generic rule. */
  readonly projects: readonly string[];
  readonly body: string;
}

export interface RuleRejection {
  readonly file: string;
  readonly reason: string;
}

export interface RuleStoreOptions {
  readonly directory: string;
  readonly onRejected?: (rejection: RuleRejection) => void;
}

export interface RuleStore {
  /** Reads the folder once; later calls share that read. */
  load(): Promise<void>;
  /** Reads the folder again, replacing what was loaded and the rejections. */
  reload(): Promise<void>;
  /** The generic rules, sorted by name; `[]` until `load()` resolves. */
  generic(): readonly LoadedRule[];
  /** The rules naming `label` (trimmed, case-insensitive), sorted by name. */
  forProject(label: string): readonly LoadedRule[];
  rejections(): readonly RuleRejection[];
  /** The number of rules loaded, generic and project alike. */
  count(): number;
}

const RULE_EXTENSION = '.md';

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readRuleFiles(
  directory: string,
  rejections: RuleRejection[],
): Promise<LoadedRule[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const rules: LoadedRule[] = [];
  for (const entry of entries) {
    // `isFile()` is false for a link, so a symlink is never followed.
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    if (!entry.name.toLowerCase().endsWith(RULE_EXTENSION)) continue;
    const file = entry.name;
    const name = file.slice(0, -RULE_EXTENSION.length);
    try {
      const { size } = await lstat(path.join(directory, file));
      if (size > RULE_FILE_MAX_BYTES) {
        rejections.push({
          file,
          reason: `The file is larger than ${RULE_FILE_MAX_BYTES / 1024} KB.`,
        });
        continue;
      }
      const parsed = parseRuleMarkdown(await readFile(path.join(directory, file), 'utf8'));
      if (!parsed.ok) {
        rejections.push({ file, reason: parsed.reason });
        continue;
      }
      if (parsed.body === '') continue;
      rules.push({ name, projects: parsed.projects, body: parsed.body });
    } catch {
      rejections.push({ file, reason: 'The file could not be read.' });
    }
  }
  return rules.sort((left, right) => compareCodePoints(left.name, right.name));
}

/**
 * Keeps the rules that fit their budgets, in name order: the generic rules
 * together, and each project's rules together. A rule that would overflow any
 * budget it counts towards is rejected whole.
 */
function applyBudgets(rules: readonly LoadedRule[], rejections: RuleRejection[]): LoadedRule[] {
  const used = new Map<string, number>();
  const kept: LoadedRule[] = [];
  for (const rule of rules) {
    const bytes = Buffer.byteLength(rule.body, 'utf8');
    const buckets =
      rule.projects.length === 0
        ? [{ key: '', limit: GENERIC_RULES_MAX_BYTES }]
        : rule.projects.map((project) => ({ key: project, limit: PROJECT_RULES_MAX_BYTES }));
    const overflow = buckets.find(({ key, limit }) => (used.get(key) ?? 0) + bytes > limit);
    if (overflow !== undefined) {
      rejections.push({
        file: `${rule.name}${RULE_EXTENSION}`,
        reason: `The rules exceed ${overflow.limit / 1024} KB.`,
      });
      continue;
    }
    for (const { key } of buckets) used.set(key, (used.get(key) ?? 0) + bytes);
    kept.push(rule);
  }
  return kept;
}

export function createRuleStore(options: RuleStoreOptions): RuleStore {
  let loaded: Promise<void> | undefined;
  let rules: readonly LoadedRule[] = [];
  const rejected: RuleRejection[] = [];

  async function read(): Promise<void> {
    const rejections: RuleRejection[] = [];
    const files = await readRuleFiles(options.directory, rejections);
    rules = applyBudgets(files, rejections);
    rejected.length = 0;
    for (const rejection of rejections) {
      rejected.push(rejection);
      options.onRejected?.(rejection);
    }
  }

  return {
    load() {
      loaded ??= read();
      return loaded;
    },
    reload() {
      // A failed read keeps the rules already loaded (the rejection is reported
      // to the Settings button), and leaves `load()` able to retry later.
      const run = (loaded ?? Promise.resolve()).catch(() => undefined).then(read);
      loaded = run;
      return run.catch((error: unknown) => {
        if (loaded === run) loaded = undefined;
        throw error;
      });
    },
    generic: () => rules.filter((rule) => rule.projects.length === 0),
    forProject(label) {
      const key = normalizeProjectLabel(label);
      if (key === '') return [];
      return rules.filter((rule) => rule.projects.includes(key));
    },
    rejections: () => rejected,
    count: () => rules.length,
  };
}
