import { describe, expect, it } from 'vitest';
import {
  isReasoningEffortValidFor,
  modelCatalogEntrySchema,
  parseModelSelectionState,
  supportedReasoningEffortsFor,
  type ModelCatalogEntry,
} from '../../../../src/shared';

/**
 * Contract-level tests for the step 09 model catalogue.
 *
 * The two exported helpers are the single implementation of "which reasoning
 * levels may be offered for this model", shared by the main-process write
 * guard (`setModelPreferences`) and the renderer's view model. Testing them
 * here rather than twice over is what makes that sharing safe.
 */

const models: readonly ModelCatalogEntry[] = [
  { id: 'model-a', name: 'Model A', supportedReasoningEfforts: ['low', 'high'] },
  { id: 'model-b', name: 'Model B', supportedReasoningEfforts: [] },
];

describe('modelCatalogEntrySchema', () => {
  it('rejects an unknown key rather than carrying it across the IPC boundary', () => {
    const result = modelCatalogEntrySchema.safeParse({
      id: 'model-a',
      name: 'Model A',
      supportedReasoningEfforts: [],
      billing: { premium: true },
    });
    expect(result.success).toBe(false);
  });

  it('accepts an entry with no default reasoning effort', () => {
    const result = modelCatalogEntrySchema.safeParse({
      id: 'model-a',
      name: 'Model A',
      supportedReasoningEfforts: ['low'],
    });
    expect(result.success).toBe(true);
  });
});

describe('supportedReasoningEffortsFor', () => {
  it("returns the model's own levels", () => {
    expect(supportedReasoningEffortsFor(models, 'model-a')).toEqual(['low', 'high']);
  });

  it('returns nothing for a model absent from the catalogue', () => {
    // The point: an unknown model must not inherit another model's levels, and
    // must not be guessed at from the SDK's type-level union.
    expect(supportedReasoningEffortsFor(models, 'model-ghost')).toEqual([]);
  });

  it('returns nothing when no model is selected', () => {
    expect(supportedReasoningEffortsFor(models, null)).toEqual([]);
  });
});

describe('isReasoningEffortValidFor', () => {
  it('allows null for any model, including one with no levels at all', () => {
    expect(isReasoningEffortValidFor(models, 'model-b', null)).toBe(true);
    expect(isReasoningEffortValidFor(models, null, null)).toBe(true);
  });

  it('allows a level the model lists', () => {
    expect(isReasoningEffortValidFor(models, 'model-a', 'high')).toBe(true);
  });

  it('rejects a level that belongs to a different model', () => {
    // This is what stops a level surviving a model change.
    expect(isReasoningEffortValidFor(models, 'model-b', 'high')).toBe(false);
  });

  it('rejects any level for a model that is not in the catalogue', () => {
    expect(isReasoningEffortValidFor(models, 'model-ghost', 'low')).toBe(false);
  });

  it('rejects a level for a null model', () => {
    expect(isReasoningEffortValidFor(models, null, 'low')).toBe(false);
  });
});

describe('parseModelSelectionState', () => {
  it('round-trips a complete state', () => {
    const state = parseModelSelectionState({
      models: [{ id: 'model-a', name: 'Model A', supportedReasoningEfforts: ['low'] }],
      selectedModel: 'model-a',
      selectedReasoningEffort: 'low',
      catalogUnavailable: false,
    });
    expect(state.selectedModel).toBe('model-a');
    expect(state.models).toHaveLength(1);
  });

  it('throws when a required field is missing, rather than defaulting it', () => {
    // Defaulting `catalogUnavailable` would silently present an unreadable
    // catalogue as an empty-but-readable one.
    expect(() =>
      parseModelSelectionState({
        models: [],
        selectedModel: null,
        selectedReasoningEffort: null,
      }),
    ).toThrow();
  });
});
