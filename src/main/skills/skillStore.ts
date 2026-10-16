import type { Dirent } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  type AgentChatSkill,
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
 * The one reader of skills (docs/skill-subsystem-plan.md). It reads two
 * application-fixed folders - the bundled `resources/skills` and the user's
 * `<home>/etoolbox-daisy/skills` - validates every skill folder the same way,
 * and holds the result in memory: the body, a file index and the summary. A
 * skill of the user's with a bundled skill's name replaces it.
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
}

export interface SkillRejection {
  readonly folder: string;
  readonly source: SkillSource;
  readonly reason: string;
}

export interface SkillStoreOptions {
  readonly bundledDirectory: string;
  /** Omitted when the user folder is not wanted (tests, the fake agent). */
  readonly userDirectory?: string;
  readonly onRejected?: (rejection: SkillRejection) => void;
}

export interface SkillStore {
  /** Reads both sources once; later calls share that read. */
  load(): Promise<readonly SkillSummary[]>;
  /** Every loaded skill, sorted by name; `[]` until `load()` resolves. */
  list(): readonly SkillSummary[];
  get(name: string): LoadedSkill | undefined;
  rejections(): readonly SkillRejection[];
  /** The composer's `/` menu: user-invocable skills with the user-facing description. */
  invocable(): readonly AgentChatSkill[];
  /** The model's catalogue: every skill that allows model invocation, with the technical description. */
  modelCatalogue(): readonly SkillCatalogueEntry[];
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

export function createSkillStore(options: SkillStoreOptions): SkillStore {
  let snapshot = EMPTY_SNAPSHOT;
  let inFlight: Promise<readonly SkillSummary[]> | undefined;

  async function read(): Promise<StoreSnapshot> {
    const rejections: SkillRejection[] = [];
    const merged = new Map<string, LoadedSkill>();
    for (const skill of await readSource(options.bundledDirectory, 'bundled', rejections)) {
      merged.set(skill.summary.name, skill);
    }
    if (options.userDirectory !== undefined) {
      // A user skill replaces a bundled one of the same name; a rejected one does not.
      for (const skill of await readSource(options.userDirectory, 'user', rejections)) {
        merged.set(skill.summary.name, skill);
      }
    }
    for (const rejection of rejections) options.onRejected?.(rejection);
    const sorted = [...merged.values()].sort((left, right) =>
      left.summary.name.localeCompare(right.summary.name),
    );
    return { skills: merged, sorted, rejections };
  }

  return {
    load() {
      inFlight ??= read().then(
        (loaded) => {
          snapshot = loaded;
          return loaded.sorted.map((skill) => skill.summary);
        },
        () => {
          snapshot = EMPTY_SNAPSHOT;
          return [];
        },
      );
      return inFlight;
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
        })),
    modelCatalogue: () =>
      snapshot.sorted
        .filter((skill) => !skill.summary.disableModelInvocation)
        .map(({ summary }) => ({ name: summary.name, description: summary.description })),
  };
}
