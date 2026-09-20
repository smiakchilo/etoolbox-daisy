import { describe, expect, it } from 'vitest';
import {
  AUTO_LABEL,
  buildAgentsViewModel,
  catalogueFailureMessage,
  type AgentsViewModelInput,
} from '../../../../src/renderer/src/settings/agentsViewModel';
import { NO_PREFERENCE_VALUE } from '../../../../src/renderer/src/settings/modelsViewModel';
import {
  DEFAULT_AGENT_ID,
  type AgentDefinition,
  type AgentId,
  type AgentSettingsSnapshot,
  type AuthStatus,
  type ModelSelectionState,
  type ProxyId,
} from '../../../../src/shared';

/**
 * Pure presentation tests for the Settings panel's Agents tab
 * (implementation-plan.md step 09). Every decision the tab makes about an item -
 * whether its controls are live, what its pickers offer, which single auth
 * action it shows - is asserted here against plain data, with no DOM involved.
 */

const SECOND_AGENT: AgentDefinition = { id: 'opencode' as AgentId, label: 'OpenCode' };
const DEFINITIONS: readonly AgentDefinition[] = [
  { id: DEFAULT_AGENT_ID, label: 'GitHub Copilot' },
  SECOND_AGENT,
];

function authWith(overrides: Partial<AuthStatus> = {}): AuthStatus {
  return { apiVersion: 1, isAuthenticated: false, statusMessage: 'Not signed in', ...overrides };
}

function selectionWith(overrides: Partial<ModelSelectionState> = {}): ModelSelectionState {
  return {
    models: [
      { id: 'model-a', name: 'Model A', supportedReasoningEfforts: ['low', 'high'] },
      { id: 'model-b', name: 'Model B', supportedReasoningEfforts: [] },
    ],
    selectedModel: null,
    selectedReasoningEffort: null,
    changesLocked: false,
    catalogUnavailable: false,
    ...overrides,
  };
}

function inputWith(overrides: Partial<AgentsViewModelInput> = {}): AgentsViewModelInput {
  return {
    agents: { [DEFAULT_AGENT_ID]: { active: true } },
    activeAgentId: DEFAULT_AGENT_ID,
    auth: undefined,
    modelSelection: undefined,
    ...overrides,
  };
}

function nodeWith(overrides: Partial<AgentSettingsSnapshot> = {}): AgentSettingsSnapshot {
  return { active: false, ...overrides };
}

describe('buildAgentsViewModel', () => {
  it('renders one item per registered provider, in registry order', () => {
    const vm = buildAgentsViewModel(inputWith({ definitions: DEFINITIONS }), undefined);
    expect(vm.items.map((item) => item.id)).toEqual([DEFAULT_AGENT_ID, SECOND_AGENT.id]);
    expect(vm.items.map((item) => item.label)).toEqual(['GitHub Copilot', 'OpenCode']);
    expect(vm.activeAgentId).toBe(DEFAULT_AGENT_ID);
  });

  it('ignores a stored agent node with no matching provider definition', () => {
    // The tab is driven by the registry, not by whatever the settings file
    // happens to contain - a forward-written provider must not appear here.
    const vm = buildAgentsViewModel(
      inputWith({
        definitions: DEFINITIONS,
        agents: {
          [DEFAULT_AGENT_ID]: { active: true },
          ['ghost' as AgentId]: { active: false },
        },
      }),
      undefined,
    );
    expect(vm.items.map((item) => item.id)).not.toContain('ghost');
  });

  it('says the status is still unknown before the live auth read resolves', () => {
    const [item] = buildAgentsViewModel(inputWith(), undefined).items;
    expect(item?.authText).toBe('Checking\u2026');
    expect(item?.authVariant).toBe('neutral');
    // Signed-out is the only safe guess while the status is unknown, and the
    // button stays inert until the read answers.
    expect(item?.authAction).toBe('sign-in');
    expect(item?.authActionDisabled).toBe(true);
  });

  it('offers the sign-out action once the active provider is signed in', () => {
    const [item] = buildAgentsViewModel(
      inputWith({ auth: authWith({ isAuthenticated: true, login: 'octocat' }) }),
      undefined,
    ).items;
    expect(item?.authVariant).toBe('positive');
    expect(item?.authText).toBe('Signed in as octocat');
    expect(item?.authAction).toBe('sign-out');
    expect(item?.authActionDisabled).toBe(false);
  });

  it('offers sign-in, using the runtime text, while the active provider is signed out', () => {
    const [item] = buildAgentsViewModel(
      inputWith({ auth: authWith({ statusMessage: 'Token expired' }) }),
      undefined,
    ).items;
    expect(item?.authVariant).toBe('negative');
    expect(item?.authText).toBe('Token expired');
    expect(item?.authAction).toBe('sign-in');
    expect(item?.authActionDisabled).toBe(false);
  });

  it('keeps the stored model visible but inert before the catalogue is readable', () => {
    const [item] = buildAgentsViewModel(
      inputWith({
        agents: { [DEFAULT_AGENT_ID]: { active: true, model: 'stored-model' } },
      }),
      undefined,
    ).items;
    expect(item?.modelEnabled).toBe(false);
    expect(item?.selectedModelValue).toBe('stored-model');
    expect(item?.modelOptions).toEqual([
      { value: NO_PREFERENCE_VALUE, label: AUTO_LABEL },
      { value: 'stored-model', label: 'stored-model' },
    ]);
    expect(item?.effortDisabled).toBe(true);
  });

  it('disables both pickers while the active provider is signed out', () => {
    // The reported defect: one picker looked usable (the catalogue IPC can
    // still answer, with no models) while the other was dead. Signed out means
    // there is no list to choose from, so neither picker offers anything.
    const [item] = buildAgentsViewModel(
      inputWith({
        auth: authWith(),
        modelSelection: selectionWith(),
        agents: { [DEFAULT_AGENT_ID]: { active: true, model: 'stored-model' } },
      }),
      undefined,
    ).items;
    expect(item?.modelEnabled).toBe(false);
    expect(item?.effortDisabled).toBe(true);
    // The live catalogue is not advertised either - it belongs to a sign-in
    // that has not happened.
    expect(item?.modelOptions.map((option) => option.value)).toEqual([
      NO_PREFERENCE_VALUE,
      'stored-model',
    ]);
  });

  it('enables both pickers for a signed-in provider with a readable catalogue', () => {
    const [item] = buildAgentsViewModel(
      inputWith({ auth: authWith({ isAuthenticated: true }), modelSelection: selectionWith() }),
      undefined,
    ).items;
    expect(item?.modelEnabled).toBe(true);
  });

  it('disables both pickers when a signed-in provider has no readable catalogue', () => {
    const [item] = buildAgentsViewModel(
      inputWith({
        auth: authWith({ isAuthenticated: true }),
        modelSelection: selectionWith({ models: [], catalogUnavailable: true }),
        agents: { [DEFAULT_AGENT_ID]: { active: true, model: 'stored-model' } },
      }),
      undefined,
    ).items;
    expect(item?.modelEnabled).toBe(false);
    expect(item?.effortDisabled).toBe(true);
    expect(item?.modelOptions.map((option) => option.value)).toEqual([
      NO_PREFERENCE_VALUE,
      'stored-model',
    ]);
  });

  it("offers '(Auto)' first, then the catalogue, once the active catalogue has loaded", () => {
    const [item] = buildAgentsViewModel(
      inputWith({ auth: authWith({ isAuthenticated: true }), modelSelection: selectionWith() }),
      undefined,
    ).items;
    expect(item?.modelOptions.map((option) => option.value)).toEqual([
      NO_PREFERENCE_VALUE,
      'model-a',
      'model-b',
    ]);
    expect(item?.selectedModelValue).toBe(NO_PREFERENCE_VALUE);
    expect(item?.modelEnabled).toBe(true);
  });

  it('carries a pending pick through to both pickers', () => {
    const [item] = buildAgentsViewModel(
      inputWith({
        auth: authWith({ isAuthenticated: true }),
        modelSelection: selectionWith({ selectedModel: 'model-b' }),
      }),
      { model: 'model-a', reasoningEffort: 'high' },
    ).items;
    expect(item?.selectedModelValue).toBe('model-a');
    expect(item?.effortOptions.map((option) => option.value)).toEqual([
      NO_PREFERENCE_VALUE,
      'low',
      'high',
    ]);
    expect(item?.selectedEffortValue).toBe('high');
  });

  it('locks both pickers while a response is in progress', () => {
    const [item] = buildAgentsViewModel(
      inputWith({
        auth: authWith({ isAuthenticated: true }),
        modelSelection: selectionWith({ changesLocked: true }),
      }),
      undefined,
    ).items;
    expect(item?.modelEnabled).toBe(false);
    expect(item?.effortDisabled).toBe(true);
  });

  it('leaves a non-active provider fixed, showing its stored model and no action', () => {
    const vm = buildAgentsViewModel(
      inputWith({
        definitions: DEFINITIONS,
        agents: {
          [DEFAULT_AGENT_ID]: { active: true },
          [SECOND_AGENT.id]: nodeWith({ model: 'stored-model', proxy: 'proxy-1' as ProxyId }),
        },
      }),
      undefined,
    );
    const item = vm.items[1];
    expect(item?.isActive).toBe(false);
    expect(item?.authText).toBe('Not the active agent');
    // No button at all: there is no runtime behind a non-active provider.
    expect(item?.authAction).toBeUndefined();
    expect(item?.authActionDisabled).toBe(true);
    expect(item?.modelEnabled).toBe(false);
    expect(item?.effortDisabled).toBe(true);
    expect(item?.selectedModelValue).toBe('stored-model');
    expect(item?.proxyId).toBe('proxy-1');
  });

  it('does not offer the live catalogue to a non-active provider', () => {
    // The catalogue belongs to the one running runtime; lending it to a second
    // item would advertise models that item's provider was never asked about.
    const vm = buildAgentsViewModel(
      inputWith({
        definitions: DEFINITIONS,
        modelSelection: selectionWith(),
        agents: {
          [DEFAULT_AGENT_ID]: { active: true },
          [SECOND_AGENT.id]: nodeWith(),
        },
      }),
      undefined,
    );
    expect(vm.items[1]?.modelOptions.map((option) => option.value)).toEqual([NO_PREFERENCE_VALUE]);
  });

  it('reports no proxy reference for a provider that has none stored', () => {
    const [item] = buildAgentsViewModel(inputWith(), undefined).items;
    expect(item?.proxyId).toBeUndefined();
  });
});

describe('catalogueFailureMessage', () => {
  it('stays silent while the provider is signed out', () => {
    // The reported defect: "could not retrieve the list of models" was shown to
    // a user who had never signed in, where no list could have existed.
    expect(
      catalogueFailureMessage(authWith(), selectionWith({ models: [], catalogUnavailable: true })),
    ).toBeUndefined();
  });

  it('stays silent before the auth status is known', () => {
    expect(
      catalogueFailureMessage(undefined, selectionWith({ models: [], catalogUnavailable: true })),
    ).toBeUndefined();
  });

  it('stays silent for a signed-in provider with a readable catalogue', () => {
    expect(
      catalogueFailureMessage(authWith({ isAuthenticated: true }), selectionWith()),
    ).toBeUndefined();
  });

  it('stays silent before the first read has resolved', () => {
    expect(catalogueFailureMessage(authWith({ isAuthenticated: true }), undefined)).toBeUndefined();
  });

  it('reports an unreadable catalogue for a signed-in provider', () => {
    expect(
      catalogueFailureMessage(
        authWith({ isAuthenticated: true }),
        selectionWith({ models: [], catalogUnavailable: true }),
      ),
    ).toBe('Could not retrieve the list of models');
  });
});
