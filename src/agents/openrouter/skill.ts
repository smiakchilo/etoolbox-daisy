import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  createToolError,
  err,
  newRequestId,
  ok,
  type IdGenerator,
  type JsonValue,
  type Result,
  type ToolError,
} from '../../shared';
import type { ToolSpec } from './types';

/**
 * The application-owned `skill` tool for OpenRouter.
 *
 * Copilot activates the bundled `resources/skills/<name>/SKILL.md` files
 * through its runtime's own built-in `skill` tool, which OpenRouter has no
 * equivalent of. Because the composer's `/skillname` rewrite
 * (`src/shared/skillInvocation.ts`) tells the model to call a tool named
 * exactly `skill`, this agent supplies its own: a read-only reader confined to
 * the host-supplied, application-owned `bundledSkillDirectories`.
 *
 * It confers no filesystem capability beyond those directories - a name is
 * matched against a strict pattern and the resolved path is proven to stay
 * inside its directory - so it is the narrowest possible way to keep the
 * skills subsystem working on a second provider. It is not an AEM read and is
 * deliberately not part of the host toolkit; it emits the same normalized
 * events through the service's `runTool` as any other tool.
 */

/** Skill names are directory names: a leading alphanumeric, then alphanumerics and hyphens. */
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

const SKILL_FILENAME = 'SKILL.md';

/** The bundled skill directory names, sorted and de-duplicated, best-effort. */
export async function listSkillNames(
  bundledSkillDirectories: readonly string[],
): Promise<readonly string[]> {
  const names = new Set<string>();
  for (const directory of bundledSkillDirectories) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && SKILL_NAME_PATTERN.test(entry.name)) names.add(entry.name);
    }
  }
  return [...names].sort();
}

/** The absolute `SKILL.md` path for `name` inside `directory`, or `undefined` if it would escape. */
function skillFilePath(directory: string, name: string): string | undefined {
  const base = path.resolve(directory);
  const candidate = path.resolve(base, name, SKILL_FILENAME);
  // `name` is pattern-checked, but prove containment anyway: a future relaxation
  // of the pattern must not silently become an arbitrary-file read.
  return candidate.startsWith(base + path.sep) ? candidate : undefined;
}

/**
 * Builds the `skill` {@link ToolSpec}, or `undefined` when no bundled skill
 * directory was supplied (nothing to load). `names` only shapes the
 * model-facing description; it is not a security boundary - the executor
 * re-validates every requested name.
 */
export function createSkillToolSpec(
  bundledSkillDirectories: readonly string[],
  names: readonly string[],
  idGenerator: IdGenerator,
): ToolSpec | undefined {
  if (bundledSkillDirectories.length === 0) return undefined;

  const available = names.length > 0 ? names.join(', ') : 'none';
  const description =
    'Load one of the application\u2019s bundled AEM skills by name and return its full ' +
    `instructions. Available skills: ${available}. Call this when the user's message begins ` +
    'with /<skillname>, or when they explicitly ask to use a skill, before acting on it.';

  const parameters = {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'The skill name, without a leading slash (e.g. "search").',
      },
    },
    required: ['skill'],
    additionalProperties: false,
  };

  return {
    name: 'skill',
    description,
    parameters,
    executor: async (args): Promise<Result<JsonValue, ToolError>> => {
      const rawName = args['skill'];
      const name = typeof rawName === 'string' ? rawName : '';
      if (!SKILL_NAME_PATTERN.test(name)) {
        return err(
          createToolError(
            'INVALID_ARGUMENT',
            `"${name}" is not a valid skill name`,
            newRequestId(idGenerator),
          ),
        );
      }
      for (const directory of bundledSkillDirectories) {
        const filePath = skillFilePath(directory, name);
        if (filePath === undefined) continue;
        try {
          const content = await readFile(filePath, 'utf8');
          return ok({ textResultForLlm: content, resultType: 'success' });
        } catch {
          // Not found in this directory; try the next.
        }
      }
      return err(
        createToolError(
          'INVALID_ARGUMENT',
          `No bundled skill named "${name}" exists`,
          newRequestId(idGenerator),
        ),
      );
    },
  };
}
