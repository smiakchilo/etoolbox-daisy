import { describe, expect, it } from 'vitest';
import {
  loadOpenRouterModelCatalog,
  projectOpenRouterModelCatalog,
} from '../../../../src/agents/openrouter/modelCatalog';

/**
 * Projection tests for the OpenRouter catalogue: the SDK-free, decision-heavy
 * half of `modelCatalog.ts`, exercised against SDK-shaped fixtures.
 */
describe('projectOpenRouterModelCatalog', () => {
  it('projects id/name/reasoning efforts and drops a default the model does not list', () => {
    const result = projectOpenRouterModelCatalog([
      {
        id: 'anthropic/claude-x',
        name: 'Claude X',
        reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'medium' },
        pricing: { prompt: '0' },
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      {
        id: 'anthropic/claude-x',
        name: 'Claude X',
        supportedReasoningEfforts: ['low', 'high'],
      },
    ]);
  });

  it('keeps a default the model lists and falls back to id for a missing name', () => {
    const result = projectOpenRouterModelCatalog([
      { id: 'openai/gpt-x', reasoning: { supportedEfforts: ['low'], defaultEffort: 'low' } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toEqual({
      id: 'openai/gpt-x',
      name: 'openai/gpt-x',
      supportedReasoningEfforts: ['low'],
      defaultReasoningEffort: 'low',
    });
  });

  it('sorts the catalogue by display name, case-insensitively, with the id as a tie-breaker', () => {
    // OpenRouter's list is huge and arrives unordered; the projection orders it
    // so the picker is navigable. Version numbers compare numerically, and two
    // identical names fall back to the id so the order is fully deterministic.
    const result = projectOpenRouterModelCatalog([
      { id: 'vendor/two', name: 'banana' },
      { id: 'vendor/ten', name: 'Apple 10' },
      { id: 'vendor/same-b', name: 'Same' },
      { id: 'vendor/one', name: 'cherry' },
      { id: 'vendor/apple-2', name: 'Apple 2' },
      { id: 'vendor/same-a', name: 'Same' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((entry) => entry.id)).toEqual([
      'vendor/apple-2',
      'vendor/ten',
      'vendor/two',
      'vendor/one',
      'vendor/same-a',
      'vendor/same-b',
    ]);
  });

  it('yields no efforts when reasoning is absent or null', () => {
    const result = projectOpenRouterModelCatalog([
      { id: 'a/one', name: 'One' },
      { id: 'a/two', name: 'Two', reasoning: { supportedEfforts: null } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.every((entry) => entry.supportedReasoningEfforts.length === 0)).toBe(true);
  });

  it('de-duplicates ids and skips unusable entries', () => {
    const result = projectOpenRouterModelCatalog([
      { id: 'a/one', name: 'One' },
      { id: 'a/one', name: 'One again' },
      { name: 'no id' },
      'not an object',
      { id: 'a/three', name: 'Three' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((entry) => entry.id)).toEqual(['a/one', 'a/three']);
  });

  it('reports a malformed envelope rather than throwing', () => {
    const result = projectOpenRouterModelCatalog({ not: 'an array' });
    expect(result.ok).toBe(false);
  });
});

describe('loadOpenRouterModelCatalog', () => {
  it('converts a thrown list failure into an error result', async () => {
    const result = await loadOpenRouterModelCatalog({
      listModels: () => Promise.reject(new Error('network')),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('OpenRouter');
  });

  it('projects a resolved list', async () => {
    const result = await loadOpenRouterModelCatalog({
      listModels: () => Promise.resolve([{ id: 'a/one', name: 'One' }]),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((entry) => entry.id)).toEqual(['a/one']);
  });
});
