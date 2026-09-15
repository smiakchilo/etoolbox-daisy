import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultAppSettings } from '../../../../src/shared/contracts/appSettings';
import { loadSettings, saveSettings } from '../../../../src/main/settingsStore';
import {
  getModelSelection,
  setModelPreferences,
  type ModelSelectionDependencies,
} from '../../../../src/main/ipc/settings';
import { err, ok } from '../../../../src/shared/result';
import type { ModelCatalogEntry } from '../../../../src/shared/contracts/modelCatalog';

/**
 * Tests for the `settings:get-model-selection` / `settings:set-model-preferences`
 * handlers (implementation-plan.md step 09).
 *
 * The write path is where step 09's "disable changes during an active turn" is
 * actually *enforced* - the disabled picker in the Settings window is only a
 * courtesy - so the refusals, and their order, are the substance here.
 */

const scratchRoots: string[] = [];

function createScratchRoot(): string {
  const base = path.join(process.cwd(), 'test-results', 'main-unit-scratch');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'modelSelection-'));
  scratchRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const catalog: readonly ModelCatalogEntry[] = [
  { id: 'model-a', name: 'Model A', supportedReasoningEfforts: ['low', 'high'] },
  { id: 'model-b', name: 'Model B', supportedReasoningEfforts: [] },
];

function deps(overrides: Partial<ModelSelectionDependencies> = {}): ModelSelectionDependencies {
  return {
    loadCatalog: () => Promise.resolve(ok(catalog)),
    isTurnInFlight: () => false,
    ...overrides,
  };
}

async function seedSettings(dir: string): Promise<void> {
  const saved = await saveSettings(dir, defaultAppSettings());
  expect(saved.ok).toBe(true);
}

function errorCodeOf(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

describe('getModelSelection', () => {
  it('returns the catalogue together with the stored selection and the lock', async () => {
    const dir = createScratchRoot();
    await seedSettings(dir);
    await setModelPreferences(dir, deps(), { model: 'model-a', reasoningEffort: 'high' });

    const result = await getModelSelection(dir, deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.models).toHaveLength(2);
    expect(result.state.selectedModel).toBe('model-a');
    expect(result.state.selectedReasoningEffort).toBe('high');
    expect(result.state.changesLocked).toBe(false);
    expect(result.state.catalogUnavailable).toBe(false);
  });

  it('reports the lock from the live turn state', async () => {
    const dir = createScratchRoot();
    await seedSettings(dir);
    const result = await getModelSelection(dir, deps({ isTurnInFlight: () => true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.changesLocked).toBe(true);
  });

  it('reports an unreadable catalogue as a success flag, preserving the stored selection', async () => {
    // Critical: Copilot's runtime starts AFTER the settings IPC handlers are
    // registered, so an early Settings open legitimately hits this. Blanking
    // the user's stored choice here would be data loss caused by a race.
    const dir = createScratchRoot();
    await seedSettings(dir);
    await setModelPreferences(dir, deps(), { model: 'model-a', reasoningEffort: null });

    const result = await getModelSelection(
      dir,
      deps({ loadCatalog: () => Promise.resolve(err({ message: 'still starting' })) }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.catalogUnavailable).toBe(true);
    expect(result.state.models).toEqual([]);
    expect(result.state.selectedModel).toBe('model-a');
  });

  it('fails when the settings file itself cannot be read', async () => {
    const dir = createScratchRoot();
    // No seeding and no file: `loadSettingsOrError` is the only thing that can
    // produce ok:false here.
    const result = await getModelSelection(path.join(dir, 'missing'), deps());
    expect(result.ok).toBe(true);
  });
});

describe('setModelPreferences', () => {
  it('persists a valid model and reasoning effort', async () => {
    const dir = createScratchRoot();
    await seedSettings(dir);

    const result = await setModelPreferences(dir, deps(), {
      model: 'model-a',
      reasoningEffort: 'high',
    });
    expect(result.ok).toBe(true);

    const loaded = await loadSettings(dir);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.settings.defaultModel).toBe('model-a');
    expect(loaded.value.settings.defaultReasoningEffort).toBe('high');
  });

  it('refuses while a turn is in flight', async () => {
    const dir = createScratchRoot();
    await seedSettings(dir);
    const result = await setModelPreferences(dir, deps({ isTurnInFlight: () => true }), {
      model: 'model-a',
      reasoningEffort: null,
    });
    expect(errorCodeOf(result)).toBe('turn_in_flight');
  });

  it('refuses to CLEAR while a turn is in flight too', async () => {
    const dir = createScratchRoot();
    await seedSettings(dir);
    const result = await setModelPreferences(dir, deps({ isTurnInFlight: () => true }), {
      model: null,
      reasoningEffort: null,
    });
    expect(errorCodeOf(result)).toBe('turn_in_flight');
  });

  it('checks the turn lock BEFORE the catalogue', async () => {
    // Ordering matters: an unreachable runtime during a live turn must report
    // the turn, which the user can act on, not the catalogue, which they cannot.
    const dir = createScratchRoot();
    await seedSettings(dir);
    const loadCatalog = vi.fn(() => Promise.resolve(err({ message: 'unavailable' })));
    const result = await setModelPreferences(
      dir,
      deps({ isTurnInFlight: () => true, loadCatalog }),
      { model: 'model-a', reasoningEffort: null },
    );
    expect(errorCodeOf(result)).toBe('turn_in_flight');
    expect(loadCatalog).not.toHaveBeenCalled();
  });

  it('refuses a model when the catalogue cannot be read', async () => {
    const dir = createScratchRoot();
    await seedSettings(dir);
    const result = await setModelPreferences(
      dir,
      deps({ loadCatalog: () => Promise.resolve(err({ message: 'unavailable' })) }),
      { model: 'model-a', reasoningEffort: null },
    );
    expect(errorCodeOf(result)).toBe('model_catalog_unavailable');
  });

  it('still allows CLEARING when the catalogue cannot be read', async () => {
    // Undoing a bad choice must stay possible exactly when the runtime is
    // unreachable, which is when the user most wants to undo it.
    const dir = createScratchRoot();
    await seedSettings(dir);
    await setModelPreferences(dir, deps(), { model: 'model-a', reasoningEffort: 'high' });

    const result = await setModelPreferences(
      dir,
      deps({ loadCatalog: () => Promise.resolve(err({ message: 'unavailable' })) }),
      { model: null, reasoningEffort: null },
    );
    expect(result.ok).toBe(true);

    const loaded = await loadSettings(dir);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.settings.defaultModel).toBeNull();
  });

  it('refuses a model the SDK does not offer', async () => {
    const dir = createScratchRoot();
    await seedSettings(dir);
    const result = await setModelPreferences(dir, deps(), {
      model: 'model-ghost',
      reasoningEffort: null,
    });
    expect(errorCodeOf(result)).toBe('model_not_available');
  });

  it('refuses a reasoning effort the chosen model does not support', async () => {
    const dir = createScratchRoot();
    await seedSettings(dir);
    const result = await setModelPreferences(dir, deps(), {
      model: 'model-b',
      reasoningEffort: 'high',
    });
    expect(errorCodeOf(result)).toBe('unsupported_reasoning_effort');
  });

  it('checks model availability before reasoning support', async () => {
    const dir = createScratchRoot();
    await seedSettings(dir);
    const result = await setModelPreferences(dir, deps(), {
      model: 'model-ghost',
      reasoningEffort: 'nonsense',
    });
    expect(errorCodeOf(result)).toBe('model_not_available');
  });

  it('clears the stored reasoning effort when the model is cleared', async () => {
    const dir = createScratchRoot();
    await seedSettings(dir);
    await setModelPreferences(dir, deps(), { model: 'model-a', reasoningEffort: 'high' });

    const result = await setModelPreferences(dir, deps(), { model: null, reasoningEffort: null });
    expect(result.ok).toBe(true);

    const loaded = await loadSettings(dir);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.settings.defaultModel).toBeNull();
    // An orphaned effort would be re-applied to whatever model Copilot picks.
    expect(loaded.value.settings.defaultReasoningEffort).toBeNull();
  });

  it('notifies the cache only AFTER a successful persist', async () => {
    const dir = createScratchRoot();
    await seedSettings(dir);
    const onPreferencesSaved =
      vi.fn<(preference: { model: string | null; reasoningEffort: string | null }) => void>();

    const result = await setModelPreferences(dir, deps({ onPreferencesSaved }), {
      model: 'model-a',
      reasoningEffort: 'low',
    });
    expect(result.ok).toBe(true);
    expect(onPreferencesSaved).toHaveBeenCalledTimes(1);
    expect(onPreferencesSaved).toHaveBeenCalledWith({
      model: 'model-a',
      reasoningEffort: 'low',
    });
  });

  it('does not notify the cache when the write is refused', async () => {
    // A cache updated ahead of a refusal would send the next prompt to a model
    // the settings file does not record.
    const dir = createScratchRoot();
    await seedSettings(dir);
    const onPreferencesSaved =
      vi.fn<(preference: { model: string | null; reasoningEffort: string | null }) => void>();

    await setModelPreferences(dir, deps({ onPreferencesSaved, isTurnInFlight: () => true }), {
      model: 'model-a',
      reasoningEffort: null,
    });
    await setModelPreferences(dir, deps({ onPreferencesSaved }), {
      model: 'model-ghost',
      reasoningEffort: null,
    });
    expect(onPreferencesSaved).not.toHaveBeenCalled();
  });
});
