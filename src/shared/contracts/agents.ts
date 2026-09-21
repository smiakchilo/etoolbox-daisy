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
 * The minimum an agent's activation criterion needs to know about its live
 * sign-in state.
 */
export interface AgentEligibilityInput {
  readonly isAuthenticated: boolean;
  /**
   * Whether a personal-access token is stored for this provider. A stored
   * token is accepted as authentication without validating it (the app
   * deliberately does not call GitHub to check it), so it satisfies the
   * criterion just as an interactive session does.
   */
  readonly hasToken?: boolean;
}

/**
 * Whether `definition` satisfies its own activation criterion right now. A
 * provider that needs authentication is eligible once signed in *or* once a
 * token is stored for it; one that does not need authentication is always
 * eligible. This is the single rule deciding whether an agent may become - and
 * stay - active.
 *
 * Named "eligible", not "active": eligibility is the *precondition* for
 * activity. The agent that is actually active is decided by
 * {@link resolveEffectiveActiveAgentId}.
 */
export function isAgentEligible(
  definition: AgentDefinition,
  auth: AgentEligibilityInput | undefined,
): boolean {
  if (!definition.requiresAuth) return true;
  return auth?.isAuthenticated === true || auth?.hasToken === true;
}

/**
 * The provider a settings document names as *configured*: the entry whose
 * `active` flag is set, or {@link DEFAULT_AGENT_ID} when none is. This is a
 * storage concern - which provider the app is set up to drive - and is
 * deliberately *not* the UI's notion of "the active agent". The main process
 * uses it to choose the runtime and its proxy, which must exist even while the
 * configured provider is signed out (otherwise it could never be signed in to).
 */
export function resolveConfiguredAgentId(
  agents: Readonly<Record<string, { readonly active: boolean }>>,
): AgentId {
  for (const [id, node] of Object.entries(agents)) {
    if (node.active) return id as AgentId;
  }
  return DEFAULT_AGENT_ID;
}

/**
 * The provider that is *actually active* right now, or `undefined` when none
 * is. This is the one value the Settings badge, the composer gate and the chat
 * banner all read, so they can never disagree about which agent is current.
 *
 * The rules, in order:
 *
 *  1. The configured provider (its persisted `active` flag set), when it is
 *     eligible - an explicit choice is honoured.
 *  2. Otherwise the first eligible provider in registration order. This is what
 *     makes the app come up with an active agent whenever one *can* be active:
 *     an eligible provider is never left inactive for want of a stored flag.
 *  3. Otherwise `undefined` - genuinely no agent is active, and sending stays
 *     disabled until one becomes eligible.
 *
 * `authFor` supplies each provider's eligibility. With the single-provider
 * registry every id resolves to the one live runtime's status, but the lookup
 * is per-id so a future build with independently authenticated providers needs
 * no change here.
 */
export function resolveEffectiveActiveAgentId(
  definitions: readonly AgentDefinition[],
  agents: Readonly<Record<string, { readonly active: boolean }>>,
  authFor: (id: AgentId) => AgentEligibilityInput | undefined,
): AgentId | undefined {
  for (const definition of definitions) {
    if (agents[definition.id]?.active !== true) continue;
    if (isAgentEligible(definition, authFor(definition.id))) return definition.id;
  }
  for (const definition of definitions) {
    if (isAgentEligible(definition, authFor(definition.id))) return definition.id;
  }
  return undefined;
}
