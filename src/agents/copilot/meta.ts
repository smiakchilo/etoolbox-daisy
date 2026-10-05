import type { AgentMeta } from '../../shared';

/**
 * GitHub Copilot's manifest. SDK-free and Node-free on purpose: the renderer
 * globs every `src/agents/<name>/meta.ts` to list agents in Settings, so this
 * file must never import the SDK (that belongs to `agent.ts` and below).
 */
export const meta: AgentMeta = {
  id: 'copilot' as AgentMeta['id'],
  label: 'GitHub Copilot',
  requiresAuth: true,
  // Copilot signs in through the CLI's web OAuth flow (`copilot login
  // --web-flow`), so its item offers Sign in / Sign out.
  supportsInteractiveLogin: true,
};
