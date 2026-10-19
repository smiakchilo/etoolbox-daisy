import type { Dirent } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import {
  MEMO_TEXT_MAX_BYTES,
  MEMO_TITLE_MAX_LENGTH,
  SKILL_NAME_PATTERN,
  memoIdSchema,
  type MemoOutcome,
  type MemoRecord,
  type MemoWriteRequest,
} from '../../shared';
import { splitSkillMarkdown } from '../skills/skillFrontMatter';

/**
 * The memo files: one `.md` per lesson under `<home>/etoolbox-daisy/memos`,
 * `generic/` for a lesson that holds everywhere and `skills/<skill>/` for one
 * about following a skill. The application picks the folder and the file name
 * (`YYYYMMDD-HHMMSS-<slug>.md`); the model never supplies a path.
 *
 * Unlike skills and rules, memos are read **fresh** on every load, so a memo
 * the user edits or deletes by hand applies to the next conversation without a
 * restart. Loading never rejects: a missing folder is no memos, and a file that
 * cannot be read, is over the per-memo size or does not fit its scope's budget
 * is skipped and counted.
 */

/** The generic memos sent with a conversation, newest first, at most this many bytes. */
export const GENERIC_MEMOS_MAX_BYTES = 16 * 1024;
/** One skill's memos appended to its activation, newest first, at most this many bytes. */
export const SKILL_MEMOS_MAX_BYTES = 8 * 1024;

const MEMO_EXTENSION = '.md';
const GENERIC_FOLDER = 'generic';
const SKILLS_FOLDER = 'skills';
const SLUG_MAX_LENGTH = 60;
const MAX_COLLISION_SUFFIX = 999;

export interface LoadedMemo {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export interface LoadedMemos {
  /** The memos that fit the budget, newest first. */
  readonly memos: readonly LoadedMemo[];
  /** How many memo files were not loaded: unreadable, oversized or over budget. */
  readonly skipped: number;
}

export interface MemoWriteContext {
  /** The conversation the memo came from, recorded in its front matter. */
  readonly chatId?: string;
}

export interface MemoStoreOptions {
  readonly directory: string;
  /** Whether `skill` names a loaded skill; an unknown one is refused. */
  readonly isKnownSkill: (name: string) => boolean;
  /** The clock; injectable for tests. */
  readonly now?: () => Date;
}

export interface MemoStore {
  write(request: MemoWriteRequest, context?: MemoWriteContext): Promise<MemoOutcome<MemoRecord>>;
  /** The absolute path of an existing memo; `undefined` for an invalid id or a missing file. */
  locate(id: string): Promise<string | undefined>;
  generic(): Promise<LoadedMemos>;
  forSkill(skill: string): Promise<LoadedMemos>;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** `YYYYMMDD-HHMMSS` in local time, so a file name reads as the user's own clock. */
export function memoTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** A file-name slug: lower-case ASCII letters, digits and single dashes. */
export function memoSlug(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'memo' : slug;
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n').trim();
}

function invalid(message: string): MemoOutcome<MemoRecord> {
  return { ok: false, error: { code: 'INVALID_ARGUMENT', message } };
}

function storageFailure(): MemoOutcome<MemoRecord> {
  return {
    ok: false,
    error: { code: 'STORAGE_ERROR', message: 'The memo could not be written to the memos folder' },
  };
}

interface ParsedMemo {
  readonly title?: string;
  readonly body: string;
}

function parseMemoMarkdown(markdown: string): ParsedMemo {
  const text = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
  const split = splitSkillMarkdown(text);
  if (split === undefined) return { body: normalizeBody(text) };
  let title: string | undefined;
  try {
    const document: unknown = parse(split.frontMatter);
    if (typeof document === 'object' && document !== null && !Array.isArray(document)) {
      const value = (document as Record<string, unknown>)['title'];
      if (typeof value === 'string' && value.trim() !== '') title = value.trim();
    }
  } catch {
    // A hand-broken front matter still leaves a usable lesson: keep the body.
  }
  return title === undefined
    ? { body: normalizeBody(split.body) }
    : { title, body: normalizeBody(split.body) };
}

interface MemoFile {
  readonly name: string;
  readonly absolutePath: string;
}

async function listMemoFiles(directory: string): Promise<MemoFile[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return (
    entries
      // `isFile()` is false for a link, so a symlink is never followed.
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .filter((entry) => entry.name.toLowerCase().endsWith(MEMO_EXTENSION))
      .map((entry) => ({ name: entry.name, absolutePath: path.join(directory, entry.name) }))
      // The time stamp leads the name, so a reverse name order is newest first.
      .sort((left, right) => (left.name < right.name ? 1 : left.name > right.name ? -1 : 0))
  );
}

async function readMemoFile(file: MemoFile): Promise<ParsedMemo | undefined> {
  try {
    const { size } = await lstat(file.absolutePath);
    if (size > MEMO_TEXT_MAX_BYTES * 2) return undefined;
    const parsed = parseMemoMarkdown(await readFile(file.absolutePath, 'utf8'));
    if (parsed.body === '' || Buffer.byteLength(parsed.body, 'utf8') > MEMO_TEXT_MAX_BYTES) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

async function loadScope(
  directory: string,
  idPrefix: string,
  budget: number,
): Promise<LoadedMemos> {
  const memos: LoadedMemo[] = [];
  let skipped = 0;
  let used = 0;
  for (const file of await listMemoFiles(directory)) {
    const parsed = await readMemoFile(file);
    if (parsed === undefined) {
      skipped += 1;
      continue;
    }
    const title = parsed.title ?? file.name.slice(0, -MEMO_EXTENSION.length);
    const bytes = Buffer.byteLength(title, 'utf8') + Buffer.byteLength(parsed.body, 'utf8');
    if (used + bytes > budget) {
      skipped += 1;
      continue;
    }
    used += bytes;
    memos.push({ id: `${idPrefix}/${file.name}`, title, body: parsed.body });
  }
  return { memos, skipped };
}

function renderMemoFile(
  title: string,
  body: string,
  request: MemoWriteRequest,
  created: Date,
  context: MemoWriteContext | undefined,
): string {
  const frontMatter: Record<string, string> = {
    title,
    created: created.toISOString(),
    trigger: request.trigger,
  };
  if (context?.chatId !== undefined) frontMatter['chat'] = context.chatId;
  return `---\n${stringify(frontMatter).trimEnd()}\n---\n\n${body}\n`;
}

/** Writes a new file only if none exists; `false` when the name is taken, other failures throw. */
async function createExclusive(filePath: string, content: string): Promise<boolean> {
  try {
    await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

export function createMemoStore(options: MemoStoreOptions): MemoStore {
  const root = path.resolve(options.directory);
  const now = options.now ?? (() => new Date());

  function scopeDirectory(skill: string | undefined): string {
    return skill === undefined
      ? path.join(root, GENERIC_FOLDER)
      : path.join(root, SKILLS_FOLDER, skill);
  }

  function scopeIdPrefix(skill: string | undefined): string {
    return skill === undefined ? GENERIC_FOLDER : `${SKILLS_FOLDER}/${skill}`;
  }

  /** The contained absolute path of a well-formed id; `undefined` otherwise. */
  function resolveId(id: string): string | undefined {
    if (!memoIdSchema.safeParse(id).success) return undefined;
    const absolute = path.resolve(root, ...id.split('/'));
    return absolute.startsWith(root + path.sep) ? absolute : undefined;
  }

  async function isDuplicate(directory: string, body: string): Promise<boolean> {
    for (const file of await listMemoFiles(directory)) {
      const parsed = await readMemoFile(file);
      if (parsed?.body === body) return true;
    }
    return false;
  }

  async function write(
    request: MemoWriteRequest,
    context?: MemoWriteContext,
  ): Promise<MemoOutcome<MemoRecord>> {
    const title = request.title.replace(/\s+/g, ' ').trim();
    if (title === '') return invalid('The memo needs a title');
    if (title.length > MEMO_TITLE_MAX_LENGTH) {
      return invalid(`The memo title is longer than ${MEMO_TITLE_MAX_LENGTH} characters`);
    }
    const body = normalizeBody(request.text);
    if (body === '') return invalid('The memo needs text');
    if (Buffer.byteLength(body, 'utf8') > MEMO_TEXT_MAX_BYTES) {
      return invalid(`The memo text is longer than ${MEMO_TEXT_MAX_BYTES} bytes`);
    }
    const { skill } = request;
    if (skill !== undefined && (!SKILL_NAME_PATTERN.test(skill) || !options.isKnownSkill(skill))) {
      return invalid(`"${skill}" is not a loaded skill; write a generic memo instead`);
    }

    const directory = scopeDirectory(skill);
    if (await isDuplicate(directory, body)) {
      return invalid('An identical memo is already recorded in this scope');
    }

    const created = now();
    const stem = memoTimestamp(created);
    const slug = memoSlug(title);
    const content = renderMemoFile(title, body, request, created, context);
    try {
      await mkdir(directory, { recursive: true });
      for (let suffix = 1; suffix <= MAX_COLLISION_SUFFIX; suffix += 1) {
        const fileName = `${stem}${suffix === 1 ? '' : `-${suffix}`}-${slug}${MEMO_EXTENSION}`;
        if (!(await createExclusive(path.join(directory, fileName), content))) continue;
        const record: MemoRecord = {
          id: `${scopeIdPrefix(skill)}/${fileName}`,
          title,
          fileName,
        };
        return { ok: true, value: skill === undefined ? record : { ...record, skill } };
      }
      return storageFailure();
    } catch {
      return storageFailure();
    }
  }

  async function locate(id: string): Promise<string | undefined> {
    const absolute = resolveId(id);
    if (absolute === undefined) return undefined;
    try {
      return (await lstat(absolute)).isFile() ? absolute : undefined;
    } catch {
      return undefined;
    }
  }

  return {
    write,
    locate,
    generic: () => loadScope(scopeDirectory(undefined), GENERIC_FOLDER, GENERIC_MEMOS_MAX_BYTES),
    forSkill(skill) {
      if (!SKILL_NAME_PATTERN.test(skill)) return Promise.resolve({ memos: [], skipped: 0 });
      return loadScope(scopeDirectory(skill), scopeIdPrefix(skill), SKILL_MEMOS_MAX_BYTES);
    },
  };
}
