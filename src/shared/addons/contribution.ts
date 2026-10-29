import { z } from 'zod';
import {
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_PATTERN,
  isRunnableScriptPath,
} from '../skills';

/**
 * What an add-on contributes: its tools, and the catalogue entries of its
 * skills.
 *
 * **Tools are declared; skills are derived.** `src/addons/<id>/addon.json`
 * declares each tool completely (the model-facing descriptor, the allowlist
 * entry, the instructions and the transcript billet), and `scripts/build-addons.mjs`
 * derives each skill entry from that skill's own `SKILL.md` front matter with
 * this application's own parser. The build validates both and writes the result
 * into the pins (`src/shared/addons/pins.json`), which is the only run-time
 * source: the application advertises an add-on's tools and skills before it has
 * ever downloaded the add-on, and it reads their names, schemas and billets as
 * plain data.
 *
 * Nothing here names an add-on. A tool declaration is data a tool's author
 * writes, not application knowledge.
 */

/** A contributed tool's name: `snake_case`, exactly like every application tool. */
export const CONTRIBUTED_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** The transcript presentations a contributed tool may declare. */
export const CONTRIBUTED_TOOL_PRESENTATIONS = ['billet', 'report'] as const;

export type ContributedToolPresentation = (typeof CONTRIBUTED_TOOL_PRESENTATIONS)[number];

/**
 * One value a billet row reads from the call's own arguments. `path` names a
 * top-level parameter of the tool's descriptor (the build checks it), an absent
 * or empty value falls back to `fallback`, and an array is joined with `join`.
 * A value that is still absent is omitted - never rendered blank.
 */
export const billetValueSchema = z
  .object({
    path: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
    fallback: z.string().max(200).optional(),
    /** The separator for an array value (e.g. `", "`); absent renders the array as-is. */
    join: z.string().max(8).optional(),
  })
  .strict();

export type BilletValueSpec = z.infer<typeof billetValueSchema>;

/** One Title-cased row of the expanded billet. */
export const billetRowSchema = z
  .object({
    label: z.string().min(1).max(60),
    value: billetValueSchema,
  })
  .strict();

export type BilletRowSpec = z.infer<typeof billetRowSchema>;

/** The collapsed summary plus the expanded rows of a contributed tool's billet. */
export const billetSpecSchema = z
  .object({
    summary: billetValueSchema.optional(),
    rows: z.array(billetRowSchema).max(12).default([]),
  })
  .strict();

export type BilletSpec = z.infer<typeof billetSpecSchema>;

/** One tool an add-on offers the model, as the application advertises it. */
export const contributedToolSchema = z
  .object({
    name: z.string().regex(CONTRIBUTED_TOOL_NAME_PATTERN),
    descriptor: z
      .object({
        name: z.string().regex(CONTRIBUTED_TOOL_NAME_PATTERN),
        description: z.string().min(1).max(20_000),
        /** The JSON Schema the model sees; the add-on re-validates with its own schema. */
        parameters: z.record(z.string(), z.unknown()),
      })
      .strict(),
    allowlistEntry: z.string().min(1).max(128),
    instructions: z.string().min(1).max(20_000),
    presentation: z.enum(CONTRIBUTED_TOOL_PRESENTATIONS).optional(),
    billet: billetSpecSchema.optional(),
  })
  .strict();

export type ContributedTool = z.infer<typeof contributedToolSchema>;

/**
 * One skill catalogue entry, derived from a skill's `SKILL.md` front matter at
 * build time. The skill's body and files stay in the add-on: only the catalogue
 * entry ships in the pins, so the composer, the home screen and the model's
 * catalogue can list the skill before the add-on is downloaded.
 */
export const contributedSkillSchema = z
  .object({
    name: z.string().regex(SKILL_NAME_PATTERN),
    description: z.string().min(1).max(SKILL_DESCRIPTION_MAX_LENGTH),
    userDescription: z.string().max(SKILL_DESCRIPTION_MAX_LENGTH),
    userInvocable: z.boolean(),
    disableModelInvocation: z.boolean(),
    tableOnly: z.boolean(),
    hasScripts: z.boolean(),
  })
  .strict();

export type ContributedSkill = z.infer<typeof contributedSkillSchema>;

/** Everything one add-on contributes, as the pins carry it. */
export const addonContributionsSchema = z
  .object({
    tools: z.array(contributedToolSchema).default([]),
    skills: z.array(contributedSkillSchema).default([]),
  })
  .strict();

export type AddonContributions = z.infer<typeof addonContributionsSchema>;

/** What `addon.json` declares: tools only. Skills are derived from their folders. */
export const addonContributionDeclarationSchema = z
  .object({
    tools: z.array(contributedToolSchema).default([]),
  })
  .strict();

export type AddonContributionDeclaration = z.infer<typeof addonContributionDeclarationSchema>;

/** Whether a skill folder carries at least one script `skill_script` can run. */
export function hasRunnableScript(files: readonly string[]): boolean {
  return files.some((file) => isRunnableScriptPath(file));
}
