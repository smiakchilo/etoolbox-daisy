import { parse } from 'yaml';

/**
 * Reads the leading `---`-delimited front-matter block of a `SKILL.md`.
 *
 * The block is real YAML (folded `>` and literal `|` descriptions, quoted
 * values, nested `metadata:`), parsed by the `yaml` package. Only the fields the
 * application honours are read (docs/skill-subsystem-plan.md section 5); every
 * other key, `allowed-tools` included, is ignored.
 */

const FRONT_MATTER_DELIMITER = '---';

export interface ParsedSkillFrontMatter {
  readonly name: string;
  readonly description: string;
  /**
   * The user-facing one-phrase summary, from `metadata.user-description` (or a
   * top-level `user-description`), or `''` when neither is present. A skill's
   * `description` is written for the model; this is what the app shows the user.
   */
  readonly userDescription: string;
  /** Whether the skill belongs in the user's `/` menu. Defaults to `true`. */
  readonly userInvocable: boolean;
  /** `disable-model-invocation: true` leaves the skill out of the model's catalogue. Defaults to `false`. */
  readonly disableModelInvocation: boolean;
}

export interface SplitSkillMarkdown {
  /** The raw YAML between the delimiters. */
  readonly frontMatter: string;
  /** Everything after the closing delimiter, with the leading blank line removed. */
  readonly body: string;
}

/**
 * Accepts `yes`/`no`/`on`/`off`/`1`/`0` in any letter case in addition to
 * `true`/`false`; an absent or unrecognised value falls back to the field's own
 * default.
 */
function readBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : undefined;
  if (text === undefined) return fallback;
  switch (text.trim().toLowerCase()) {
    case 'true':
    case 'yes':
    case 'on':
    case '1':
      return true;
    case 'false':
    case 'no':
    case 'off':
    case '0':
      return false;
    default:
      return fallback;
  }
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Splits a `SKILL.md` into its front matter and body; `undefined` when there is no terminated block. */
export function splitSkillMarkdown(markdown: string): SplitSkillMarkdown | undefined {
  const text = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONT_MATTER_DELIMITER) return undefined;
  const endIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONT_MATTER_DELIMITER,
  );
  if (endIndex === -1) return undefined;
  return {
    frontMatter: lines.slice(1, endIndex).join('\n'),
    body: lines
      .slice(endIndex + 1)
      .join('\n')
      .replace(/^\s*\n/, ''),
  };
}

/**
 * Parses a `SKILL.md`'s front matter. Returns `undefined` when the block is
 * absent, unterminated, not valid YAML, not a mapping, or carries no non-empty
 * string `name`.
 */
export function parseSkillFrontMatter(markdown: string): ParsedSkillFrontMatter | undefined {
  const split = splitSkillMarkdown(markdown);
  if (split === undefined) return undefined;

  let document: unknown;
  try {
    document = parse(split.frontMatter);
  } catch {
    return undefined;
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return undefined;
  }
  const fields = document as Record<string, unknown>;

  const name = readText(fields['name']);
  if (name === '') return undefined;

  const metadata = fields['metadata'];
  const nested =
    typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
      ? readText((metadata as Record<string, unknown>)['user-description'])
      : '';

  return {
    name,
    description: readText(fields['description']),
    userDescription: nested !== '' ? nested : readText(fields['user-description']),
    userInvocable: readBoolean(fields['user-invocable'], true),
    disableModelInvocation: readBoolean(fields['disable-model-invocation'], false),
  };
}
