import { type ModelToolModule, SKILL_SCRIPT_TOOL_NAME } from '../../shared';
import {
  SKILL_SCRIPT_ALLOWLIST_ENTRY,
  SKILL_SCRIPT_TOOL_DESCRIPTOR,
  createSkillScriptExecutor,
} from './skillScript';

/** The plugin manifest the main-process registry discovers. Delete this folder to remove the tool. */
export const tool: ModelToolModule = {
  name: SKILL_SCRIPT_TOOL_NAME,
  descriptor: SKILL_SCRIPT_TOOL_DESCRIPTOR,
  allowlistEntry: SKILL_SCRIPT_ALLOWLIST_ENTRY,
  instructions:
    'Runs a script a loaded skill lists, with the JSON input that skill describes. Scripts only ' +
    'compute: they cannot read files, call the network or reach AEM, so gather data with the AEM ' +
    'tools and pass it in as input.',
  createExecutor: (host) => createSkillScriptExecutor(host),
};
