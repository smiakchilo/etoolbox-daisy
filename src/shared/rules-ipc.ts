import {
  parseSkillsOpenFolderResult,
  parseSkillsReloadResult,
  skillsOpenFolderResultSchema,
  skillsReloadResultSchema,
  type SkillsOpenFolderResult,
  type SkillsReloadResult,
} from './skills-ipc';

/**
 * `rules:open-folder` - the Settings "Skills" tab's **Custom rules folder**
 * link. Like `skills:open-folder` the request has **no payload**: main opens the
 * one fixed user-rules folder (`appPaths.rules`), creating it first when it does
 * not exist, and answers with the same result shape.
 */
export const rulesOpenFolderResultSchema = skillsOpenFolderResultSchema;

export type RulesOpenFolderResult = SkillsOpenFolderResult;

export function parseRulesOpenFolderResult(candidate: unknown): RulesOpenFolderResult {
  return parseSkillsOpenFolderResult(candidate);
}

/**
 * `rules:reload` - re-reads the user's rules. No payload; `count` is the number
 * of rules now loaded. Same result shape as `skills:reload`.
 */
export const rulesReloadResultSchema = skillsReloadResultSchema;

export type RulesReloadResult = SkillsReloadResult;

export function parseRulesReloadResult(candidate: unknown): RulesReloadResult {
  return parseSkillsReloadResult(candidate);
}
