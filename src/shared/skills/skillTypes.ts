import type { JsonValue, ToolErrorCode } from '../contracts';
import type { Result } from '../result';

/**
 * The skill subsystem's shared vocabulary (docs/skill-subsystem-plan.md). A
 * skill is a folder with a `SKILL.md` and optional `references/` and
 * `scripts/`. Main owns reading them (`src/main/skills/`); the three skill
 * tools (`load_skill`, `skill_resource`, `skill_script`) and the prompt composition
 * see only this module's types, through `ToolHost.skills`.
 */

/** A skill's name and its folder name: the Agent Skills naming rule. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Longest accepted `description`: the Copilot runtime silently drops longer ones (docs/compatibility.md 4.5). */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/**
 * Where a skill came from. A user skill with a bundled skill's name replaces it;
 * an add-on's skills rank exactly like the bundled ones (a build fails on a name
 * clash), and their body and files ship in the add-on, not in the application.
 */
export type SkillSource = 'bundled' | 'user' | 'addon';

/** One skill as the model, the composer and the home screen see it. */
export interface SkillSummary {
  readonly name: string;
  /** Written for the model: when to load the skill. */
  readonly description: string;
  /** One friendly phrase for the user; `''` when the skill carries none. */
  readonly userDescription: string;
  readonly source: SkillSource;
  /** Offered in the composer's `/` menu. */
  readonly userInvocable: boolean;
  /** Left out of the model's catalogue; still loadable by `/name`. */
  readonly disableModelInvocation: boolean;
  /** The skill's answer is one application-rendered table; the model's prose is suppressed. */
  readonly tableOnly: boolean;
  /** Whether the skill has at least one script `skill_script` can run. */
  readonly hasScripts: boolean;
}

/** One file inside a skill folder, relative to it, with `/` separators. */
export interface SkillFileEntry {
  readonly path: string;
  readonly size: number;
}

/** Everything `renderSkillActivation` needs: the body without its front matter and the file index. */
export interface SkillActivation {
  readonly name: string;
  readonly body: string;
  /** Every file but `SKILL.md`, sorted by path. */
  readonly files: readonly SkillFileEntry[];
}

/** A skill operation that did not succeed: the tool-error code the tool should report, and why. */
export interface SkillFailure {
  readonly code: ToolErrorCode;
  readonly message: string;
}

export type SkillOutcome<TValue> = Result<TValue, SkillFailure>;

/** What `skill_resource` returns for a file. */
export interface SkillResourceFile {
  readonly kind: 'file';
  readonly path: string;
  /** Size on disk, in bytes. */
  readonly size: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly text: string;
  /** Set when the file continues past `endLine`: the `startLine` that reads on. */
  readonly nextStartLine?: number;
}

/** What `skill_resource` returns for a directory. */
export interface SkillResourceListing {
  readonly kind: 'directory';
  readonly path: string;
  readonly entries: readonly { readonly path: string; readonly size?: number }[];
}

export type SkillResource = SkillResourceFile | SkillResourceListing;

export interface SkillResourceRequest {
  readonly skill: string;
  readonly path: string;
  readonly startLine?: number;
}

export interface SkillScriptRequest {
  readonly skill: string;
  readonly script: string;
  readonly input: JsonValue;
  readonly signal: AbortSignal;
}

export interface SkillScriptResult {
  readonly output: JsonValue;
  /** What the script wrote with `console.log`, bounded. */
  readonly logs: string;
  readonly logsTruncated: boolean;
  readonly durationMs: number;
}

/**
 * The tools' window onto the skill store. Every method resolves an outcome and
 * never rejects; a skill name or path that cannot be served is a `NOT_FOUND`
 * or `INVALID_ARGUMENT` failure, never an exception.
 *
 * `activate` is asynchronous because a skill may belong to an add-on: its body
 * is on the add-on's disk, downloaded on first use, and nothing is downloaded at
 * startup. The application ensures that add-on (once, sharing the load with any
 * other of its tools) before it answers.
 */
export interface SkillHost {
  /** Every loaded skill, sorted by name. */
  list(): readonly SkillSummary[];
  /** The activation of a loaded skill, or `NOT_FOUND`. */
  activate(name: string): Promise<SkillOutcome<SkillActivation>>;
  readResource(request: SkillResourceRequest): Promise<SkillOutcome<SkillResource>>;
  runScript(request: SkillScriptRequest): Promise<SkillOutcome<SkillScriptResult>>;
}

/** The one place that says which files `skill_script` can run: `.js`/`.mjs` under `scripts/`. */
export function isRunnableScriptPath(relativePath: string): boolean {
  return /^scripts\/.+\.m?js$/.test(relativePath);
}
