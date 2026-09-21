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
  /**
   * Whether this provider needs an authenticated session before it can be
   * used. True for GitHub Copilot. A provider with `requiresAuth: false` - a
   * future locally hosted runtime, for example - is usable as soon as it is
   * selected, with no sign-in step at all.
   */
  readonly requiresAuth: boolean;
}

/**
 * The providers this build ships. GitHub Copilot is the one implemented
 * provider; the list exists so the Agents surface is a list, not a special
 * case, and so a second provider can be added without reshaping settings.
 */
const GITHUB_COPILOT: AgentDefinition = {
  id: 'copilot' as AgentId,
  label: 'GitHub Copilot',
  requiresAuth: true,
};

export const AGENT_DEFINITIONS: readonly AgentDefinition[] = [GITHUB_COPILOT];

/**
 * The provider a settings document with no explicit active agent is treated as
 * targeting. Also the id `defaultAppSettings()` seeds when no stored node names
 * another provider as active.
 */
export const DEFAULT_AGENT_ID: AgentId = GITHUB_COPILOT.id;

/** The definition {@link DEFAULT_AGENT_ID} names, without a registry lookup. */
export const DEFAULT_AGENT_DEFINITION: AgentDefinition = GITHUB_COPILOT;

/** True when `id` names a provider in {@link AGENT_DEFINITIONS}. */
export function isKnownAgentId(id: string): boolean {
  return AGENT_DEFINITIONS.some((definition) => definition.id === id);
}

/** The definition for `id`, or `undefined` when this build does not know it. */
export function agentDefinition(id: AgentId): AgentDefinition | undefined {
  return AGENT_DEFINITIONS.find((definition) => definition.id === id);
}

/**
 * The provider a settings document names as *selected*: the entry whose
 * `active` flag is set, or {@link DEFAULT_AGENT_ID} when none is. Shared by
 * the main process (which recycles the Copilot runtime around it) and the
 * renderer (which decides whether a *usable* agent is selected), so the two
 * can never disagree about which provider is current.
 */
export function resolveActiveAgentId(
  agents: Readonly<Record<string, { readonly active: boolean }>>,
): AgentId {
  for (const [id, node] of Object.entries(agents)) {
    if (node.active) return id as AgentId;
  }
  return DEFAULT_AGENT_ID;
}

/**
 * Whether the selected provider is *usable* right now - the UI's notion of an
 * "active agent". A provider that needs authentication counts as active only
 * once signed in; one that does not need it is active whenever it is selected.
 * Deliberately separate from the settings `active` flag, which only records
 * which provider is selected.
 */
export function isAgentActive(
  definition: AgentDefinition,
  auth: { readonly isAuthenticated: boolean } | undefined,
): boolean {
  return !definition.requiresAuth || auth?.isAuthenticated === true;
}
