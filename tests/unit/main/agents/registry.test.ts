import { describe, expect, it, vi } from 'vitest';
import { buildAgentRegistry } from '../../../../src/main/agents/registry';
import { buildAgentCatalog, type AgentId, type AgentModule } from '../../../../src/shared';

const id = (value: string): AgentId => value as AgentId;
const moduleFor = (value: string): AgentModule => ({
  id: id(value),
  createRuntime: () => {
    throw new Error('not needed');
  },
});
const metaFor = (value: string, extra: object = {}) => ({
  meta: {
    id: id(value),
    label: value,
    requiresAuth: false,
    supportsInteractiveLogin: false,
    ...extra,
  },
});

const definitions = [
  { id: id('alpha'), label: 'alpha', requiresAuth: false, supportsInteractiveLogin: false },
  { id: id('beta'), label: 'beta', requiresAuth: false, supportsInteractiveLogin: false },
];

describe('buildAgentCatalog', () => {
  it('lists enabled agents in path order and reports the disabled ones by source', () => {
    const result = buildAgentCatalog({
      '../../agents/zeta/meta.ts': metaFor('zeta'),
      '../../agents/beta/meta.ts': metaFor('beta', { disabled: true }),
      '../../agents/alpha/meta.ts': metaFor('alpha'),
    });
    expect(result.definitions.map((d) => d.id)).toEqual(['alpha', 'zeta']);
    expect(result.disabledIds).toEqual(['beta']);
    expect(result.disabledSources).toEqual(['../../agents/beta/meta.ts']);
    expect(result.failures).toEqual([]);
  });

  it('skips a malformed meta and a duplicate id without failing the rest', () => {
    const result = buildAgentCatalog({
      '../../agents/a/meta.ts': metaFor('same'),
      '../../agents/b/meta.ts': metaFor('same'),
      '../../agents/c/meta.ts': { meta: { id: 'x' } },
      '../../agents/d/meta.ts': {},
      '../../agents/e/meta.ts': metaFor('fine'),
    });
    expect(result.definitions.map((d) => d.id)).toEqual(['same', 'fine']);
    expect(result.failures.map((f) => f.source)).toEqual([
      '../../agents/b/meta.ts',
      '../../agents/c/meta.ts',
      '../../agents/d/meta.ts',
    ]);
  });
});

describe('buildAgentRegistry', () => {
  it('loads the enabled agents lazily, in sorted order', async () => {
    const result = await buildAgentRegistry({
      loaders: {
        '../../agents/beta/agent.ts': () => Promise.resolve({ agent: moduleFor('beta') }),
        '../../agents/alpha/agent.ts': () => Promise.resolve({ agent: moduleFor('alpha') }),
      },
      definitions,
      disabledSources: [],
    });
    expect(result.modules.map((m) => m.id)).toEqual(['alpha', 'beta']);
    expect(result.failures).toEqual([]);
  });

  it('never loads the agent.ts of a disabled agent', async () => {
    const loadBeta = vi.fn(() => Promise.resolve({ agent: moduleFor('beta') }));
    const result = await buildAgentRegistry({
      loaders: {
        '../../agents/alpha/agent.ts': () => Promise.resolve({ agent: moduleFor('alpha') }),
        '../../agents/beta/agent.ts': loadBeta,
      },
      definitions: definitions.slice(0, 1),
      disabledSources: ['../../agents/beta/meta.ts'],
    });
    expect(loadBeta).not.toHaveBeenCalled();
    expect(result.modules.map((m) => m.id)).toEqual(['alpha']);
    expect(result.failures).toEqual([]);
  });

  it('isolates an agent whose module throws while loading', async () => {
    const onFailure = vi.fn();
    const result = await buildAgentRegistry({
      loaders: {
        '../../agents/alpha/agent.ts': () => Promise.reject(new Error("Cannot find module 'sdk'")),
        '../../agents/beta/agent.ts': () => Promise.resolve({ agent: moduleFor('beta') }),
      },
      definitions,
      disabledSources: [],
      onFailure,
    });
    expect(result.modules.map((m) => m.id)).toEqual(['beta']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toContain("Cannot find module 'sdk'");
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('rejects a module that is not an AgentModule', async () => {
    const result = await buildAgentRegistry({
      loaders: {
        '../../agents/alpha/agent.ts': () => Promise.resolve({ agent: { id: 'alpha' } }),
        '../../agents/beta/agent.ts': () => Promise.resolve({}),
      },
      definitions,
      disabledSources: [],
    });
    expect(result.modules).toEqual([]);
    expect(result.failures).toHaveLength(2);
  });

  it('rejects a module whose id matches no enabled meta', async () => {
    const result = await buildAgentRegistry({
      loaders: {
        '../../agents/alpha/agent.ts': () => Promise.resolve({ agent: moduleFor('gamma') }),
      },
      definitions,
      disabledSources: [],
    });
    expect(result.modules).toEqual([]);
    expect(result.failures[0]?.reason).toContain("'gamma'");
  });

  it('rejects a duplicate id', async () => {
    const result = await buildAgentRegistry({
      loaders: {
        '../../agents/a/agent.ts': () => Promise.resolve({ agent: moduleFor('alpha') }),
        '../../agents/b/agent.ts': () => Promise.resolve({ agent: moduleFor('alpha') }),
      },
      definitions,
      disabledSources: [],
    });
    expect(result.modules).toHaveLength(1);
    expect(result.failures[0]?.reason).toContain('Duplicate');
  });

  it('yields an empty registry when there are no agent folders', async () => {
    const result = await buildAgentRegistry({ loaders: {}, definitions: [], disabledSources: [] });
    expect(result).toEqual({ modules: [], failures: [] });
  });
});
