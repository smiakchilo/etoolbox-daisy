/**
 * The `/skillname` reference a user may type at the very start of a chat
 * prompt, and the model-facing rewrite that makes the agent actually load the
 * skill.
 *
 * Skills are bundled `SKILL.md` directories the runtime only reads through its
 * built-in `skill` tool; a leading `/name` is therefore not something the
 * model interprets on its own. This module owns both halves of that
 * convention - the composer's autocomplete and the send-path rewrite - as pure
 * functions so both share one interpretation of "the leading token" (see
 * `src/shared`'s no-Electron/no-Node/no-browser-globals rule).
 *
 * It also owns the *catalogue* the model is shown in its session instructions
 * (`renderSkillCatalogue`), which is what lets the model choose a skill from a
 * description on its own initiative rather than only when the user types
 * `/name` (see `docs/verification.md` "Skills are auto-inferred...").
 */

/**
 * The model-facing name of the runtime helper tool that loads a skill. Both
 * agents expose a tool by this name (Copilot's is runtime-built; OpenRouter
 * ships its own - see `src/agents/openrouter/skill.ts`), and the transcript
 * store treats a call to it as internal plumbing rather than a user-visible
 * tool call.
 */
export const SKILL_TOOL_NAME = 'skill';

/** One bundled skill as the model sees it: the name to load and why. */
export interface SkillCatalogueEntry {
  readonly name: string;
  readonly description: string;
}

export interface LeadingSkillToken {
  /** The skill name: the run of non-space characters immediately after the leading `/`. */
  readonly name: string;
  /** Whatever followed the name, with surrounding whitespace trimmed away. */
  readonly rest: string;
}

/**
 * Every bundled skill name begins with a letter or digit; this is the allowed
 * shape of one, so `/content/wknd` is still *read* as a token (the caller
 * decides whether it names a real skill) while a stray `/` alone is not.
 */
const LEADING_TOKEN_PATTERN = /^\/(\S+)/;

/**
 * Reads the leading `/skillname` reference, or `undefined` when `value` is not
 * one.
 *
 * Recognised only when the very first character is `/` and at least one
 * non-space character follows it. `/` alone, an empty string, and any prompt
 * with leading whitespace before the slash are not references. The caller
 * decides whether `name` names a real skill - an unknown leading token is
 * ordinary text, never an error.
 */
export function readLeadingSkillToken(value: string): LeadingSkillToken | undefined {
  const match = LEADING_TOKEN_PATTERN.exec(value);
  if (match === null) return undefined;
  const name = match[1];
  if (name === undefined) return undefined;
  return { name, rest: value.slice(match[0].length).trimStart() };
}

/**
 * The skills whose name begins with `fragment`, in their original order.
 * Case-insensitive; an empty fragment matches every skill.
 */
export function filterSkillsByName<T extends { readonly name: string }>(
  skills: readonly T[],
  fragment: string,
): readonly T[] {
  if (fragment === '') return skills;
  const needle = fragment.toLowerCase();
  return skills.filter((skill) => skill.name.toLowerCase().startsWith(needle));
}

/**
 * The one line the model reads when a known skill was explicitly invoked. It
 * names the exact tool and argument so activation cannot be mistaken for the
 * user merely mentioning a skill by name.
 *
 * When the user supplied trailing text, that text is framed explicitly as this
 * skill's input and the model is told not to ask the user to restate it. This
 * directive is the only place the two are joined: the model never sees the
 * literal `/skillname` token, and a bare appended word is otherwise read as an
 * unrelated remark. Observed live (2026-10-06): `/search Waldo` loaded the
 * `search` skill, then the model answered "What would you like to search for?".
 */
export function renderSkillInvocationDirective(name: string, rest: string): string {
  const directive =
    `The user has explicitly invoked the "${name}" skill. Load it first by calling the ` +
    `\`${SKILL_TOOL_NAME}\` tool with {"${SKILL_TOOL_NAME}":"${name}"}, then follow its guidance.`;
  if (rest === '') return directive;
  return (
    `${directive}\n\n` +
    `The text below is the user's input for this skill. Act on it directly; do not ` +
    `ask the user to restate it.\n\n${rest}`
  );
}

/** Where the skill list goes inside the catalogue template (`resources/instructions/skills.md`). */
export const SKILL_CATALOGUE_PLACEHOLDER = '{{catalogue}}';

/** Replaced, wherever it appears, with {@link SKILL_TOOL_NAME}, so the tool's name has one source. */
export const SKILL_TOOL_PLACEHOLDER = '{{skillTool}}';

/**
 * The block appended to the session instructions that tells the model the
 * bundled skills exist, what each is for, and how to load one - so a request
 * that matches a skill's description is answered with that skill even when the
 * user never typed `/name`.
 *
 * The prose is the markdown resource `resources/instructions/skills.md`, handed
 * in as `template` (this module is shared code and reads no files). It must
 * contain exactly one {@link SKILL_CATALOGUE_PLACEHOLDER}, replaced by the list
 * of skills; a template without one throws. {@link SKILL_TOOL_PLACEHOLDER} may
 * appear any number of times.
 *
 * Returns `""` for an empty catalogue, so an install with no skills adds
 * nothing rather than an empty "Available skills:" heading. The entries are
 * the model-facing `description` from each `SKILL.md`, never the shorthanded
 * user-facing summary shown in the composer's `/` menu.
 *
 * The wording is load-bearing: without "load it ... before acting" the model
 * reads the list as documentation and answers from its own knowledge instead
 * of loading the skill (the same failure `renderSkillInvocationDirective`
 * exists to prevent for the explicit `/name` path).
 */
export function renderSkillCatalogue(
  template: string,
  skills: readonly SkillCatalogueEntry[],
): string {
  if (template.split(SKILL_CATALOGUE_PLACEHOLDER).length !== 2) {
    throw new Error(
      `The skill catalogue template must contain exactly one ${SKILL_CATALOGUE_PLACEHOLDER}`,
    );
  }
  if (skills.length === 0) return '';
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`);
  return template
    .replaceAll(SKILL_TOOL_PLACEHOLDER, SKILL_TOOL_NAME)
    .replace(SKILL_CATALOGUE_PLACEHOLDER, () => lines.join('\n'))
    .trim();
}

/**
 * Rewrites a prompt that begins with a *known* `/skillname` into the text the
 * model actually receives, and returns `prompt` unchanged for everything else -
 * a prompt with no leading token, or one whose token names no known skill. The
 * caller keeps the user's own text for display and the journal; only what the
 * model reads is rewritten.
 */
export function resolveSkillPrompt(prompt: string, knownSkillNames: readonly string[]): string {
  const token = readLeadingSkillToken(prompt);
  if (token === undefined) return prompt;
  if (!knownSkillNames.includes(token.name)) return prompt;
  return renderSkillInvocationDirective(token.name, token.rest);
}
