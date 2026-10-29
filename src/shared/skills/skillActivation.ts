import { SKILL_TOOL_NAME, readLeadingSkillToken } from '../skillInvocation';
import { type SkillActivation, type SkillFileEntry, isRunnableScriptPath } from './skillTypes';

/** The file list in an activation is capped here, so a large skill does not flood the context. */
export const ACTIVATION_FILE_LIST_LIMIT = 50;

/** The `skill_resource` tool's model-facing name. */
export const SKILL_RESOURCE_TOOL_NAME = 'skill_resource';

/** The `skill_script` tool's model-facing name. */
export const SKILL_SCRIPT_TOOL_NAME = 'skill_script';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function describeFiles(files: readonly SkillFileEntry[]): string {
  const shown = files
    .slice(0, ACTIVATION_FILE_LIST_LIMIT)
    .map((file) => `${file.path} (${formatSize(file.size)})`);
  const more = files.length - shown.length;
  if (more > 0) {
    shown.push(`${more} more - list them with ${SKILL_RESOURCE_TOOL_NAME} path "."`);
  }
  return shown.join(', ');
}

/**
 * The text a skill is loaded as, whether the model called `load_skill` or the
 * user typed `/name`: the body without its front matter, introduced by a header that
 * says which of the skill's own files exist and how to reach them. A skill's
 * files are reachable only through the two tools, never by a path, so the
 * header is what keeps the model from guessing at the filesystem.
 *
 * A tool line appears only for what the skill actually has: nothing for a skill
 * with only a `SKILL.md`, no script line without a runnable script.
 *
 * `memos` - the skill's rendered memo block, if any - follows the body inside
 * the `<skill>` element, so the lessons learned travel with the skill.
 */
export function renderSkillActivation(activation: SkillActivation, memos = ''): string {
  const lines = [`<skill name="${activation.name}">`];
  const example = activation.files[0];
  if (example !== undefined) {
    lines.push(
      "This skill's own files are reachable only through tools, never by a filesystem path.",
      `Files: ${describeFiles(activation.files)}`,
      `- Open a file: ${SKILL_RESOURCE_TOOL_NAME} ${JSON.stringify({ skill: activation.name, path: example.path })}`,
    );
    const script = activation.files.find((file) => isRunnableScriptPath(file.path));
    if (script !== undefined) {
      lines.push(
        `- Run a script: ${SKILL_SCRIPT_TOOL_NAME} ${JSON.stringify({ skill: activation.name, script: script.path, input: {} })}`,
      );
    }
    lines.push(
      'A relative link below (./references/x.md, references/x.md, [x](x.md)) names one of these files.',
      '',
    );
  }
  lines.push(activation.body.trim());
  if (memos.trim() !== '') lines.push('', memos.trim());
  lines.push('</skill>');
  return lines.join('\n');
}

/**
 * The line that follows an explicitly loaded skill in a `/name` prompt, so the
 * model does not call `load_skill` for what it already holds.
 */
export function renderSkillAlreadyLoadedNote(name: string): string {
  return `The "${name}" skill above is already loaded - do not call the \`${SKILL_TOOL_NAME}\` tool for it.`;
}

/**
 * Finds a skill's activation by name; `undefined` when there is no such skill or it
 * cannot be loaded. Asynchronous because an add-on's skill lives on a folder the
 * application may have to download first.
 */
export type SkillActivationLookup = (name: string) => Promise<SkillActivation | undefined>;

/** What the model reads for a prompt, and which skill (if any) that prompt loaded. */
export interface SkillPromptResolution {
  readonly modelPrompt: string;
  /** Set when a leading `/name` loaded a skill into `modelPrompt`. */
  readonly activatedSkill?: string;
}

/**
 * Rewrites a prompt that begins with a *known* `/skillname` into the text the
 * model actually receives: the skill's activation block (the very text the
 * `load_skill` tool would return), the line saying it is already loaded, and
 * then what the user is asking for - that text framed as the skill's input when
 * they typed more, or the directive to run the skill now when they typed only
 * its name. The model never sees the literal `/skillname` token, and a bare
 * appended word is otherwise read as an unrelated remark (observed live,
 * 2026-10-06: `/search Waldo` loaded the skill, then the model asked "What
 * would you like to search for?").
 *
 * A bare `/name` needs that directive as much as the framed input does: without
 * it the activation is only background prose, and a model can answer with an
 * acknowledgement of the material instead of running the procedure (observed
 * live, 2026-10-26: the first `/name` of a session replied "Understood. I'll
 * follow ... in mind" and called no tool at all).
 *
 * Everything else - no leading token, or a token naming no loadable skill - is
 * returned unchanged. The caller keeps the user's own text for display and the
 * journal; only what the model reads is rewritten. `memos` is the named
 * skill's rendered memo block (see {@link renderSkillActivation}).
 */
export async function resolveSkillPrompt(
  prompt: string,
  lookup: SkillActivationLookup,
  memos = '',
): Promise<SkillPromptResolution> {
  const token = readLeadingSkillToken(prompt);
  if (token === undefined) return { modelPrompt: prompt };
  const activation = await lookup(token.name);
  if (activation === undefined) return { modelPrompt: prompt };
  const parts = [
    renderSkillActivation(activation, memos),
    renderSkillAlreadyLoadedNote(activation.name),
  ];
  if (token.rest !== '') {
    parts.push(
      "The text below is the user's input for this skill. Act on it directly by starting the " +
        "skill's procedure with it, from its first step; do not ask the user to restate it, and " +
        `do not answer with an acknowledgement of the skill.\n\n${token.rest}`,
    );
  } else {
    parts.push(
      'The user invoked this skill just now. Run its procedure from its first step, using the ' +
        "conversation's current context; do not reply with an acknowledgement of the skill, a " +
        'summary of it, or a question about what to do.',
    );
  }
  return { modelPrompt: parts.join('\n\n'), activatedSkill: activation.name };
}
