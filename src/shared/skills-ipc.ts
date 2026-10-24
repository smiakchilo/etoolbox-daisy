import { z } from 'zod';

/**
 * `skills:open-folder` - the Settings "Skills" tab's **Custom skills folder**
 * link. The request has **no payload**: main opens the one fixed user-skills
 * folder (`appPaths.skills`), creating it first when it does not exist, so the
 * renderer can never point the OS at an arbitrary path.
 */
export const skillsErrorCodeSchema = z.enum(['untrusted_sender', 'open_failed', 'reload_failed']);

export type SkillsErrorCode = z.infer<typeof skillsErrorCodeSchema>;

export const skillsOpenFolderResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: skillsErrorCodeSchema, message: z.string().max(500) }).strict(),
    })
    .strict(),
]);

export type SkillsOpenFolderResult = Readonly<z.infer<typeof skillsOpenFolderResultSchema>>;

export function parseSkillsOpenFolderResult(candidate: unknown): SkillsOpenFolderResult {
  return skillsOpenFolderResultSchema.parse(candidate);
}

/**
 * `skills:reload` - re-reads both skill sources. No payload. On success `count`
 * is the number of skills now loaded (a skill rejected for being malformed is
 * not counted; it is logged as `SKILL_REJECTED`).
 */
export const skillsReloadResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), count: z.number().int().nonnegative() }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: skillsErrorCodeSchema, message: z.string().max(500) }).strict(),
    })
    .strict(),
]);

export type SkillsReloadResult = Readonly<z.infer<typeof skillsReloadResultSchema>>;

export function parseSkillsReloadResult(candidate: unknown): SkillsReloadResult {
  return skillsReloadResultSchema.parse(candidate);
}
