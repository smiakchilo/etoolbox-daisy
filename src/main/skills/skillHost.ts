import { open } from 'node:fs/promises';
import {
  type JsonValue,
  type SkillHost,
  type SkillOutcome,
  type SkillResource,
  type SkillResourceRequest,
  type SkillScriptRequest,
  type SkillScriptResult,
  err,
  isRunnableScriptPath,
  ok,
} from '../../shared';
import {
  type ScriptFailureKind,
  type ScriptRunRequest,
  type ScriptRunResult,
} from './sandbox/scriptRunner';
import { normaliseSkillRelativePath, resolveSkillPath } from './skillFiles';
import { type LoadedSkill, type SkillStore } from './skillStore';

/** One `skill_resource` call returns at most this many bytes and lines of a file. */
export const SKILL_RESOURCE_MAX_BYTES = 64 * 1024;
export const SKILL_RESOURCE_MAX_LINES = 400;

/** Listing a skill folder shows at most this many entries. */
export const SKILL_RESOURCE_LISTING_LIMIT = 200;

/** Everything the scripts of one skill may import, in total. */
const SCRIPT_MODULES_MAX_BYTES = 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.xml',
  '.html',
  '.js',
  '.mjs',
  '.ts',
  '.py',
  '.sh',
]);

const SCRIPT_FAILURE_CODES: Readonly<
  Record<
    ScriptFailureKind,
    | 'TIMEOUT'
    | 'CANCELLED'
    | 'INVALID_ARGUMENT'
    | 'RESULT_TOO_LARGE_FOR_MODEL'
    | 'UNEXPECTED_RESPONSE'
  >
> = {
  syntax: 'UNEXPECTED_RESPONSE',
  runtime: 'UNEXPECTED_RESPONSE',
  timeout: 'TIMEOUT',
  memory: 'UNEXPECTED_RESPONSE',
  cancelled: 'CANCELLED',
  output_too_large: 'RESULT_TOO_LARGE_FOR_MODEL',
  invalid_result: 'UNEXPECTED_RESPONSE',
  invalid_input: 'INVALID_ARGUMENT',
  internal: 'UNEXPECTED_RESPONSE',
};

export interface SkillHostOptions {
  readonly store: SkillStore;
  /** The sandbox; injected so tests need no WASM. Defaults to the real runner, loaded on first use. */
  readonly runScript?: (request: ScriptRunRequest) => Promise<ScriptRunResult>;
  /** Told of a script that did not complete, for the diagnostics log. */
  readonly onScriptFailed?: (report: {
    readonly skill: string;
    readonly script: string;
    readonly kind: ScriptFailureKind;
  }) => void;
}

function extensionOf(relative: string): string {
  const dot = relative.lastIndexOf('.');
  const slash = relative.lastIndexOf('/');
  return dot > slash ? relative.slice(dot).toLowerCase() : '';
}

function notFound(skill: string): SkillOutcome<never> {
  return err({ code: 'NOT_FOUND', message: `No skill named "${skill}" is loaded.` });
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

type BoundedRead = { readonly buffer: Buffer } | { readonly changed: true };

/**
 * Reads a file the skill index lists, never more than the size the index
 * recorded: a file that grew since startup (or was swapped for something
 * bigger) is reported, not loaded.
 */
async function readIndexedFile(realPath: string, indexedSize: number): Promise<BoundedRead> {
  const handle = await open(realPath, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('not a file');
    if (info.size > indexedSize) return { changed: true };
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
    return { buffer: buffer.subarray(0, bytesRead) };
  } finally {
    await handle.close();
  }
}

function readWindow(
  buffer: Buffer,
  relative: string,
  startLine: number,
): SkillOutcome<SkillResource> {
  if (buffer.includes(0)) {
    return err({
      code: 'INVALID_ARGUMENT',
      message: `"${relative}" is a binary file; only text files can be read.`,
    });
  }
  const size = buffer.length;
  const lines = splitLines(buffer.toString('utf8'));
  const totalLines = lines.length;
  if (startLine > Math.max(totalLines, 1)) {
    return err({
      code: 'INVALID_ARGUMENT',
      message: `startLine ${startLine} is past the end: "${relative}" has ${totalLines} line(s).`,
    });
  }
  const taken: string[] = [];
  let bytes = 0;
  for (let index = startLine - 1; index < totalLines; index += 1) {
    const line = lines[index] ?? '';
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (taken.length >= SKILL_RESOURCE_MAX_LINES) break;
    if (taken.length > 0 && bytes + lineBytes > SKILL_RESOURCE_MAX_BYTES) break;
    taken.push(
      lineBytes > SKILL_RESOURCE_MAX_BYTES ? line.slice(0, SKILL_RESOURCE_MAX_BYTES) : line,
    );
    bytes += lineBytes;
  }
  const endLine = taken.length === 0 ? 0 : startLine + taken.length - 1;
  return ok({
    kind: 'file',
    path: relative,
    size,
    startLine: taken.length === 0 ? 0 : startLine,
    endLine,
    totalLines,
    text: taken.join('\n'),
    ...(endLine < totalLines ? { nextStartLine: endLine + 1 } : {}),
  });
}

function listDirectory(skill: LoadedSkill, relative: string): SkillResource {
  const prefix = relative === '' ? '' : `${relative}/`;
  const entries = skill.files
    .filter((file) => file.path.startsWith(prefix))
    .slice(0, SKILL_RESOURCE_LISTING_LIMIT)
    .map((file) => ({ path: file.path, size: file.size }));
  return { kind: 'directory', path: relative === '' ? '.' : relative, entries };
}

async function collectModules(skill: LoadedSkill): Promise<Readonly<Record<string, string>>> {
  const modules: Record<string, string> = {};
  let total = 0;
  for (const file of skill.files) {
    // Only what is under scripts/ can run or be imported: other .js files are plain resources.
    if (!isRunnableScriptPath(file.path)) continue;
    if (total + file.size > SCRIPT_MODULES_MAX_BYTES) continue;
    const resolved = await resolveSkillPath(skill.directory, file.path);
    if (!resolved.ok) continue;
    try {
      const read = await readIndexedFile(resolved.value.realPath, file.size);
      if ('changed' in read) continue;
      modules[file.path] = read.buffer.toString('utf8');
      total += file.size;
    } catch {
      // A file that vanished since the index was built is simply not importable.
    }
  }
  return modules;
}

function describeFailure(result: Extract<ScriptRunResult, { ok: false }>): string {
  const logs = result.logs.trim();
  const base = `The script did not complete (${result.kind}): ${result.message}`;
  return logs === '' ? base : `${base}\nLogs:\n${logs}`;
}

/**
 * The application's implementation of {@link SkillHost}: what the three skill
 * tools reach through `ToolHost.skills`. It reads only from the store's skills
 * and confines every file access to the skill's own real folder. Nothing it
 * returns carries a filesystem path.
 */
export function createSkillHost(options: SkillHostOptions): SkillHost {
  const { store } = options;
  // A turn's signal identifies it: its script runs go one at a time, in call order.
  const turnQueues = new WeakMap<AbortSignal, Promise<unknown>>();

  function inTurnOrder<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    const previous = turnQueues.get(signal) ?? Promise.resolve();
    const next = previous.then(task, task);
    turnQueues.set(
      signal,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async function runner(request: ScriptRunRequest): Promise<ScriptRunResult> {
    if (options.runScript !== undefined) return options.runScript(request);
    return (await import('./sandbox/scriptRunner')).runSkillScript(request);
  }

  return {
    list: () => store.list(),

    activate(name) {
      const skill = store.get(name);
      if (skill === undefined) return notFound(name);
      return ok({ name: skill.summary.name, body: skill.body, files: skill.files });
    },

    async readResource(request: SkillResourceRequest): Promise<SkillOutcome<SkillResource>> {
      const skill = store.get(request.skill);
      if (skill === undefined) return notFound(request.skill);
      const startLine = request.startLine ?? 1;
      if (!Number.isInteger(startLine) || startLine < 1) {
        return err({
          code: 'INVALID_ARGUMENT',
          message: 'startLine must be a whole number from 1.',
        });
      }
      const resolved = await resolveSkillPath(skill.directory, request.path);
      if (!resolved.ok) return err(resolved.failure);
      const { realPath, relative } = resolved.value;
      // Only what the index lists is served: a file added after startup is not part of the skill.
      const indexed = skill.files.find((file) => file.path === relative);
      if (indexed === undefined) {
        const prefix = relative === '' ? '' : `${relative}/`;
        if (relative === '' || skill.files.some((file) => file.path.startsWith(prefix))) {
          return ok(listDirectory(skill, relative));
        }
        return err({ code: 'NOT_FOUND', message: `No such file in the skill: ${request.path}` });
      }
      if (!TEXT_EXTENSIONS.has(extensionOf(relative))) {
        return err({
          code: 'INVALID_ARGUMENT',
          message: `"${relative}" is not a readable text file type.`,
        });
      }
      try {
        const read = await readIndexedFile(realPath, indexed.size);
        if ('changed' in read) {
          return err({
            code: 'UNEXPECTED_RESPONSE',
            message: `"${relative}" changed since the application started; restart it to read the new version.`,
          });
        }
        return readWindow(read.buffer, relative, startLine);
      } catch {
        return err({ code: 'NOT_FOUND', message: `No such file in the skill: ${request.path}` });
      }
    },

    runScript(request: SkillScriptRequest): Promise<SkillOutcome<SkillScriptResult>> {
      return inTurnOrder(request.signal, () => runScriptNow(request));
    },
  };

  async function runScriptNow(
    request: SkillScriptRequest,
  ): Promise<SkillOutcome<SkillScriptResult>> {
    const skill = store.get(request.skill);
    if (skill === undefined) return notFound(request.skill);
    const normalised = normaliseSkillRelativePath(request.script);
    if ('reason' in normalised) {
      return err({ code: 'INVALID_ARGUMENT', message: normalised.reason });
    }
    const relative = normalised.segments.join('/');
    const resolved = await resolveSkillPath(skill.directory, relative);
    if (!resolved.ok) return err(resolved.failure);
    if (!isRunnableScriptPath(relative)) {
      return err({
        code: 'INVALID_ARGUMENT',
        message:
          `"${relative}" cannot be run: only JavaScript files (.js or .mjs) under scripts/ run. ` +
          'It can still be read with skill_resource.',
      });
    }
    const modules = await collectModules(skill);
    if (!(relative in modules)) {
      return err({ code: 'NOT_FOUND', message: `No such script in the skill: ${relative}` });
    }
    const result = await runner({
      entry: relative,
      modules,
      input: request.input,
      signal: request.signal,
    });
    if (!result.ok) {
      options.onScriptFailed?.({ skill: skill.summary.name, script: relative, kind: result.kind });
      return err({ code: SCRIPT_FAILURE_CODES[result.kind], message: describeFailure(result) });
    }
    return ok({
      output: result.output as JsonValue,
      logs: result.logs,
      logsTruncated: result.logsTruncated,
      durationMs: result.durationMs,
    });
  }
}
