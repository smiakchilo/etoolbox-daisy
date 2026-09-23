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
 */

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
 */
export function renderSkillInvocationDirective(name: string, rest: string): string {
  const directive =
    `The user has explicitly invoked the "${name}" skill. Load it first by calling the ` +
    `\`skill\` tool with {"skill":"${name}"}, then follow its guidance.`;
  return rest === '' ? directive : `${directive}\n\n${rest}`;
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
