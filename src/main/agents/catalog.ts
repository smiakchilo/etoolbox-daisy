/// <reference types="vite/client" />
import { buildAgentCatalog, type AgentCatalogResult } from '../../shared';

/**
 * The main-process view of which agents this build contains: the eager glob of
 * every `src/agents/<name>/meta.ts` (the same files the renderer globs), so
 * both processes list the identical agents. Only the SDK-free `meta.ts` is
 * matched here - `agent.ts` is loaded lazily by `./registry`.
 */
export function discoverAgentCatalog(): AgentCatalogResult {
  return buildAgentCatalog(import.meta.glob('../../agents/*/meta.ts', { eager: true }));
}
