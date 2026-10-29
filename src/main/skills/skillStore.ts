import type { Dirent } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  type AgentChatSkill,
  type ContributedSkill,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_PATTERN,
  type SkillCatalogueEntry,
  type SkillFileEntry,
  type SkillSource,
  type SkillSummary,
  isRunnableScriptPath,
} from '../../shared';
import { parseSkillFrontMatter, splitSkillMarkdown } from './skillFrontMatter';

/**
 * The one reader of skills (docs/skill-subsystem-plan.md). It reads the
 * application-fixed folders - the bundled `resources/skills` and the user's
 * `<home>/etoolbox-daisy/skills` - validates every skill folder the same way,
 * and holds the result in memory: the body, a file index and the summary. A
 * skill of the user's with a bundled skill's name replaces it.
 *
 * A skill an **add-on** contributes is listed from the pins without a download:
 * only its catalogue entry is known until the add-on is installed, and its body
 * and files are read from `<install>/skills/<name>` the first time it is used
 * (`hydrateAddon`). Its source ranks exactly like a bundled one; a clash is a
 * build fault, so nothing is ever replaced by one.
 *
 * Skills are read once, at startup (`load()`); a change on disk applies after a
 * restart. The store never rejects: a missing folder is an empty source and a
 * folder that fails validation is excluded and reported through `onRejected`.
 */

export const SKILL_MD_MAX_BYTES = 64 * 1024;
export const SKILL_MAX_FILES = 200;
export const SKILL_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const SKILL_MAX_DEPTH = 4;

const SKILL_FILE_NAME = 'SKILL.md';
const COMPOSER_DESCRIPTION_MAX_LENGTH = 4000;

export interface LoadedSkill {
  readonly summary: SkillSummary;
  /** The skill's folder; its real path is re-resolved on every file read. */
  readonly directory: string;
  /** `SKILL.md` without its front matter. */
  readonly body: string;
  /** Every file but `SKILL.md`, sorted by path. */
  readonly files: readonly SkillFileEntry[];
  /** The add-on that carries this skill; absent for a bundled or a user skill. */
  readonly addonId?: string;
}

export interface SkillRejection {
  readonly folder: string;
  readonly source: SkillSource;
  readonly reason: string;
}

/** One skill an add-on's pins declare: its catalogue entry and the add-on that carries it. */
export interface AddonSkillPin {
  readonly addonId: string;
  readonly skill: ContributedSkill;
}

export interface SkillStoreOptions {
  readonly bundledDirectory: string;
  /** Omitted when the user folder is not wanted (tests, the fake agent). */
  readonly userDirectory?: string;
  /** Every pinned add-on skill, listed without downloading anything. */
  readonly addons?: readonly AddonSkillPin[];
  /**
   * The installed folder of an add-on, ensured on first use. `undefined` when the
   * add-on could not be installed (its skill stays a catalogue entry only).
   */
  readonly addonDirectory?: (addonId: string) => Promise<string | undefined>;
  readonly onRejected?: (rejection: SkillRejection) => void;
}

export interface SkillStore {
  /** Reads both sources once; later calls share that read. */
  load(): Promise<readonly SkillSummary[]>;
  /**
   * Reads both sources again, replacing the snapshot (a skill added or edited on
   * disk). Rejects when the read itself fails, and then keeps the snapshot it
   * had: a failed reload must never wipe the skills the user already has.
   */
  reload(): Promise<readonly SkillSummary[]>;
  /** Every loaded skill, sorted by name; `[]` until `load()` resolves. */
  list(): readonly SkillSummary[];
  get(name: string): LoadedSkill | undefined;
  rejections(): readonly SkillRejection[];
  /** The composer's `/` menu: user-invocable skills with the user-facing description. */
  invocable(): readonly AgentChatSkill[];
  /** The model's catalogue: every skill that allows model invocation, with the technical description. */
  modelCatalogue(): readonly SkillCatalogueEntry[];
  /** The add-on carrying this skill, when it is a contributed one. */
  addonOf(name: string): string | undefined;
  /**
   * Reads an installed add-on's skills from its own folder, once per identity.
   * Answers whether they are readable now; a skill the pins declared but the
   * folder does not carry is rejected and left as a catalogue entry.
   */
  hydrateAddon(addonId: string): Promise<boolean>;
}

class SkillRejected extends Error {}

interface IndexedFiles {
  readonly files: readonly SkillFileEntry[];
  readonly totalBytes: number;
}

/**
 * Lists a skill folder's files (not `SKILL.md`), refusing a folder that is too
 * big, too deep or has too many files. Symbolic links and dot-entries are not
 * indexed: they are never reachable through a tool either.
 */
async function indexSkillFiles(root: string, skillMdSize: number): Promise<IndexedFiles> {
  const files: SkillFileEntry[] = [];
  let count = 1;
  let totalBytes = skillMdSize;

  async function walk(directory: string, relative: string, depth: number): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const entryRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth + 1 > SKILL_MAX_DEPTH) {
          throw new SkillRejected(`Folders are nested deeper than ${SKILL_MAX_DEPTH} levels.`);
        }
        await walk(path.join(directory, entry.name), entryRelative, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (relative === '' && entry.name === SKILL_FILE_NAME) continue;
      count += 1;
      if (count > SKILL_MAX_FILES) {
        throw new SkillRejected(`The skill has more than ${SKILL_MAX_FILES} files.`);
      }
      const { size } = await lstat(path.join(directory, entry.name));
      totalBytes += size;
      if (totalBytes > SKILL_MAX_TOTAL_BYTES) {
        throw new SkillRejected(
          `The skill is larger than ${SKILL_MAX_TOTAL_BYTES / (1024 * 1024)} MB.`,
        );
      }
      files.push({ path: entryRelative, size });
    }
  }

  await walk(root, '', 0);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, totalBytes };
}

async function readSkillFolder(
  directory: string,
  folder: string,
  source: SkillSource,
): Promise<LoadedSkill> {
  if (!SKILL_NAME_PATTERN.test(folder)) {
    throw new SkillRejected('The folder name must be lower-case letters, digits and hyphens.');
  }
  const skillMd = path.join(directory, SKILL_FILE_NAME);
  // lstat: a SKILL.md that is a link (symlink or junction) could name a file outside the skill.
  const skillMdInfo = await lstat(skillMd);
  if (!skillMdInfo.isFile()) throw new SkillRejected('SKILL.md is not a regular file.');
  const { size } = skillMdInfo;
  if (size > SKILL_MD_MAX_BYTES) {
    throw new SkillRejected(`SKILL.md is larger than ${SKILL_MD_MAX_BYTES / 1024} KB.`);
  }
  const markdown = await readFile(skillMd, 'utf8');
  const parsed = parseSkillFrontMatter(markdown);
  if (parsed === undefined) {
    throw new SkillRejected('SKILL.md has no valid front matter with a name.');
  }
  if (parsed.name !== folder) {
    throw new SkillRejected(`The name "${parsed.name}" differs from the folder name.`);
  }
  if (parsed.description === '') throw new SkillRejected('The description is missing.');
  if (parsed.description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    throw new SkillRejected(
      `The description is longer than ${SKILL_DESCRIPTION_MAX_LENGTH} characters.`,
    );
  }

  const { files } = await indexSkillFiles(directory, size);
  return {
    summary: {
      name: parsed.name,
      description: parsed.description,
      userDescription: parsed.userDescription,
      source,
      userInvocable: parsed.userInvocable,
      disableModelInvocation: parsed.disableModelInvocation,
      tableOnly: parsed.tableOnly,
      hasScripts: files.some((file) => isRunnableScriptPath(file.path)),
    },
    directory,
    body: splitSkillMarkdown(markdown)?.body ?? '',
    files,
  };
}

async function readSource(
  root: string,
  source: SkillSource,
  rejections: SkillRejection[],
): Promise<LoadedSkill[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: LoadedSkill[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const folder = entry.name;
    // A link (symlink or junction) to a folder is never followed: it could lead outside the root.
    if (entry.isSymbolicLink()) {
      rejections.push({ folder, source, reason: 'Links are not followed.' });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, folder);
    // A folder with no SKILL.md is not a skill, so it is not a rejected one.
    if (
      !(await lstat(path.join(directory, SKILL_FILE_NAME)).then(
        () => true,
        () => false,
      ))
    ) {
      continue;
    }
    try {
      skills.push(await readSkillFolder(directory, folder, source));
    } catch (error) {
      rejections.push({
        folder,
        source,
        reason: error instanceof SkillRejected ? error.message : 'The skill could not be read.',
      });
    }
  }
  return skills;
}

interface StoreSnapshot {
  readonly skills: ReadonlyMap<string, LoadedSkill>;
  readonly sorted: readonly LoadedSkill[];
  readonly rejections: readonly SkillRejection[];
}

const EMPTY_SNAPSHOT: StoreSnapshot = { skills: new Map(), sorted: [], rejections: [] };

function summarize(snapshot: StoreSnapshot): readonly SkillSummary[] {
  return snapshot.sorted.map((skill) => skill.summary);
}

function sortSkills(skills: ReadonlyMap<string, LoadedSkill>): readonly LoadedSkill[] {
  return [...skills.values()].sort((left, right) =>
    left.summary.name.localeCompare(right.summary.name),
  );
}

/**
 * A contributed skill before its add-on is installed: the catalogue entry the
 * pins derive from its `SKILL.md`, with no body or files yet. Reading them would
 * mean downloading the add-on, and nothing is downloaded at startup.
 */
function placeholderSkill(addonId: string, skill: ContributedSkill): LoadedSkill {
  return {
    summary: {
      name: skill.name,
      description: skill.description,
      userDescription: skill.userDescription,
      source: 'addon',
      userInvocable: skill.userInvocable,
      disableModelInvocation: skill.disableModelInvocation,
      tableOnly: skill.tableOnly,
      hasScripts: skill.hasScripts,
    },
    directory: '',
    body: '',
    files: [],
    addonId,
  };
}

export function createSkillStore(options: SkillStoreOptions): SkillStore {
  let snapshot = EMPTY_SNAPSHOT;
  let inFlight: Promise<readonly SkillSummary[]> | undefined;
  let reloading: Promise<readonly SkillSummary[]> | undefined;
  const addonSkills = options.addons ?? [];
  const addonBySkill = new Map(addonSkills.map((pin) => [pin.skill.name, pin.addonId]));
  /** The add-ons whose skills have been read from disk already. */
  const hydrated = new Set<string>();
  const hydrating = new Map<string, Promise<boolean>>();

  async function read(): Promise<StoreSnapshot> {
    const rejections: SkillRejection[] = [];
    const merged = new Map<string, LoadedSkill>();
    for (const skill of await readSource(options.bundledDirectory, 'bundled', rejections)) {
      merged.set(skill.summary.name, skill);
    }
    // A contributed skill is listed exactly like a bundled one, from the pins.
    // Its body is read from the installed add-on the first time it is used.
    for (const pin of addonSkills) {
      merged.set(pin.skill.name, placeholderSkill(pin.addonId, pin.skill));
    }
    if (options.userDirectory !== undefined) {
      // A user skill replaces a bundled one of the same name; a rejected one does not.
      for (const skill of await readSource(options.userDirectory, 'user', rejections)) {
        merged.set(skill.summary.name, skill);
      }
    }
    for (const rejection of rejections) options.onRejected?.(rejection);
    hydrated.clear();
    return { skills: merged, sorted: sortSkills(merged), rejections };
  }

  function start(): Promise<readonly SkillSummary[]> {
    return read().then(
      (loaded) => {
        snapshot = loaded;
        return summarize(loaded);
      },
      () => {
        // The initial read may fall back to nothing: there is no earlier
        // snapshot to keep, and the app must still start.
        snapshot = EMPTY_SNAPSHOT;
        return [];
      },
    );
  }

  /**
   * A reload never replaces what is loaded with nothing: a failed read keeps the
   * previous snapshot (only `SKILL_REJECTED`-style per-folder problems ever get
   * that far - this is the whole-source read failing) and rejects so the
   * Settings button can say so.
   */
  function reloadOnce(): Promise<readonly SkillSummary[]> {
    return read().then((loaded) => {
      snapshot = loaded;
      return summarize(loaded);
    });
  }

  /**
   * Reads one installed add-on's skills. The folder is `<install>/skills`, and
   * each skill is validated exactly like a bundled one: the same size, count and
   * depth limits, no links, and a real-path containment check on every read.
   */
  async function hydrateOnce(addonId: string): Promise<boolean> {
    const directory = await options.addonDirectory?.(addonId);
    if (directory === undefined) return false;
    const root = path.join(directory, 'skills');
    const pins = addonSkills.filter((pin) => pin.addonId === addonId);
    const rejections: SkillRejection[] = [];
    const updated = new Map(snapshot.skills);
    for (const pin of pins) {
      const name = pin.skill.name;
      // A user skill of the same name wins; the add-on's copy is not read.
      if (updated.get(name)?.summary.source === 'user') continue;
      try {
        const skill = await readSkillFolder(path.join(root, name), name, 'addon');
        updated.set(name, { ...skill, addonId });
      } catch (error) {
        rejections.push({
          folder: name,
          source: 'addon',
          reason:
            error instanceof SkillRejected
              ? error.message
              : (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? 'The add-on does not carry this skill.'
                : 'The skill could not be read.',
        });
      }
    }
    for (const rejection of rejections) options.onRejected?.(rejection);
    snapshot = {
      skills: updated,
      sorted: sortSkills(updated),
      rejections: [...snapshot.rejections, ...rejections],
    };
    hydrated.add(addonId);
    return true;
  }

  return {
    load() {
      inFlight ??= start();
      return inFlight;
    },
    reload() {
      // Rapid clicks share one read instead of queueing a scan each.
      if (reloading !== undefined) return reloading;
      const run = (inFlight ?? Promise.resolve<readonly SkillSummary[]>([]))
        .catch(() => [])
        .then(reloadOnce);
      reloading = run;
      const settle = (): void => {
        if (reloading === run) reloading = undefined;
      };
      run.then(() => {
        // `load()` answers with the latest successful read; a failed reload
        // leaves the previous one in place.
        inFlight = run;
        settle();
      }, settle);
      return run;
    },
    list: () => snapshot.sorted.map((skill) => skill.summary),
    get: (name) => snapshot.skills.get(name),
    rejections: () => snapshot.rejections,
    invocable: () =>
      snapshot.sorted
        .filter((skill) => skill.summary.userInvocable)
        .map(({ summary }) => ({
          name: summary.name,
          description: (summary.userDescription === ''
            ? summary.description
            : summary.userDescription
          ).slice(0, COMPOSER_DESCRIPTION_MAX_LENGTH),
          ...(summary.tableOnly ? { tableOnly: true } : {}),
        })),
    modelCatalogue: () =>
      snapshot.sorted
        .filter((skill) => !skill.summary.disableModelInvocation)
        .map(({ summary }) => ({ name: summary.name, description: summary.description })),
    addonOf: (name) => addonBySkill.get(name),
    hydrateAddon(addonId) {
      if (hydrated.has(addonId)) return Promise.resolve(true);
      const running = hydrating.get(addonId);
      if (running !== undefined) return running;
      const run = hydrateOnce(addonId).catch(() => false);
      hydrating.set(addonId, run);
      return run.finally(() => {
        hydrating.delete(addonId);
      });
    },
  };
}
