import { el } from '../lib/dom';
import {
  buildModelsViewModel,
  fromPickerValue,
  NO_PREFERENCE_VALUE,
  type ModelOption,
} from './modelsViewModel';
import type { ModelSelectionState } from '../../../shared';
import { createAutoSave } from './autoSave';
import type { SaveOutcome, StatusBannerSink } from './statusBanner';

/**
 * The Settings panel's Models section (implementation-plan.md step 09:
 * "Obtain model lists/capabilities from the SDK. Show only supported reasoning
 * levels. Changing the model while idle preserves history and takes effect on
 * the next prompt; disable changes during an active turn.").
 *
 * Replaces the read-only placeholder this section used to be. All of the
 * decision-making lives in `modelsViewModel.ts`; this file only renders what
 * that returns and forwards the save.
 *
 * The selection auto-saves ~1s after the last pick, exactly like the proxy
 * section's fields — there is no Save button. The section reports its saves
 * into the panel's one banner slot through `reportSave`; on either outcome
 * (accept or refusal) it re-reads the catalogue and lock state, so the
 * pickers always reflect what is actually persisted. The informational
 * `status` paragraph (why changes are locked, whether the catalogue is
 * unreadable, that a change applies from the next prompt) stays where it is —
 * that is durable context, not a mutation result.
 */
export interface ModelsSectionOptions {
  /** The panel's single status slot (never used for plain informational text). */
  status: StatusBannerSink;
  /** Registers a debounced save with the panel's save reporter. */
  reportSave(outcome: Promise<SaveOutcome>): void;
}

export interface ModelsSection {
  readonly element: HTMLElement;
  /** Re-reads the catalogue and the stored selection from the main process. */
  refresh(): Promise<void>;
  /** Runs any pending save now (the close-and-persist path). */
  flushNow(): Promise<void>;
  /** True while a pick is unsaved or a save is in flight. */
  hasPendingEdits(): boolean;
  dispose(): void;
}

type PickerElement = HTMLElement & { value: string; disabled: boolean };

function createPicker(label: string): PickerElement {
  return el('sp-picker', {
    attrs: { label, 'aria-label': label },
  });
}

function renderOptions(picker: PickerElement, options: readonly ModelOption[], selected: string) {
  picker.replaceChildren(
    ...options.map((option) =>
      el('sp-menu-item', {
        attrs: { value: option.value },
        // `text`, never innerHTML: a model id/name comes from the Copilot
        // runtime, which is not this application's own content.
        text: option.label,
      }),
    ),
  );
  picker.value = selected;
}

export function createModelsSection(options: ModelsSectionOptions): ModelsSection {
  const status = el('p', { attrs: { class: 'models-section__status' } });
  const modelPicker = createPicker('Model');
  const reasoningPicker = createPicker('Reasoning effort');
  const autoSave = createAutoSave();

  /**
   * The last state fetched from main, plus the user's not-yet-saved picks.
   * Kept here rather than read back out of the DOM so that re-rendering the
   * reasoning picker (which replaces its children) cannot lose the model
   * choice that caused the re-render.
   */
  let state: ModelSelectionState | undefined;
  let pendingModel: string | null = null;
  let pendingReasoning: string | null = null;

  function render(): void {
    if (state === undefined) return;
    const viewModel = buildModelsViewModel(state, {
      model: pendingModel,
      reasoningEffort: pendingReasoning,
    });

    renderOptions(modelPicker, viewModel.modelOptions, viewModel.selectedModelValue);
    renderOptions(reasoningPicker, viewModel.reasoningOptions, viewModel.selectedReasoningValue);
    // Re-read after rendering: the view model may have rejected a reasoning
    // level the newly chosen model does not support, and the pending value
    // must follow what is actually shown or the next save would send the
    // stale level.
    pendingReasoning = fromPickerValue(viewModel.selectedReasoningValue);

    modelPicker.disabled = viewModel.controlsDisabled;
    reasoningPicker.disabled = viewModel.controlsDisabled || viewModel.reasoningDisabled;
    status.textContent = viewModel.statusMessage;
  }

  modelPicker.addEventListener('change', () => {
    pendingModel = fromPickerValue(modelPicker.value);
    // A model change invalidates any effort chosen for the previous model.
    // Cleared rather than remapped: there is no meaningful correspondence
    // between one model's levels and another's.
    pendingReasoning = null;
    render();
    armSave();
  });

  reasoningPicker.addEventListener('change', () => {
    pendingReasoning = fromPickerValue(reasoningPicker.value);
    armSave();
  });

  function hasUnsavedSelection(): boolean {
    return (
      state !== undefined &&
      (pendingModel !== state.selectedModel || pendingReasoning !== state.selectedReasoningEffort)
    );
  }

  function runSave(): Promise<SaveOutcome> | undefined {
    if (state === undefined || !hasUnsavedSelection()) return undefined;
    const model = pendingModel;
    const reasoningEffort = pendingReasoning;
    return window.daisy.settings.setModelPreferences({ model, reasoningEffort }).then(
      (result) => (result.ok ? { ok: true } : { ok: false, error: result.error.message }),
      (error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : 'Could not save the model selection',
      }),
    );
  }

  function armSave(): void {
    autoSave.arm(() => {
      const outcome = runSave();
      if (outcome === undefined) return;
      // The reporter's settle attaches first, so a drain that empties the
      // batch is announced before we re-read below.
      options.reportSave(outcome);
      void outcome.then(() => {
        // Whether the save was accepted or refused (e.g. `turn_in_flight`:
        // a turn started meanwhile and the lock state on screen is already
        // stale), re-read - the pickers and lock state must always end up
        // reflecting what is actually persisted.
        void refresh();
      });
    });
  }

  async function refresh(): Promise<void> {
    const result = await window.daisy.settings.getModelSelection();
    if (!result.ok) {
      status.textContent = `Failed to load models: ${result.error.message}`;
      return;
    }
    state = result.state;
    pendingModel = result.state.selectedModel;
    pendingReasoning = result.state.selectedReasoningEffort;
    render();
  }

  const element = el('section', {
    attrs: { class: 'settings-section', 'aria-label': 'Models' },
    children: [
      el('div', {
        attrs: { class: 'models-section__pickers' },
        children: [modelPicker, reasoningPicker],
      }),
      status,
    ],
  });

  return {
    element,
    refresh,
    flushNow: () => autoSave.flushNow(),
    hasPendingEdits: () => autoSave.hasPending() || hasUnsavedSelection(),
    dispose: () => autoSave.dispose(),
  };
}

export { NO_PREFERENCE_VALUE };
