import { supportedReasoningEffortsFor, type ModelSelectionState } from '../../../shared';

/**
 * Pure presentation logic for the Settings panel's Models section
 * (implementation-plan.md step 09). Separated from `modelsSection.ts` for the
 * same reason `transcriptViewModel.ts` is separated from `transcriptView.ts`:
 * every decision worth testing - which options appear, what is preselected,
 * whether the controls are disabled, what the status line says - is decided
 * here, against plain data, with no DOM and no custom elements involved.
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
 * see that "let Copilot decide" is the current, deliberate state.
 */
export const NO_PREFERENCE_VALUE = '__none__';

export interface ModelsViewModel {
  readonly modelOptions: readonly ModelOption[];
  readonly selectedModelValue: string;
  readonly reasoningOptions: readonly ModelOption[];
  readonly selectedReasoningValue: string;
  /** True when the reasoning picker has nothing to offer beyond "no preference". */
  readonly reasoningDisabled: boolean;
  /** True when both pickers and the save button must be disabled. */
  readonly controlsDisabled: boolean;
  readonly statusMessage: string;
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
  const modelOptions: ModelOption[] = [
    { value: NO_PREFERENCE_VALUE, label: 'Let Copilot decide' },
    ...state.models.map((model) => ({ value: model.id, label: model.name })),
  ];

  // A stored model missing from the catalogue is still shown, and still
  // selected, rather than silently falling back to "Let Copilot decide".
  // Dropping it would misreport the user's own setting as unset, and a
  // catalogue can be temporarily incomplete (Copilot still starting, a
  // transient outage) without the stored choice having become invalid.
  if (pending.model !== null && !state.models.some((model) => model.id === pending.model)) {
    modelOptions.push({ value: pending.model, label: `${pending.model} (not currently offered)` });
  }

  const supported = supportedReasoningEffortsFor(state.models, pending.model);
  const reasoningOptions: ModelOption[] = [
    { value: NO_PREFERENCE_VALUE, label: 'Default for this model' },
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
    selectedModelValue: pending.model ?? NO_PREFERENCE_VALUE,
    reasoningOptions,
    selectedReasoningValue: reasoningSelected,
    reasoningDisabled: supported.length === 0,
    controlsDisabled: state.changesLocked,
    statusMessage: buildStatusMessage(state),
  };
}

/**
 * The single status line under the pickers.
 *
 * Ordered most-blocking-first: an active turn is why the controls are greyed
 * out right now, so it must be explained before anything else, and an
 * unreadable catalogue explains an empty model list. Only when neither applies
 * does the line state the rule that is otherwise invisible - that a change
 * applies from the next prompt, not to the response already on screen.
 */
function buildStatusMessage(state: ModelSelectionState): string {
  if (state.changesLocked) {
    return 'Model changes disabled while a response is in progress';
  }
  if (state.catalogUnavailable) {
    return 'Could not retrieve the list of models';
  }
  return 'Changes will apply to the next prompt';
}

/**
 * Maps a picker value back to the stored representation, collapsing the
 * sentinel to `null`.
 */
export function fromPickerValue(value: string): string | null {
  return value === NO_PREFERENCE_VALUE ? null : value;
}
