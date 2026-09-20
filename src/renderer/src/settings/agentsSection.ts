import { el } from '../lib/dom';
import {
  type AgentId,
  type AgentSettingsSnapshot,
  type AppSettingsSnapshot,
  type AuthStatus,
  type ModelSelectionState,
  type ProxyId,
  type ProxySnapshot,
} from '../../../shared';
import { createAutoSave } from './autoSave';
import {
  buildAgentsViewModel,
  catalogueFailureMessage,
  type AgentItemViewModel,
  type PendingModelSelection,
} from './agentsViewModel';
import { fromPickerValue } from './modelsViewModel';
import { syncPickerOptions } from './pickerOptions';
import { createProxyPicker } from './proxyPicker';
import type { SaveOutcome, StatusBannerSink } from './statusBanner';

/**
 * The Settings panel's Agents tab: one item per `AGENT_DEFINITIONS` entry
 * (today, GitHub Copilot alone), each carrying its name with either an
 * "Active" badge or a "Set active" button, the provider's sign-in status with
 * its one action button, a Proxy combobox drawn from the Proxies tab's library,
 * and the Model/Reasoning-effort pair.
 *
 * It folds together what used to be two sibling sections - the standalone
 * "Authentication" section and the "Models" section - because both describe
 * the *same* provider and only the active provider has a live runtime behind
 * it. Their decision-making moved to `agentsViewModel.ts`; this file renders
 * what that returns and forwards the three mutations (set-active, proxy,
 * model/effort), each through the panel's one save reporter.
 *
 * Which provider is active is stated, not chosen: an active item shows a
 * "(active)" badge after its name, a non-active one the single "Set active"
 * control. Both action buttons share one class and width so they line up in a
 * column at the item's right edge (see `styles/settings.css`).
 *
 * The Set-active and Proxy mutations persist immediately (they change which
 * runtime exists / which proxy it is driven through). Model and effort
 * auto-save ~1s after the last pick, exactly as the superseded Models section
 * did. Only the active item's Model/Effort are live, and only while its
 * provider is signed in with a readable catalogue; everything the user needs to
 * be *told* - a failed sign-in, a catalogue that could not be read - is said in
 * the panel's one banner at the bottom, never inside the item.
 */
export interface AgentsSectionOptions {
  /** The panel's single status slot (never used for plain informational text). */
  status: StatusBannerSink;
  /** Registers a debounced save with the panel's save reporter. */
  reportSave(outcome: Promise<SaveOutcome>): void;
  /** Fired after any mutation that changes the snapshot (active agent, proxy). */
  onSettingsChanged(): void;
}

export interface AgentsSection {
  readonly element: HTMLElement;
  /**
   * Re-reads the provider items from the snapshot, plus the live auth status
   * and the active agent's model catalogue.
   */
  refresh(snapshot: AppSettingsSnapshot): Promise<void>;
  /** Runs any pending save now (the close-and-persist path). */
  flushNow(): Promise<void>;
  /** True while a pick is unsaved or a save is in flight. */
  hasPendingEdits(): boolean;
  dispose(): void;
}

type PickerElement = HTMLElement & { value: string; disabled: boolean };

function labelledField(fieldId: string, label: string, control: HTMLElement): HTMLElement {
  return el('div', {
    attrs: { class: 'host-field' },
    children: [el('sp-field-label', { attrs: { for: fieldId }, text: label }), control],
  });
}

export function createAgentsSection(options: AgentsSectionOptions): AgentsSection {
  const group = el('div', { attrs: { class: 'agents-section__group' } });
  const autoSave = createAutoSave();

  let snapshot: AppSettingsSnapshot | undefined;
  let auth: AuthStatus | undefined;
  let modelSelection: ModelSelectionState | undefined;
  let pending: PendingModelSelection | undefined;
  /** The provider rows, kept alive across re-reads (see `ItemHandle`). */
  const itemHandles = new Map<AgentId, ItemHandle>();
  /** True once the user has touched a model/effort picker since the last read. */
  let pickersDirty = false;
  /** Guards the pickers' `change` handlers while a render applies stored state. */
  let rendering = false;
  /**
   * Set while the panel banner is already showing this session's catalogue
   * failure, so a refresh does not resurrect a row the user just dismissed; a
   * read that succeeds clears it.
   */
  let catalogueFailureReported = false;

  function storedSelection(): { model: string | null; reasoningEffort: string | null } {
    if (snapshot === undefined || modelSelection === undefined) {
      return { model: null, reasoningEffort: null };
    }
    return {
      model: modelSelection.selectedModel,
      reasoningEffort: modelSelection.selectedReasoningEffort,
    };
  }

  function hasUnsavedSelection(): boolean {
    if (!pickersDirty) return false;
    const stored = storedSelection();
    const current = pending ?? stored;
    return current.model !== stored.model || current.reasoningEffort !== stored.reasoningEffort;
  }

  function persistActive(agentId: AgentId): void {
    const outcome = window.daisy.settings
      .setAgentSettings({ agentId, changes: { active: true } })
      .then(
        (result) =>
          result.ok ? { ok: true as const } : { ok: false, error: result.error.message },
        (error: unknown) => ({
          ok: false as const,
          error: error instanceof Error ? error.message : 'Could not change the active agent',
        }),
      );
    options.reportSave(outcome);
    void outcome.then((result) => {
      if (result.ok) options.onSettingsChanged();
      else void refresh();
    });
  }

  function persistProxy(agentId: AgentId, proxyId: ProxyId | undefined): void {
    const outcome = window.daisy.settings
      .setAgentSettings({ agentId, changes: { proxy: proxyId ?? null } })
      .then(
        (result) =>
          result.ok ? { ok: true as const } : { ok: false, error: result.error.message },
        (error: unknown) => ({
          ok: false as const,
          error: error instanceof Error ? error.message : 'Could not save the proxy',
        }),
      );
    options.reportSave(outcome);
    void outcome.then((result) => {
      if (result.ok) options.onSettingsChanged();
    });
  }

  function runModelSave(): Promise<SaveOutcome> | undefined {
    if (!hasUnsavedSelection()) return undefined;
    const current = pending ?? storedSelection();
    return window.daisy.settings.setModelPreferences(current).then(
      (result) => (result.ok ? { ok: true as const } : { ok: false, error: result.error.message }),
      (error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : 'Could not save the model selection',
      }),
    );
  }

  function armModelSave(): void {
    autoSave.arm(() => {
      const outcome = runModelSave();
      if (outcome === undefined) return;
      // The reporter's settle attaches first, so a drain that empties the
      // batch is announced before we re-read below.
      options.reportSave(outcome);
      void outcome.then(() => {
        // Whether accepted or refused (e.g. `turn_in_flight`: a turn started
        // meanwhile and the lock state on screen is already stale), re-read -
        // the pickers and lock state must reflect what is actually persisted.
        pickersDirty = false;
        void refresh();
      });
    });
  }

  /**
   * The sign-in round trip. The button is disabled for its duration; the
   * failure is reported in the panel's one banner, never inside the item.
   */
  async function startSignIn(button: HTMLElement): Promise<void> {
    button.setAttribute('disabled', '');
    try {
      const outcome = await window.daisy.agent.login();
      if (outcome.status === 'failed') {
        options.status.showError(`Sign-in failed: ${outcome.message}`);
      }
    } catch (error) {
      options.status.showError(
        `Sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      button.removeAttribute('disabled');
      await refresh();
    }
  }

  /** `logout`'s own warning is the copy shown; it is never re-derived here. */
  async function startSignOut(): Promise<void> {
    try {
      const result = await window.daisy.agent.logout();
      options.status.showStatus(result.warning);
    } catch (error) {
      options.status.showError(
        `Sign-out failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await refresh();
  }

  /**
   * One provider's row, built once and updated in place. Rebuilding the row on
   * every re-read (the previous `buildItem` + `group.replaceChildren` approach)
   * re-created the row's `sp-picker`s, and a freshly inserted picker paints its
   * shadow content a frame late - an empty, 0-height flash in all three
   * comboboxes right as a save's banner appeared. The row's pickers are
   * therefore kept alive for the section's lifetime; only their options,
   * selection and disabled state change (see `syncPickerOptions`), and the two
   * small non-picker parts that can genuinely toggle (the active badge vs the
   * "Set active" control, and the auth action button) are attached/detached.
   */
  interface ItemHandle {
    readonly element: HTMLElement;
    update(view: AgentItemViewModel, proxies: readonly ProxySnapshot[]): void;
  }

  function createItemHandle(initial: AgentItemViewModel): ItemHandle {
    const id = initial.id;

    // The header: the provider's name, then either the "(active)" badge (which
    // only states a fact) or the one control that would make it active. The
    // control is right-aligned and shares its width with the auth action below
    // (`.agent-item__button`), so the two line up in one column.
    const title = el('span', { attrs: { class: 'agent-item__title' }, text: initial.label });
    const header = el('div', { attrs: { class: 'agent-item__header' }, children: [title] });
    const activeBadge = el('span', { attrs: { class: 'agent-item__active' }, text: '(active)' });
    const setActive = el('sp-action-button', {
      attrs: { class: 'agent-item__set-active agent-item__button' },
      text: 'Set active',
    });
    setActive.addEventListener('click', () => persistActive(id));

    const statusLight = el('sp-status-light', {
      attrs: { variant: initial.authVariant },
      text: initial.authText,
    });

    // Exactly one action, and only for the provider that has a runtime: "Sign
    // in" while signed out (or while the status is still unknown), "Sign out"
    // while signed in. The row carries no visible label - the status light's own
    // text says what it is. The button is created once; the sign-in/sign-out
    // choice is read from the mutable `authAction` when it is clicked.
    const actionButton = el('sp-action-button', {
      attrs: { class: 'agent-item__action agent-item__button' },
    });
    let authAction: AgentItemViewModel['authAction'];
    actionButton.addEventListener('click', () => {
      if (authAction === 'sign-in') void startSignIn(actionButton);
      else if (authAction === 'sign-out') void startSignOut();
    });

    const authControl = el('div', {
      attrs: { class: 'agent-item__auth' },
      children: [statusLight],
    });

    const proxyFieldId = `agent-${id}-proxy`;
    const proxyPicker = createProxyPicker({
      fieldId: proxyFieldId,
      initialProxyId: initial.proxyId,
      proxies: snapshot?.proxies ?? [],
      onChange: () => persistProxy(id, proxyPicker.read()),
    });

    const modelFieldId = `agent-${id}-model`;
    const modelPicker = el('sp-picker', {
      attrs: { id: modelFieldId, class: 'host-field__input', 'aria-label': 'Model' },
    }) as PickerElement;
    const effortFieldId = `agent-${id}-effort`;
    const effortPicker = el('sp-picker', {
      attrs: { id: effortFieldId, class: 'host-field__input', 'aria-label': 'Reasoning effort' },
    }) as PickerElement;

    modelPicker.addEventListener('change', () => {
      if (rendering) return;
      pending = { model: fromPickerValue(modelPicker.value), reasoningEffort: null };
      pickersDirty = true;
      // A model change invalidates any effort chosen for the previous model.
      // Cleared rather than remapped: there is no meaningful correspondence
      // between one model's levels and another's.
      render();
      armModelSave();
    });

    effortPicker.addEventListener('change', () => {
      if (rendering) return;
      const base = pending ?? storedSelection();
      pending = { model: base.model, reasoningEffort: fromPickerValue(effortPicker.value) };
      pickersDirty = true;
      armModelSave();
    });

    const element = el('div', {
      attrs: { class: 'agent-item' },
      children: [
        header,
        el('div', {
          attrs: { class: 'host-item__fields' },
          children: [
            // No label above this row: the status light says what it is, and
            // the user's own wording for it is the light's text.
            authControl,
            labelledField(proxyFieldId, 'Proxy', proxyPicker.element),
            labelledField(modelFieldId, 'Model', modelPicker),
            labelledField(effortFieldId, 'Reasoning effort', effortPicker),
          ],
        }),
      ],
    });

    let headerActive: boolean | undefined;
    let actionAttached = false;

    function update(view: AgentItemViewModel, proxies: readonly ProxySnapshot[]): void {
      if (title.textContent !== view.label) title.textContent = view.label;

      if (view.isActive !== headerActive) {
        for (const node of [...header.children]) {
          if (node !== title) node.remove();
        }
        header.append(view.isActive ? activeBadge : setActive);
        headerActive = view.isActive;
      }

      if (statusLight.getAttribute('variant') !== view.authVariant) {
        statusLight.setAttribute('variant', view.authVariant);
      }
      if (statusLight.textContent !== view.authText) statusLight.textContent = view.authText;

      authAction = view.authAction;
      if (view.authAction === undefined) {
        actionButton.remove();
        actionAttached = false;
      } else {
        const label = view.authAction === 'sign-in' ? 'Sign in' : 'Sign out';
        if (actionButton.textContent !== label) actionButton.textContent = label;
        if (view.authActionDisabled) actionButton.setAttribute('disabled', '');
        else actionButton.removeAttribute('disabled');
        if (!actionAttached) {
          authControl.append(actionButton);
          actionAttached = true;
        }
      }

      // The options come from the live proxy library; the selection from the
      // snapshot's stored id (a dangling one repairs to "(No proxy)").
      proxyPicker.setOptions(proxies);
      proxyPicker.select(view.proxyId);

      syncPickerOptions(modelPicker, view.modelOptions, view.selectedModelValue);
      syncPickerOptions(effortPicker, view.effortOptions, view.selectedEffortValue);
      modelPicker.disabled = !view.modelEnabled;
      effortPicker.disabled = view.effortDisabled;
    }

    return { element, update };
  }

  function render(): void {
    if (snapshot === undefined) return;
    const view = buildAgentsViewModel(
      {
        agents: snapshot.agents,
        activeAgentId: activeAgentIdFrom(snapshot),
        auth,
        modelSelection,
      },
      pending,
    );
    rendering = true;
    try {
      const present = new Set<AgentId>();
      const elements: HTMLElement[] = [];
      for (const item of view.items) {
        present.add(item.id);
        let handle = itemHandles.get(item.id);
        if (handle === undefined) {
          handle = createItemHandle(item);
          itemHandles.set(item.id, handle);
        }
        handle.update(item, snapshot.proxies);
        elements.push(handle.element);
      }
      for (const [id, handle] of itemHandles) {
        if (!present.has(id)) {
          itemHandles.delete(id);
          handle.element.remove();
        }
      }
      // Only touch the group's children when the visible set/order actually
      // changed: `replaceChildren` re-inserts even nodes it already holds, and
      // a re-insertion would blank the pickers for a frame (the flicker this
      // in-place update exists to remove).
      const current = [...group.children];
      const settled =
        current.length === elements.length && current.every((node, i) => node === elements[i]);
      if (!settled) group.replaceChildren(...elements);
    } finally {
      rendering = false;
    }
  }

  /**
   * The active agent as the snapshot records it. `ModelSelectionState` also
   * carries it once loaded, but the radio must be correct before that first
   * read resolves, and a non-active item's Proxy must be usable regardless.
   */
  function activeAgentIdFrom(document: AppSettingsSnapshot): AgentId {
    for (const [id, node] of Object.entries(document.agents)) {
      if (node.active) return id as AgentId;
    }
    const [first] = Object.keys(document.agents);
    return (first ?? 'copilot') as AgentId;
  }

  /**
   * A stand-in for the active agent's `ModelSelectionState` when
   * `settings:get-model-selection` itself could not be read. `catalogUnavailable`
   * is what disables both pickers and, for a signed-in provider, what
   * `catalogueFailureMessage` turns into the panel banner's error; the stored
   * model/effort are carried through so they stay visible.
   */
  function unavailableSelection(node: AgentSettingsSnapshot | undefined): ModelSelectionState {
    return {
      models: [],
      selectedModel: node?.model ?? null,
      selectedReasoningEffort: node?.reasoningEffort ?? null,
      changesLocked: false,
      catalogUnavailable: true,
    };
  }

  async function readLiveState(): Promise<void> {
    const activeId = snapshot === undefined ? undefined : activeAgentIdFrom(snapshot);
    const [authResult, modelResult] = await Promise.allSettled([
      window.daisy.agent.getAuthStatus(),
      window.daisy.settings.getModelSelection(),
    ]);
    if (authResult.status === 'fulfilled') auth = authResult.value;
    if (modelResult.status === 'fulfilled' && modelResult.value.ok) {
      modelSelection = modelResult.value.state;
    } else {
      modelSelection = unavailableSelection(
        activeId === undefined ? undefined : snapshot?.agents[activeId],
      );
    }
  }

  /**
   * Routes a real catalogue failure to the panel's one banner. Nothing is
   * reported while signed out: there is no model list before sign-in, so that
   * is not a failure, and the disabled pickers already say it. Reported once
   * per failure so dismissing the row sticks; a successful read re-arms it.
   */
  function reportCatalogueFailure(): void {
    const failure = catalogueFailureMessage(auth, modelSelection);
    if (failure === undefined) {
      catalogueFailureReported = false;
      return;
    }
    if (catalogueFailureReported) return;
    catalogueFailureReported = true;
    options.status.showError(failure);
  }

  async function refresh(next?: AppSettingsSnapshot): Promise<void> {
    if (next !== undefined) snapshot = next;
    if (snapshot === undefined) return;
    // A pick the user has not saved keeps what is on screen; the snapshot (and
    // the live reads) will be picked up on the next refresh.
    if (hasUnsavedSelection()) return;
    await readLiveState();
    reportCatalogueFailure();
    pending = undefined;
    render();
  }

  const element = el('section', {
    attrs: { class: 'settings-section agents-section', 'aria-label': 'Agents' },
    children: [group],
  });

  return {
    element,
    refresh: (next) => refresh(next),
    flushNow: () => autoSave.flushNow(),
    hasPendingEdits: () => autoSave.hasPending() || hasUnsavedSelection(),
    dispose: () => autoSave.dispose(),
  };
}
