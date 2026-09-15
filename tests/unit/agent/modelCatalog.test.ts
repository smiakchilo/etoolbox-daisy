import { describe, expect, it } from 'vitest';
import { loadModelCatalog, projectModelCatalog } from '../../../src/agent/modelCatalog';

/**
 * Tests for the SDK -> application projection of the model catalogue
 * (implementation-plan.md step 09).
 *
 * `projectModelCatalog` is exercised directly with fixture data because every
 * decision worth testing lives in it: how the SDK's two disagreeing
 * capability fields are resolved, and what is dropped rather than trusted.
 */

describe('projectModelCatalog', () => {
  it('projects id, name and supported levels', () => {
    const result = projectModelCatalog([
      {
        id: 'model-a',
        name: 'Model A',
        supportedReasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'low',
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      {
        id: 'model-a',
        name: 'Model A',
        supportedReasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'low',
      },
    ]);
  });

  it('falls back to the id when the SDK gives no display name', () => {
    const result = projectModelCatalog([{ id: 'model-a' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.name).toBe('model-a');
  });

  it('keeps extra SDK fields from breaking the projection', () => {
    // The whole reason `sdkModelInfoSchema` is loose: a patch-release field
    // must not empty the model picker.
    const result = projectModelCatalog([
      {
        id: 'model-a',
        name: 'Model A',
        billing: { isPremium: true },
        policy: { state: 'enabled' },
        someFieldAddedNextRelease: 42,
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
  });

  describe('capability disagreement', () => {
    it('lets `supports.reasoningEffort: false` win over a non-empty level list', () => {
      const result = projectModelCatalog([
        {
          id: 'model-a',
          name: 'Model A',
          capabilities: { supports: { reasoningEffort: false } },
          supportedReasoningEfforts: ['low', 'high'],
        },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]?.supportedReasoningEfforts).toEqual([]);
    });

    it('does not invent levels when `supports.reasoningEffort: true` lists none', () => {
      const result = projectModelCatalog([
        {
          id: 'model-a',
          name: 'Model A',
          capabilities: { supports: { reasoningEffort: true } },
        },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]?.supportedReasoningEfforts).toEqual([]);
    });

    it('trusts the level list when capabilities say nothing', () => {
      const result = projectModelCatalog([
        { id: 'model-a', name: 'Model A', supportedReasoningEfforts: ['medium'] },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]?.supportedReasoningEfforts).toEqual(['medium']);
    });
  });

  it('drops a default reasoning effort the model does not itself list', () => {
    // Otherwise it would be preselected and then refused on save.
    const result = projectModelCatalog([
      {
        id: 'model-a',
        name: 'Model A',
        supportedReasoningEfforts: ['low'],
        defaultReasoningEffort: 'max',
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).not.toHaveProperty('defaultReasoningEffort');
  });

  it('drops a default that is suppressed along with the whole level list', () => {
    const result = projectModelCatalog([
      {
        id: 'model-a',
        name: 'Model A',
        capabilities: { supports: { reasoningEffort: false } },
        supportedReasoningEfforts: ['low'],
        defaultReasoningEffort: 'low',
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).not.toHaveProperty('defaultReasoningEffort');
  });

  it('keeps the first of two entries sharing an id', () => {
    const result = projectModelCatalog([
      { id: 'model-a', name: 'First' },
      { id: 'model-a', name: 'Second' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([{ id: 'model-a', name: 'First', supportedReasoningEfforts: [] }]);
  });

  it('drops one malformed entry but keeps the rest', () => {
    const result = projectModelCatalog([
      { id: 'model-a', name: 'Model A' },
      { name: 'no id at all' },
      { id: '', name: 'empty id' },
      { id: 'model-b', name: 'Model B' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((entry) => entry.id)).toEqual(['model-a', 'model-b']);
  });

  it('reports a non-array response as malformed', () => {
    const result = projectModelCatalog({ models: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('malformed');
  });

  it('returns an empty catalogue, not an error, for an empty list', () => {
    const result = projectModelCatalog([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});

describe('loadModelCatalog', () => {
  it('projects what the source returns', async () => {
    const result = await loadModelCatalog({
      listModels: () => Promise.resolve([{ id: 'model-a', name: 'Model A' }]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
  });

  it('reports a rejected listModels() as `unavailable`, not as a crash', async () => {
    // This is the ordinary case of opening Settings before the Copilot runtime
    // has finished starting - it must not throw out of the IPC handler.
    const result = await loadModelCatalog({
      listModels: () => Promise.reject(new Error('not connected')),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unavailable');
  });

  it('does not leak raw SDK error text into the message', async () => {
    const result = await loadModelCatalog({
      listModels: () => Promise.reject(new Error('token sk-secret-value rejected')),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).not.toContain('sk-secret-value');
  });
});
