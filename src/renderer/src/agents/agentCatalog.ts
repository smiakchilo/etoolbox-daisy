/// <reference types="vite/client" />
import { buildAgentCatalog, type AgentDefinition } from '../../../shared';

/**
 * The agents this build contains, read from every
 * `src/agents/<name>/meta.ts`. The glob is eager and matches only the
 * SDK-free `meta.ts` - never `agent.ts` - so the renderer bundle can never
 * pull in a provider SDK. Nothing else in the renderer names an agent.
 */
export const AGENT_DEFINITIONS: readonly AgentDefinition[] = buildAgentCatalog(
  import.meta.glob('../../../agents/*/meta.ts', { eager: true }),
).definitions;