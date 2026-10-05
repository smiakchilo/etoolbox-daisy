import { AGENT_DEFINITIONS } from '../agents/agentCatalog';
import {
  type AgentDefinition,
  type AgentId,
  type AgentSettingsSnapshot,
  type AuthStatus,
  isAgentEligible,
  type ModelSelectionState,
  type ProxyId,
} from '../../../shared';
import {
  buildModelsViewModel,
  modelPreferenceValue,
  NO_PREFERENCE_VALUE,
  type ModelOption,
} from './modelsViewModel';

/**
 * Pure presentation logic for the Settings panel's Agents tab. Separated from
 * `agentsSection.ts` for the same reason `modelsViewModel.ts` is separated
 * from the DOM: every decision worth testing - which items appear,
 * what each picker offers and preselects, whether a control is enabled, what
 * the status line says - is decided here against plain data, with no DOM and
 * no custom elements involved.
 *
 * The tab is a list, not a special case: one item per
 * {@link AGENT_DEFINITIONS} entry, even when a build contains a single
 * provider. Only the one running runtime advertises a model catalogue, and
 * `settings:get-model-selection` reads the *configured* provider's stored model
 * plus that catalogue - so an item that is not the effective-active one renders
 * its Model/Effort controls from what is stored, disabled.
 *
 * The same reasoning makes sign-in a precondition for the active item's
 * pickers. Without a signed-in provider there is no catalogue to offer, so both
 * pickers are inert rather than one populated and one dead; a catalogue that
 * could not be read disables them too, and that - unlike simply being signed
 * out - is a real failure, which the section reports through the panel's one
 * banner (`catalogueFailureMessage`, below) instead of inside the item.
 */

/** The sentinel's label, shared by both pickers of every item. */
export const AUTO_LABEL = '(Auto)';

export interface AgentItemViewModel {
  readonly id: AgentId;
  readonly label: string;
  readonly isActive: boolean;
  /**
   * True when this provider cannot become active yet - its activation
   * criterion (sign-in, for a provider that needs auth) is unmet. Rendered as a
   * disabled "Set active" control; a provider that is already active does not
   * show the control at all.
   */
  readonly activationDisabled: boolean;
  /**
   * Whether a personal-access token is stored for this provider. A stored
   * token satisfies the provider's activation criterion, so it both counts as
   * authentication for `isActive` and changes the status light to
   * "Authenticated with token".
   */
  readonly hasToken: boolean;
  /** The agent's stored proxy-library reference, if any. */
  readonly proxyId: ProxyId | undefined;
  /**
   * Whether this item renders the auth row at all. Only the effective-active
   * provider shows a sign-in status; an inactive row's runtime is never
   * started to read it, so displaying a stale or borrowed status there would
   * be misleading. The "Set active" control (not the status) is what tells an
   * inactive row whether it can be activated.
   */
  readonly showAuth: boolean;
  readonly authVariant: 'neutral' | 'positive' | 'negative';
  readonly authText: string;
  /**
   * The one action this item offers, or `undefined` when it offers none.
   * Sign-in/out is offered by every provider whose activation criterion is
   * authentication - including one that is not yet active, since signing in is
   * how it becomes able to be active. Never both at once: "Sign out" only while
   * a real interactive session exists, otherwise "Sign in" - a stored token
   * authenticates the runtime but is not a session a sign-out could end (see
   * {@link hasInteractiveSession}).
   */
  readonly authAction: 'sign-in' | 'sign-out' | undefined;
  /** True while the action must stay inert (still checking, or no action at all). */
  readonly authActionDisabled: boolean;
  readonly modelEnabled: boolean;
  readonly modelOptions: readonly ModelOption[];
  readonly selectedModelValue: string;
  readonly effortOptions: readonly ModelOption[];
  readonly selectedEffortValue: string;
  readonly effortDisabled: boolean;
}

export interface AgentsViewModel {
  readonly items: readonly AgentItemViewModel[];
  /** The provider that is actually active, or `undefined` when none is. */
  readonly activeAgentId: AgentId | undefined;
}

export interface AgentsViewModelInput {
  /** The snapshot's `agents` map, keyed by agent id. */
  readonly agents: Readonly<Record<string, AgentSettingsSnapshot>>;
  /** The effectively active provider, or `undefined` when none is eligible. */
  readonly activeAgentId: AgentId | undefined;
  /**
   * The provider the app is *configured* to drive (the persisted `active`
   * flag, else the first). It is the one the hub runs and therefore the only
   * row whose live auth row is shown - including while it is signed out, which
   * is exactly when its Sign in control is needed. Every other row hides the
   * auth row (its runtime is not started).
   */
  readonly configuredAgentId: AgentId | undefined;
  /**
   * The *active* provider's live sign-in status; every other item ignores it.
   * `undefined` until the first read resolves.
   */
  readonly auth: AuthStatus | undefined;
  /**
   * Cheap, non-starting sign-in presence per provider, keyed by id. For an
   * inactive provider this is the only auth fact available (its runtime is not
   * started), so it gates "Set active": a provider with neither a stored token
   * nor a detected session cannot serve and must not be activatable.
   */
  readonly presence: Readonly<Record<string, boolean>>;
  /** The active agent's catalogue/selection; `undefined` until it has loaded. */
  readonly modelSelection: ModelSelectionState | undefined;
  /**
   * The providers to render, one item each. Defaults to the compiled-in
   * {@link AGENT_DEFINITIONS}; overridable so the non-active item's rendering
   * can be exercised while this build still ships a single provider.
   */
  readonly definitions?: readonly AgentDefinition[];
}

/** The active item's not-yet-saved pick, applied on top of the stored state. */
export interface PendingModelSelection {
  readonly model: string | null;
  readonly reasoningEffort: string | null;
}

export function buildAgentsViewModel(
  input: AgentsViewModelInput,
  pending: PendingModelSelection | undefined,
): AgentsViewModel {
  return {
    items: (input.definitions ?? AGENT_DEFINITIONS).map((definition) =>
      buildItem(definition, input, pending),
    ),
    activeAgentId: input.activeAgentId,
  };
}

function buildItem(
  definition: AgentDefinition,
  input: AgentsViewModelInput,
  pending: PendingModelSelection | undefined,
): AgentItemViewModel {
  const node = input.agents[definition.id];
  const isActive = definition.id === input.activeAgentId;
  const showAuth = definition.id === input.configuredAgentId;
  const hasToken = node?.hasToken === true;
  const sessionPresent = input.presence[definition.id] === true;
  const eligibility = isAgentEligible(definition, {
    isAuthenticated: isActive && input.auth?.isAuthenticated === true,
    // A stored token or a detected local session satisfies the activation
    // criterion. `sessionPresent` is the cheap signal for a provider whose
    // live status is deliberately not read.
    hasToken: hasToken || sessionPresent,
  });
  const auth = authView(definition, showAuth, hasToken, input.auth);

  const base = {
    id: definition.id,
    label: definition.label,
    isActive,
    activationDisabled: !eligibility,
    hasToken,
    showAuth,
    proxyId: node?.proxy,
    ...auth,
  };

  // Neither the non-active item (no runtime) nor the active-but-not-signed-in
  // one (no catalogue to offer) can choose anything: both pickers are inert
  // rather than one populated and one dead, and the item shows the stored model
  // so the setting does not look unset. The same applies to a catalogue that
  // could not be read - the section says so in the panel banner.
  const state = input.modelSelection;
  if (!isActive || !signedIn(input.auth) || state === undefined || state.catalogUnavailable) {
    return {
      ...base,
      modelEnabled: false,
      modelOptions: storedModelOptions(node?.model),
      selectedModelValue: modelPreferenceValue(node?.model ?? null) ?? NO_PREFERENCE_VALUE,
      effortOptions: [{ value: NO_PREFERENCE_VALUE, label: AUTO_LABEL }],
      selectedEffortValue: NO_PREFERENCE_VALUE,
      effortDisabled: true,
    };
  }

  const view = buildModelsViewModel(
    state,
    pending ?? { model: state.selectedModel, reasoningEffort: state.selectedReasoningEffort },
  );
  return {
    ...base,
    modelEnabled: !view.controlsDisabled,
    modelOptions: view.modelOptions,
    selectedModelValue: view.selectedModelValue,
    effortOptions: view.reasoningOptions,
    selectedEffortValue: view.selectedReasoningValue,
    effortDisabled: view.controlsDisabled || view.reasoningDisabled,
  };
}

function signedIn(auth: AuthStatus | undefined): boolean {
  return auth?.isAuthenticated === true;
}

/**
 * The panel banner's error for a *genuine* catalogue failure, or `undefined`
 * when there is nothing to report.
 *
 * Deliberately silent while the provider is not signed in: no model list can
 * exist before sign-in, so "could not retrieve the list of models" would be
 * noise about a state the user has not reached yet - the two disabled pickers
 * already say it without claiming a failure. It is also silent before the first
 * read resolves and whenever the catalogue is fine.
 */
export function catalogueFailureMessage(
  auth: AuthStatus | undefined,
  state: ModelSelectionState | undefined,
): string | undefined {
  if (!signedIn(auth)) return undefined;
  if (state === undefined || !state.catalogUnavailable) return undefined;
  return 'Could not retrieve the list of models';
}

/**
 * The one non-sentinel option a non-active item can show: its stored model.
 * Not labelled "(not currently offered)" - that phrasing belongs to a live
 * catalogue that has omitted the model, and this item has no catalogue at all.
 */
function storedModelOptions(model: string | undefined): readonly ModelOption[] {
  const value = modelPreferenceValue(model ?? null);
  if (value === null) return [{ value: NO_PREFERENCE_VALUE, label: AUTO_LABEL }];
  return [
    { value: NO_PREFERENCE_VALUE, label: AUTO_LABEL },
    { value, label: value },
  ];
}

/**
 * The four fields the sign-in row is built from.
 */
interface AuthView {
  readonly authVariant: 'neutral' | 'positive' | 'negative';
  readonly authText: string;
  readonly authAction: 'sign-in' | 'sign-out' | undefined;
  readonly authActionDisabled: boolean;
}

/**
 * The sign-in row for one provider.
 *
 * A provider whose activation criterion is authentication always shows its
 * live status and its one sign-in/out action - including while it is *not*
 * yet active, because signing in is exactly how it becomes able to be active.
 *
 * When a personal-access token is stored the status is reported as
 * authenticated with that token, whatever the interactive session says. The
 * action, though, describes only the interactive session
 * ({@link hasInteractiveSession}): with a token stored the runtime reports
 * authenticated with `authType: "env"` - the app injects the token - which is
 * not an SSO session a local sign-out could end, so the item offers "Sign in"
 * rather than a "Sign out" that would silently do nothing. A provider that
 * needs no authentication has no session to manage: it states that, and offers
 * no action.
 */
function authView(
  definition: AgentDefinition,
  showAuth: boolean,
  hasToken: boolean,
  auth: AuthStatus | undefined,
): AuthView {
  // Only the configured provider renders the auth row (showAuth); this is an
  // inert placeholder the section never displays for any other row.
  if (!showAuth) {
    return {
      authVariant: 'neutral',
      authText: '',
      authAction: undefined,
      authActionDisabled: true,
    };
  }
  if (!definition.requiresAuth) {
    return {
      authVariant: 'neutral',
      authText: 'No sign-in required',
      authAction: undefined,
      authActionDisabled: true,
    };
  }
  if (!definition.supportsInteractiveLogin) {
    // A token-only provider has no interactive flow; the Token field is the
    // whole control, so there is no action button to offer.
    return hasToken
      ? {
          authVariant: 'positive',
          authText: 'Authenticated with token',
          authAction: undefined,
          authActionDisabled: true,
        }
      : {
          authVariant: 'negative',
          authText: 'No API key',
          authAction: undefined,
          authActionDisabled: true,
        };
  }
  const session = sessionAuth(auth);
  if (hasToken) {
    return { ...session, authVariant: 'positive', authText: 'Authenticated with token' };
  }
  return session;
}

/**
 * Whether the runtime's current authentication is a real interactive session -
 * the thing a local "Sign out" can actually end.
 *
 * The runtime reports `authType: "env"` when it authenticated from an injected
 * environment token. This app sets `COPILOT_GITHUB_TOKEN` whenever a
 * personal-access token is stored (see `buildRuntimeChildEnv`), and the runtime
 * resolves that token before the app-owned vault/config session, so while a
 * token is stored the runtime is authenticated *through the token*, not
 * through SSO. A local sign-out (deleting only our own `config.json`) could not
 * end that: the next runtime start injects the token again. The action must
 * therefore describe the interactive session alone.
 */
function hasInteractiveSession(auth: AuthStatus | undefined): boolean {
  return auth?.isAuthenticated === true && auth.authType !== 'env';
}

function sessionAuth(auth: AuthStatus | undefined): AuthView {
  if (auth === undefined) {
    // The status is not known yet, so the only safe offer is the signed-out
    // one, and it stays inert until the read answers.
    return {
      authVariant: 'neutral',
      authText: 'Checking\u2026',
      authAction: 'sign-in',
      authActionDisabled: true,
    };
  }
  if (hasInteractiveSession(auth)) {
    return {
      authVariant: 'positive',
      authText: `Signed in${auth.login ? ` as ${auth.login}` : ''}`,
      authAction: 'sign-out',
      authActionDisabled: false,
    };
  }
  return {
    authVariant: 'negative',
    authText: auth.statusMessage ?? 'Not signed in',
    authAction: 'sign-in',
    authActionDisabled: false,
  };
}
