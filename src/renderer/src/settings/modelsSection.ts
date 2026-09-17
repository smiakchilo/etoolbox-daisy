import { el } from '../lib/dom';
import {
  buildModelsViewModel,
  fromPickerValue,
  NO_PREFERENCE_VALUE,
  type ModelOption,
} from './modelsViewModel';
import type { ModelSelectionState } from '../../../shared';

/**
 * The Settings panel's Models section (implementation-plan.md step 09:
 * "Obtain model lists/capabilities from the SDK. Show only supported reasoning
 * levels. Changing the model while idle preserves history and takes effect on
 * the next prompt; disable changes during an active turn.").
 *
 * Replaces the read-only placeholder this section used to be. All of the
 * decision-making lives in `modelsViewModel.ts`; this file only renders what
 * that returns and forwards the save.
 */
export interface ModelsSection {
  readonly element: HTMLElement;
  /** Re-reads the catalogue and the stored selection from the main process. */
  refresh(): Promise<void>;
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

export function createModelsSection(): ModelsSection {
  const status = el('p', { attrs: { class: 'models-section__status' } });
  const saveStatus = el('p', { attrs: { class: 'models-section__save-status' } });
  const modelPicker = createPicker('Model');
  const reasoningPicker = createPicker('Reasoning effort');
  const saveButton = el('sp-button', { attrs: { variant: 'primary' }, text: 'Save' });

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
    if (viewModel.controlsDisabled) {
      saveButton.setAttribute('disabled', '');
    } else {
      saveButton.removeAttribute('disabled');
    }
    status.textContent = viewModel.statusMessage;
  }

  modelPicker.addEventListener('change', () => {
    pendingModel = fromPickerValue(modelPicker.value);
    // A model change invalidates any effort chosen for the previous model.
    // Cleared rather than remapped: there is no meaningful correspondence
    // between one model's levels and another's.
    pendingReasoning = null;
    saveStatus.textContent = '';
    render();
  });

  reasoningPicker.addEventListener('change', () => {
    pendingReasoning = fromPickerValue(reasoningPicker.value);
    saveStatus.textContent = '';
  });

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

  saveButton.addEventListener('click', () => {
    saveStatus.textContent = '';
    saveButton.setAttribute('disabled', '');
    void window.daisy.settings
      .setModelPreferences({ model: pendingModel, reasoningEffort: pendingReasoning })
      .then(async (result) => {
        if (!result.ok) {
          saveStatus.textContent = result.error.message;
          // A refusal is re-read rather than trusted to have changed nothing:
          // `turn_in_flight` in particular means the lock state on screen is
          // already out of date.
          await refresh();
          return;
        }
        saveStatus.textContent = 'Saved. This applies to your next prompt.';
        await refresh();
      })
      .catch((error: unknown) => {
        saveStatus.textContent =
          error instanceof Error ? error.message : 'Could not save the model selection.';
      })
      .finally(() => {
        if (state?.changesLocked !== true) saveButton.removeAttribute('disabled');
      });
  });

  const element = el('section', {
    attrs: { class: 'settings-section', 'aria-label': 'Models' },
    children: [
      el('div', {
        attrs: { class: 'models-section__pickers' },
        children: [modelPicker, reasoningPicker, saveButton],
      }),
      status,
      saveStatus,
    ],
  });

  return { element, refresh };
}

export { NO_PREFERENCE_VALUE };
