import { describe, expect, it } from 'vitest';
import {
  NO_PREFERENCE_VALUE,
  buildModelsViewModel,
  fromPickerValue,
} from '../../../../src/renderer/src/settings/modelsViewModel';
import type { ModelSelectionState } from '../../../../src/shared';

/**
 * Pure presentation tests for the Settings panel's Models section
 * (implementation-plan.md step 09).
 */

function stateWith(overrides: Partial<ModelSelectionState> = {}): ModelSelectionState {
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

describe('buildModelsViewModel', () => {
  it("offers 'let Copilot decide' first, then every catalogue model", () => {
    const vm = buildModelsViewModel(stateWith(), { model: null, reasoningEffort: null });
    expect(vm.modelOptions.map((option) => option.value)).toEqual([
      NO_PREFERENCE_VALUE,
      'model-a',
      'model-b',
    ]);
    expect(vm.selectedModelValue).toBe(NO_PREFERENCE_VALUE);
  });

  it("offers only the selected model's own reasoning levels", () => {
    const vm = buildModelsViewModel(stateWith(), { model: 'model-a', reasoningEffort: null });
    expect(vm.reasoningOptions.map((option) => option.value)).toEqual([
      NO_PREFERENCE_VALUE,
      'low',
      'high',
    ]);
    expect(vm.reasoningDisabled).toBe(false);
  });

  it('disables the reasoning picker for a model with no levels', () => {
    const vm = buildModelsViewModel(stateWith(), { model: 'model-b', reasoningEffort: null });
    expect(vm.reasoningDisabled).toBe(true);
    expect(vm.reasoningOptions.map((option) => option.value)).toEqual([NO_PREFERENCE_VALUE]);
  });

  it('reacts to the pending model, not the saved one', () => {
    // Choosing a model must empty the reasoning picker immediately, before a
    // save round trip.
    const vm = buildModelsViewModel(
      stateWith({ selectedModel: 'model-a', selectedReasoningEffort: 'high' }),
      { model: 'model-b', reasoningEffort: 'high' },
    );
    expect(vm.selectedModelValue).toBe('model-b');
    expect(vm.reasoningDisabled).toBe(true);
  });

  it('does not show a level the pending model does not support as selected', () => {
    const vm = buildModelsViewModel(stateWith(), { model: 'model-b', reasoningEffort: 'high' });
    expect(vm.selectedReasoningValue).toBe(NO_PREFERENCE_VALUE);
  });

  it('shows a supported level as selected', () => {
    const vm = buildModelsViewModel(stateWith(), { model: 'model-a', reasoningEffort: 'high' });
    expect(vm.selectedReasoningValue).toBe('high');
  });

  it('still offers and selects a stored model the catalogue no longer lists', () => {
    // Dropping it would misreport the user's own setting as unset.
    const vm = buildModelsViewModel(stateWith(), { model: 'model-gone', reasoningEffort: null });
    expect(vm.selectedModelValue).toBe('model-gone');
    const option = vm.modelOptions.find((candidate) => candidate.value === 'model-gone');
    expect(option?.label).toBe('model-gone (not currently offered)');
  });

  it('does not duplicate a stored model that IS in the catalogue', () => {
    const vm = buildModelsViewModel(stateWith(), { model: 'model-a', reasoningEffort: null });
    expect(vm.modelOptions.filter((option) => option.value === 'model-a')).toHaveLength(1);
  });

  it('disables the controls while a turn is in flight and says why', () => {
    const vm = buildModelsViewModel(stateWith({ changesLocked: true }), {
      model: null,
      reasoningEffort: null,
    });
    expect(vm.controlsDisabled).toBe(true);
    expect(vm.statusMessage).toContain('in progress');
  });

  it('leaves the controls enabled when idle', () => {
    const vm = buildModelsViewModel(stateWith(), { model: null, reasoningEffort: null });
    expect(vm.controlsDisabled).toBe(false);
    expect(vm.statusMessage).toContain('next prompt');
  });

  it('explains an unreadable catalogue without implying the choice was lost', () => {
    const vm = buildModelsViewModel(
      stateWith({ models: [], catalogUnavailable: true, selectedModel: 'model-a' }),
      { model: 'model-a', reasoningEffort: null },
    );
    expect(vm.statusMessage).toContain('could not be loaded');
    expect(vm.statusMessage).toContain('unchanged');
    expect(vm.selectedModelValue).toBe('model-a');
  });

  it('prefers the lock message over the catalogue message when both apply', () => {
    const vm = buildModelsViewModel(
      stateWith({ models: [], catalogUnavailable: true, changesLocked: true }),
      { model: null, reasoningEffort: null },
    );
    expect(vm.statusMessage).toContain('in progress');
  });
});

describe('fromPickerValue', () => {
  it('collapses the sentinel to null', () => {
    expect(fromPickerValue(NO_PREFERENCE_VALUE)).toBeNull();
  });

  it('passes a real id through', () => {
    expect(fromPickerValue('model-a')).toBe('model-a');
  });

  it('uses a non-empty sentinel, so sp-picker renders its label rather than a placeholder', () => {
    expect(NO_PREFERENCE_VALUE).not.toBe('');
  });
});
