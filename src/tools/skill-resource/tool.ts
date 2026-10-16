import { type ModelToolModule, SKILL_RESOURCE_TOOL_NAME } from '../../shared';
import {
  SKILL_RESOURCE_ALLOWLIST_ENTRY,
  SKILL_RESOURCE_TOOL_DESCRIPTOR,
  createSkillResourceExecutor,
} from './skillResource';

/** The plugin manifest the main-process registry discovers. Delete this folder to remove the tool. */
export const tool: ModelToolModule = {
  name: SKILL_RESOURCE_TOOL_NAME,
  descriptor: SKILL_RESOURCE_TOOL_DESCRIPTOR,
  allowlistEntry: SKILL_RESOURCE_ALLOWLIST_ENTRY,
  instructions:
    "Reads a loaded skill's own file by its path inside the skill (never a filesystem path). " +
    'When a skill links to references/x.md, open it with this tool. Read only what the task needs.',
  createExecutor: (host) => createSkillResourceExecutor(host),
};
