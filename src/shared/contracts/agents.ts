import type { AgentId } from './ids';

/**
 * The *definition* half of the "Agents" settings surface: what an agent
 * provider is called and whether it needs a sign-in. The persisted half lives
 * in `appSettings.ts` as an `agents` map keyed by the same ids, so a stored node
 * and the item rendered for it are always paired by an id.
 *
 * The list of definitions is not fixed here. Every agent is one folder,
 * `src/agents/<name>/`, whose SDK-free `meta.ts` describes it; the main process
 * and the renderer each collect those with a glob. Deleting a folder therefore
 * removes its definition everywhere, and a persisted node for a provider that
 * is no longer built is simply left untouched in `settings.json` (it is only
 * ever read through a definition).
 *
 * {@link AgentId} is a branded *string* rather than a closed enum for that
 * reason: a settings file may name a provider this build does not contain.
 */
export interface AgentDefinition {
  readonly id: AgentId;
  /** Human-facing provider name, rendered as the first line of an agent item. */
  readonly label: string;
  /**
   * Whether this provider needs an authenticated session before it can be
   * used. A provider with `requiresAuth: false` - a
   * future locally hosted runtime, for example - is usable as soon as it is
   * selected, with no sign-in step at all.
   */
  readonly requiresAuth: boolean;
}

/**
 * True when `id` names a provider in `definitions` - the list the agent
 * registry built from the `src/agents/<name>/meta.ts` files present in this
 * build. Nothing in this module names a concrete provider.
 */
export function isKnownAgentId(id: string, definitions: readonly AgentDefinition[]): boolean {
  return definitions.some((definition) => definition.id === id);
}

/** The definition for `id`, or `undefined` when this build does not know it. */
export function agentDefinition(
  id: AgentId,
  definitions: readonly AgentDefinition[],
): AgentDefinition | undefined {
  return definitions.find((definition) => definition.id === id);
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
 * The provider a settings document names as *configured*: the known entry
 * whose `active` flag is set, or else the first definition, or `undefined` when
 * this build contains no agent at all. This is a storage concern - which
 * provider the app is set up to drive - and is deliberately *not* the UI's
 * notion of "the active agent". The main process uses it to choose the runtime
 * and its proxy, which must exist even while the configured provider is signed
 * out (otherwise it could never be signed in to).
 */
export function resolveConfiguredAgentId(
  agents: Readonly<Record<string, { readonly active: boolean }>>,
  definitions: readonly AgentDefinition[],
): AgentId | undefined {
  for (const [id, node] of Object.entries(agents)) {
    if (node.active && isKnownAgentId(id, definitions)) return id as AgentId;
  }
  return definitions[0]?.id;
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
