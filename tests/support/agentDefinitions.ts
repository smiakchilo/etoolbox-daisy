import type { AgentDefinition } from '../../src/shared';
import { agentIdSchema } from '../../src/shared';

/**
 * The fixed provider set the unit tests run against. The application derives
 * its definitions from the `src/agents/<name>/meta.ts` files present in the
 * build; tests that exercise generic behaviour pin one concrete list instead so
 * they do not change when an agent folder is added or removed.
 */
export const TEST_AGENT_ID = agentIdSchema.parse('copilot');

export const TEST_AGENT_DEFINITION: AgentDefinition = {
  id: TEST_AGENT_ID,
  label: 'GitHub Copilot',
  requiresAuth: true,
};

export const TEST_AGENT_DEFINITIONS: readonly AgentDefinition[] = [TEST_AGENT_DEFINITION];
