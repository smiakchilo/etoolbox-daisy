import {
  parseSkillsOpenFolderResult,
  skillsOpenFolderResultSchema,
  type SkillsOpenFolderResult,
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
