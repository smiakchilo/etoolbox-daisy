import { type ToolModule } from '../../shared';
import {
  ENVIRONMENT_FACTS_ALLOWLIST_ENTRY,
  ENVIRONMENT_FACTS_TOOL_DESCRIPTOR,
  ENVIRONMENT_FACTS_TOOL_NAME,
  createEnvironmentFactsExecutor,
} from './environmentFacts';

/**
 * The plugin manifest the main-process registry discovers. Delete this folder
 * to remove the tool.
 *
 * No `aem_` prefix: the action is not AEM-specific - "environment facts" is a
 * question any environment could answer (AGENTS.md section 5).
 */
export const tool: ToolModule = {
  name: ENVIRONMENT_FACTS_TOOL_NAME,
  descriptor: ENVIRONMENT_FACTS_TOOL_DESCRIPTOR,
  allowlistEntry: ENVIRONMENT_FACTS_ALLOWLIST_ENTRY,
  instructions:
    "The 'environment_facts' tool reports every AEM host the application knows about - each " +
    "host's label, origin and content/component roots - and marks the one the browser pane is " +
    'currently on. Use it to turn an environment a user names (for example "HPE DEV", or the ' +
    'staging instance) into the host to act on, and to learn where content lives on that host.',
  createExecutor: (host) => createEnvironmentFactsExecutor(host),
};
