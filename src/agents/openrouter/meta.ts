import type { AgentMeta } from '../../shared';

/**
 * OpenRouter's manifest. SDK-free and Node-free on purpose: the renderer globs
 * every `src/agents/<name>/meta.ts` to list agents in Settings, so this file
 * must never import the SDK (that belongs to `agent.ts` and below).
 */
export const meta: AgentMeta = {
  id: 'openrouter' as AgentMeta['id'],
  label: 'OpenRouter',
  requiresAuth: true,
  // OpenRouter authenticates with an API key the user pastes into the Token
  // field; there is no interactive sign-in, so its item offers no Sign in
  // control (see AgentDefinition.supportsInteractiveLogin).
  supportsInteractiveLogin: false,
};
