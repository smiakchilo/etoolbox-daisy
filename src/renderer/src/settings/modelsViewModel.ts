import { supportedReasoningEffortsFor, type ModelSelectionState } from '../../../shared';

/**
 * Pure presentation logic for the active agent's Model/Effort pickers
 * (implementation-plan.md step 09), consumed by the Settings panel's Agents
 * tab through `agentsViewModel.ts`. Separated from the DOM for the same reason
 * `transcriptViewModel.ts` is separated from `transcriptView.ts`:
 * every decision worth testing - which options appear and what is preselected -
 * is decided here, against plain data, with
 * no DOM and no custom elements involved. What the user is *told* about a
 * failure is deliberately not decided here: the panel's one banner owns that,
 * and `agentsViewModel.ts` decides which failures deserve a word at all.
 */

/** One option in either picker. */
export interface ModelOption {
  readonly value: string;
  readonly label: string;
}

/**
 * The value representing "no explicit choice" in both pickers.
 *
 * A non-empty sentinel rather than `""`, because Spectrum's `<sp-picker>`
 * treats an empty `value` as "nothing selected" and would then render its
 * placeholder instead of this option's own label - leaving the user unable to
 * see that "(Auto)" (let the agent decide) is the current, deliberate state.
 */
export const NO_PREFERENCE_VALUE = '__none__';

/**
 * The id Copilot gives its own "Auto" model choice.
 *
 * The picker already offers a generic `(Auto)` option - the
 * {@link NO_PREFERENCE_VALUE} sentinel, meaning "let the runtime choose" -
 * which is exactly what Copilot's own `auto` entry means. So the provider's
 * entry is dropped from the option list, and a stored `auto` is shown as the
 * generic `(Auto)`, rather than rendering the same choice twice.
 */
export const PROVIDER_AUTO_MODEL_ID = 'auto';

/** Whether a catalogue entry is Copilot's own "Auto". */
export function isProviderAutoModel(model: { readonly id: string }): boolean {
  return model.id.toLowerCase() === PROVIDER_AUTO_MODEL_ID;
}

/**
 * Collapses a stored or pending model id to this picker's representation:
 * Copilot's own `auto` becomes `null` ("no preference"), everything else is
 * passed through.
 */
export function modelPreferenceValue(modelId: string | null): string | null {
  if (modelId === null) return null;
  return modelId.toLowerCase() === PROVIDER_AUTO_MODEL_ID ? null : modelId;
}

export interface ModelsViewModel {
  readonly modelOptions: readonly ModelOption[];
  readonly selectedModelValue: string;
  readonly reasoningOptions: readonly ModelOption[];
  readonly selectedReasoningValue: string;
  /** True when the reasoning picker has nothing to offer beyond "no preference". */
  readonly reasoningDisabled: boolean;
}

/**
 * Builds the view model for a given state and a *pending* (not yet saved)
 * selection.
 *
 * `pendingModel` is passed separately from `state.selectedModel` because the
 * reasoning picker has to react to the model the user just picked, before
 * anything is saved: choosing a model with no reasoning support must empty the
 * reasoning picker immediately, not after a round trip.
 */
export function buildModelsViewModel(
  state: ModelSelectionState,
  pending: { readonly model: string | null; readonly reasoningEffort: string | null },
): ModelsViewModel {
  const pendingModel = modelPreferenceValue(pending.model);
  const modelOptions: ModelOption[] = [
    { value: NO_PREFERENCE_VALUE, label: '(Auto)' },
    ...state.models
      .filter((model) => !isProviderAutoModel(model))
      .map((model) => ({ value: model.id, label: model.name })),
  ];

  // A stored model missing from the catalogue is still shown, and still
  // selected, rather than silently falling back to "(Auto)".
  // Dropping it would misreport the user's own setting as unset, and a
  // catalogue can be temporarily incomplete (Copilot still starting, a
  // transient outage) without the stored choice having become invalid.
  if (pendingModel !== null && !state.models.some((model) => model.id === pendingModel)) {
    modelOptions.push({ value: pendingModel, label: `${pendingModel} (not currently offered)` });
  }

  const supported = supportedReasoningEffortsFor(state.models, pendingModel);
  const reasoningOptions: ModelOption[] = [
    { value: NO_PREFERENCE_VALUE, label: '(Auto)' },
    ...supported.map((effort) => ({ value: effort, label: effort })),
  ];

  // Only a level this model actually supports may show as selected - this is
  // the "Show only supported reasoning levels" requirement applied to the
  // selection as well as to the option list, so that a level left over from a
  // previously chosen model cannot appear to still be in effect.
  const reasoningSelected =
    pending.reasoningEffort !== null && supported.includes(pending.reasoningEffort)
      ? pending.reasoningEffort
      : NO_PREFERENCE_VALUE;

  return {
    modelOptions,
    selectedModelValue: pendingModel ?? NO_PREFERENCE_VALUE,
    reasoningOptions,
    selectedReasoningValue: reasoningSelected,
    reasoningDisabled: supported.length === 0,
  };
}

/**
 * Maps a picker value back to the stored representation, collapsing the
 * sentinel to `null`.
 */
export function fromPickerValue(value: string): string | null {
  return value === NO_PREFERENCE_VALUE ? null : value;
}
