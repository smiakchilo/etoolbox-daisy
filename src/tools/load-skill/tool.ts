import { type ModelToolModule, SKILL_TOOL_NAME } from '../../shared';
import {
  SKILL_TOOL_ALLOWLIST_ENTRY,
  SKILL_TOOL_DESCRIPTOR,
  createSkillExecutor,
} from './loadSkill';

/** The plugin manifest the main-process registry discovers. Delete this folder to remove the tool. */
export const tool: ModelToolModule = {
  name: SKILL_TOOL_NAME,
  descriptor: SKILL_TOOL_DESCRIPTOR,
  allowlistEntry: SKILL_TOOL_ALLOWLIST_ENTRY,
  instructions:
    "Loads a skill from the catalogue by name. Its result is the skill's instructions, which you " +
    'then follow. If the skill lists files, open one with skill_resource and run a listed script ' +
    "with skill_script; never look for a skill's files by any other route.",
  createExecutor: (host) => createSkillExecutor(host),
};
