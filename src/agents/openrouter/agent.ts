import type { AgentModule } from '../../shared';
import { meta } from './meta';
import { createOpenRouterRuntime } from './runtime';

/**
 * OpenRouter's plugin entry point. Loaded lazily, in isolation, by
 * `src/main/agents/registry.ts` - so this is the only file (with the modules it
 * imports) that ever pulls in `@openrouter/agent`/`@openrouter/sdk`. If it
 * throws on import, only this agent is lost.
 */
export const agent: AgentModule = {
  id: meta.id,
  createRuntime: createOpenRouterRuntime,
};
