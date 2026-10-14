import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { AgentChatSkill, SkillCatalogueEntry } from '../../shared';

/**
 * Reads the application's own bundled skill catalogue for the composer's `/`
 * autocomplete.
 *
 * The runtime loads the *bodies* of these `SKILL.md` files itself through its
 * `skill` tool; this module only needs the three front-matter fields the
 * autocomplete uses - `name`, `description` and `user-invocable` - so it parses
 * them directly rather than asking the runtime (which would require a live
 * session, and would leave the feature unavailable under the deterministic
 * fake).
 *
 * The directory is resolved by the composition root from the application's own
 * install location (`agentComposition.ts`'s `resolveBundledResourcesDirectory`) and
 * is never sourced from settings, the user's home, or an AEM response, so this
 * reads a fixed, application-owned tree. A missing or unreadable entry is
 * skipped: the catalogue is a convenience and must never fail the app.
 */

const FRONT_MATTER_DELIMITER = '---';
const DESCRIPTION_MAX_LENGTH = 4000;

export interface ParsedSkillFrontMatter {
  readonly name: string;
  readonly description: string;
  /**
   * The user-facing one-phrase summary, from the front matter's
   * `metadata.user-description` (or a top-level `user-description`), or `''`
   * when neither is present. A skill's `description` is written for the model
   * and carries technical detail; `user-description` is what the app shows the
   * user (the home screen, the composer's skill list).
   */
  readonly userDescription: string;
  /**
   * Whether the skill belongs in the user's `/` menu. Follows the Agent Skills
   * convention: `user-invocable` defaults to `true`, and `false` marks a skill
   * the model may still load but the user is not offered by name (an
   * "agent-only background skill").
   */
  readonly userInvocable: boolean;
}

/**
 * The Agent Skills front matter accepts `yes`/`no`/`on`/`off`/`1`/`0` in any
 * letter case in addition to `true`/`false`; an absent or unrecognised value
 * falls back to the field's own default.
 */
function parseFrontMatterBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  switch (value.trim().toLowerCase()) {
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

/** Strips one matching pair of surrounding single or double quotes, if present. */
function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value.charAt(0);
  const last = value.charAt(value.length - 1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parses the leading `---`-delimited front-matter block of a `SKILL.md`.
 *
 * Deliberately minimal: the bundle's front matter is a flat list of
 * `key: value` lines plus one optional nested block - a `metadata:` line (with
 * no value) whose indented children are read too, so `metadata.user-description`
 * is available. Only the handful of fields above are read, so a full YAML
 * parser would be an unearned dependency. Returns `undefined` when the block is
 * absent, unterminated, or carries no non-empty `name`.
 */
export function parseSkillFrontMatter(markdown: string): ParsedSkillFrontMatter | undefined {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONT_MATTER_DELIMITER) return undefined;
  const endIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONT_MATTER_DELIMITER,
  );
  if (endIndex === -1) return undefined;

  const fields = new Map<string, string>();
  const metadata = new Map<string, string>();
  let inMetadata = false;
  for (const line of lines.slice(1, endIndex)) {
    if (line.trim() === '') continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (key === '') continue;
    const value = stripQuotes(line.slice(separator + 1).trim());
    // Indented lines under a bare `metadata:` belong to that block; any other
    // line (indented or not) is top-level, which also closes the block.
    if (inMetadata && /^\s/.test(line)) {
      metadata.set(key, value);
      continue;
    }
    inMetadata = key === 'metadata' && value === '';
    if (key !== 'metadata') fields.set(key, value);
  }

  const name = fields.get('name');
  if (name === undefined || name === '') return undefined;
  return {
    name,
    description: fields.get('description') ?? '',
    userDescription: metadata.get('user-description') ?? fields.get('user-description') ?? '',
    userInvocable: parseFrontMatterBoolean(fields.get('user-invocable'), true),
  };
}

/** The two views of one directory read: what the composer offers, and what the model is told. */
interface SkillCatalogueRead {
  /** User-invocable skills, for the composer's `/` autocomplete. */
  readonly invocable: readonly AgentChatSkill[];
  /**
   * Every skill with a usable description, for the session instructions. This
   * deliberately includes skills with `user-invocable: false`: those are the
   * "agent-only" skills the model is meant to load on its own, so withholding
   * them from the model's catalogue would defeat their purpose.
   */
  readonly model: readonly SkillCatalogueEntry[];
}

/**
 * Reads every `<directory>/<skill>/SKILL.md` once and projects it onto the two
 * catalogues above, sorted by name for a stable order.
 *
 * The `description` a skill is reported to the *user* with is its user-facing
 * summary: the front matter's `metadata.user-description` when present, else
 * the technical `description`. The model is given the technical `description`
 * instead (falling back to the user summary only when no technical one exists),
 * because that is the text written to tell the model when to load the skill.
 * The body itself is never read here - the runtime loads it through the `skill`
 * tool. Never rejects: a missing directory, an unreadable file, or a file
 * without usable front matter is simply omitted.
 */
async function readSkillCatalogue(directory: string): Promise<SkillCatalogueRead> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return { invocable: [], model: [] };
  }

  const invocable: AgentChatSkill[] = [];
  const model: SkillCatalogueEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let markdown: string;
    try {
      markdown = await readFile(path.join(directory, entry.name, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    const parsed = parseSkillFrontMatter(markdown);
    if (parsed === undefined) continue;
    const userFacing = parsed.userDescription === '' ? parsed.description : parsed.userDescription;
    if (parsed.userInvocable) {
      invocable.push({
        name: parsed.name,
        description: userFacing.slice(0, DESCRIPTION_MAX_LENGTH),
      });
    }
    const modelFacing = parsed.description === '' ? parsed.userDescription : parsed.description;
    model.push({
      name: parsed.name,
      description: modelFacing.slice(0, DESCRIPTION_MAX_LENGTH),
    });
  }
  const byName = (left: { name: string }, right: { name: string }): number =>
    left.name.localeCompare(right.name);
  invocable.sort(byName);
  model.sort(byName);
  return { invocable, model };
}

/**
 * Reads and parses every user-invocable `<directory>/<skill>/SKILL.md`, sorted
 * by name for a stable order, for the composer's `/` autocomplete. See
 * {@link readSkillCatalogue} for the shared read and the description rules; the
 * model-facing half is exposed through {@link createSkillCatalog}'s
 * `modelCatalogue`.
 */
export async function readSkillCatalog(directory: string): Promise<AgentChatSkill[]> {
  return [...(await readSkillCatalogue(directory)).invocable];
}

/**
 * A lazily-read, single-flight view of the catalogue.
 *
 * `load()` performs one filesystem read no matter how many callers ask, and
 * caches the result (including a failed read, as an empty catalogue, so a
 * broken install is not re-read on every prompt). `current()` is the
 * synchronous snapshot the send path consults - it is `[]` until the first
 * `load()` resolves, which is exactly "no skills are known yet", so a prompt
 * sent before the catalogue arrives is passed through unchanged.
 *
 * `modelCatalogue()` is the synchronous model-facing snapshot (every skill,
 * with its technical description). It is `[]` until the same `load()` resolves,
 * so the session instructions must be composed after `load()` - see
 * `src/main/index.ts`, which awaits it before the agent starts.
 */
export interface SkillCatalog {
  load(): Promise<readonly AgentChatSkill[]>;
  current(): readonly AgentChatSkill[];
  modelCatalogue(): readonly SkillCatalogueEntry[];
}

export function createSkillCatalog(directory: string): SkillCatalog {
  let loaded: SkillCatalogueRead | undefined;
  let inFlight: Promise<readonly AgentChatSkill[]> | undefined;

  return {
    load(): Promise<readonly AgentChatSkill[]> {
      if (loaded !== undefined) return Promise.resolve(loaded.invocable);
      inFlight ??= readSkillCatalogue(directory).then(
        (read) => {
          loaded = read;
          return read.invocable;
        },
        () => {
          loaded = { invocable: [], model: [] };
          return loaded.invocable;
        },
      );
      return inFlight;
    },
    current(): readonly AgentChatSkill[] {
      return loaded?.invocable ?? [];
    },
    modelCatalogue(): readonly SkillCatalogueEntry[] {
      return loaded?.model ?? [];
    },
  };
}
