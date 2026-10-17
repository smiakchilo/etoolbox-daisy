/**
 * The `/skillname` reference a user may type at the very start of a chat
 * prompt. This module owns the reading of that leading token as pure functions,
 * so the composer's autocomplete and the send-path rewrite
 * (`resolveSkillPrompt`, `skills/skillActivation.ts`) share one interpretation
 * of it (see `src/shared`'s no-Electron/no-Node/no-browser-globals rule).
 *
 * It also owns the *catalogue* the model is shown in its session instructions
 * (`renderSkillCatalogue`), which is what lets the model choose a skill from a
 * description on its own initiative rather than only when the user types
 * `/name` (see `docs/verification.md` "Skills are auto-inferred...").
 */

/**
 * The model-facing name of the app's `skill` tool (`src/tools/skill/`), which
 * loads a skill the same way for every agent. The transcript store treats a
 * call to it as internal plumbing rather than a user-visible tool call.
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

/** Where the skill list goes inside the catalogue template (`resources/rules/skills.md`). */
export const SKILL_CATALOGUE_PLACEHOLDER = '{{catalogue}}';

/** Replaced, wherever it appears, with {@link SKILL_TOOL_NAME}, so the tool's name has one source. */
export const SKILL_TOOL_PLACEHOLDER = '{{skillTool}}';

/**
 * The block appended to the session instructions that tells the model the
 * bundled skills exist, what each is for, and how to load one - so a request
 * that matches a skill's description is answered with that skill even when the
 * user never typed `/name`.
 *
 * The prose is the markdown resource `resources/rules/skills.md`, handed
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
 * of loading the skill (the failure the `/name` path's inlined activation
 * exists to prevent).
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
