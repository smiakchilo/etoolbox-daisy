import type { AgentId } from './ids';

/**
 * The registry of coding-agent providers this application can be configured
 * against. It is the *definition* half of the "Agents" settings surface: the
 * persisted half lives in `appSettings.ts` as an `agents` map keyed by these
 * same ids, so a stored node and the item rendered for it are always paired by
 * an id that appears here.
 *
 * The registry is application-owned and compiled in - deliberately not
 * discovered at runtime, not loaded from disk, and not derived from anything
 * an AEM response or a model could influence. Only the providers this build
 * actually knows how to drive can appear.
 *
 * {@link AgentId} is a branded *string* rather than a closed enum on purpose:
 * a settings file written by a future build that adds a provider must still be
 * readable here (the alternative is every unknown provider invalidating the
 * whole document - see `appSettingsSchema`'s `superRefine` for where an unknown
 * id is rejected instead). `AGENT_DEFINITIONS` stays the only place a *known*
 * provider is described.
 */
export interface AgentDefinition {
  readonly id: AgentId;
  /** Human-facing provider name, rendered as the first line of an agent item. */
  readonly label: string;
}

/**
 * The providers this build ships. GitHub Copilot is the one implemented
 * provider; the list exists so the Agents surface is a list, not a special
 * case, and so a second provider can be added without reshaping settings.
 */
const GITHUB_COPILOT: AgentDefinition = {
  id: 'copilot' as AgentId,
  label: 'GitHub Copilot',
};

export const AGENT_DEFINITIONS: readonly AgentDefinition[] = [GITHUB_COPILOT];

/**
 * The provider a settings document with no explicit active agent is treated as
 * targeting. Also the id `defaultAppSettings()` seeds when no stored node names
 * another provider as active.
 */
export const DEFAULT_AGENT_ID: AgentId = GITHUB_COPILOT.id;

/** True when `id` names a provider in {@link AGENT_DEFINITIONS}. */
export function isKnownAgentId(id: string): boolean {
  return AGENT_DEFINITIONS.some((definition) => definition.id === id);
}
