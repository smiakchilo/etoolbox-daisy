import {
  AGENT_DEFINITIONS,
  type AgentDefinition,
  type AgentId,
  type AgentSettingsSnapshot,
  type AuthStatus,
  type ModelSelectionState,
  type ProxyId,
} from '../../../shared';
import { buildModelsViewModel, NO_PREFERENCE_VALUE, type ModelOption } from './modelsViewModel';

/**
 * Pure presentation logic for the Settings panel's Agents tab. Separated from
 * `agentsSection.ts` for the same reason `modelsViewModel.ts` is separated
 * from the DOM: every decision worth testing - which items appear,
 * what each picker offers and preselects, whether a control is enabled, what
 * the status line says - is decided here against plain data, with no DOM and
 * no custom elements involved.
 *
 * The tab is a list, not a special case: one item per
 * {@link AGENT_DEFINITIONS} entry, even though this build ships exactly one
 * provider. Only the *active* agent has a live runtime behind it, and
 * `settings:get-model-selection` reads that one agent's stored model and the
 * SDK catalogue that runtime advertises - so a non-active item's Model/Effort
 * controls are rendered from what is stored, disabled.
 *
 * The same reasoning makes sign-in a precondition for the *active* item's
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
  /** The agent's stored proxy-library reference, if any. */
  readonly proxyId: ProxyId | undefined;
  readonly authVariant: 'neutral' | 'positive' | 'negative';
  readonly authText: string;
  /**
   * The one action this item offers, or `undefined` when it offers none (a
   * non-active item has no runtime to sign in or out of). Never both at once:
   * the button is "Sign in" while signed out and "Sign out" while signed in.
   */
  readonly authAction: 'sign-in' | 'sign-out' | undefined;
  /** True while the action must stay inert (still checking, or non-active). */
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
  readonly activeAgentId: AgentId;
}

export interface AgentsViewModelInput {
  /** The snapshot's `agents` map, keyed by agent id. */
  readonly agents: Readonly<Record<string, AgentSettingsSnapshot>>;
  readonly activeAgentId: AgentId;
  /** The live runtime's sign-in status; only the active item consumes it. */
  readonly auth: AuthStatus | undefined;
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
  const auth = isActive ? activeAuth(input.auth) : nonActiveAuth();

  const base = {
    id: definition.id,
    label: definition.label,
    isActive,
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
      selectedModelValue: node?.model ?? NO_PREFERENCE_VALUE,
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
  if (model === undefined) return [{ value: NO_PREFERENCE_VALUE, label: AUTO_LABEL }];
  return [
    { value: NO_PREFERENCE_VALUE, label: AUTO_LABEL },
    { value: model, label: model },
  ];
}

function activeAuth(auth: AuthStatus | undefined): {
  authVariant: 'neutral' | 'positive' | 'negative';
  authText: string;
  authAction: 'sign-in' | 'sign-out';
  authActionDisabled: boolean;
} {
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
  if (auth.isAuthenticated) {
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

function nonActiveAuth(): {
  authVariant: 'neutral';
  authText: string;
  authAction: undefined;
  authActionDisabled: true;
} {
  return {
    authVariant: 'neutral',
    authText: 'Not the active agent',
    authAction: undefined,
    authActionDisabled: true,
  };
}
