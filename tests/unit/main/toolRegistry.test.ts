import { describe, expect, it, vi } from 'vitest';
import {
  discoverToolLoaders,
  buildToolRegistry,
  type ToolLoadFailure,
  type ToolModuleLoaders,
} from '../../../src/main/tools/registry';
import type { ToolHost, ToolModule } from '../../../src/shared';
import { newChatId, newServerId, newTurnId } from '../../../src/shared';
import { createCountingIdGenerator } from '../../support/testIds';

const ids = createCountingIdGenerator('reg');
const host: ToolHost = {
  bridge: { request: () => Promise.resolve({ kind: 'cancelled' }) },
  currentContext: () => ({
    origin: 'https://aem.example.com',
    serverId: newServerId(ids),
    serverRevision: 0,
    navigationEpoch: 0,
    chatId: newChatId(ids),
    turnId: newTurnId(ids),
  }),
  clock: () => 1,
  idGenerator: ids,
};

function fakeTool(name: string, overrides: Partial<ToolModule> = {}): ToolModule {
  return {
    name,
    descriptor: {
      name,
      description: `${name} description`,
      parameters: { type: 'object', properties: {} },
    },
    allowlistEntry: `custom:${name}`,
    instructions: `Use '${name}' for its purpose.`,
    createExecutor: () => () => Promise.resolve({ ok: true, value: {} }),
    ...overrides,
  };
}

function loaders(entries: Record<string, () => Promise<unknown>>): ToolModuleLoaders {
  return entries;
}

describe('buildToolRegistry', () => {
  it('registers every enabled tool, in a deterministic order', async () => {
    const registry = await buildToolRegistry({
      host,
      loaders: loaders({
        '/tools/b/tool.ts': () => Promise.resolve({ tool: fakeTool('tool_b') }),
        '/tools/a/tool.ts': () => Promise.resolve({ tool: fakeTool('tool_a') }),
      }),
    });

    expect(registry.enabledNames).toEqual(['tool_a', 'tool_b']);
    expect(registry.allowlistEntries).toEqual(['custom:tool_a', 'custom:tool_b']);
    expect(registry.descriptors.map((d) => d.name)).toEqual(['tool_a', 'tool_b']);
    expect(Object.keys(registry.toolHandlers)).toEqual(['tool_a', 'tool_b']);
    expect(registry.instructions).toContain("'tool_a'");
    expect(registry.instructions).toContain("'tool_b'");
    expect(registry.failures).toEqual([]);
  });

  it('leaves a disabled tool out of the handlers, allowlist, descriptors and instructions', async () => {
    const registry = await buildToolRegistry({
      host,
      loaders: loaders({
        '/tools/a/tool.ts': () => Promise.resolve({ tool: fakeTool('tool_a') }),
        '/tools/off/tool.ts': () =>
          Promise.resolve({ tool: fakeTool('tool_off', { disabled: true }) }),
      }),
    });

    expect(registry.enabledNames).toEqual(['tool_a']);
    expect(registry.disabledNames).toEqual(['tool_off']);
    expect(registry.allowlistEntries).toEqual(['custom:tool_a']);
    expect(registry.instructions).not.toContain('tool_off');
    expect(registry.failures).toEqual([]);
  });

  it('never calls createExecutor for a disabled tool', async () => {
    const createExecutor = vi.fn(() => () => Promise.resolve({ ok: true as const, value: {} }));
    await buildToolRegistry({
      host,
      loaders: loaders({
        '/tools/off/tool.ts': () =>
          Promise.resolve({ tool: fakeTool('tool_off', { disabled: true, createExecutor }) }),
      }),
    });
    expect(createExecutor).not.toHaveBeenCalled();
  });

  it('isolates each failure kind and keeps the healthy tool', async () => {
    const seen: ToolLoadFailure[] = [];
    const registry = await buildToolRegistry({
      host,
      onFailure: (f) => seen.push(f),
      loaders: loaders({
        '/tools/1-load/tool.ts': () => Promise.reject(new Error('boom on import')),
        '/tools/2-shape/tool.ts': () => Promise.resolve({ tool: { name: 'half' } }),
        '/tools/3-no-export/tool.ts': () => Promise.resolve({}),
        '/tools/4-mismatch/tool.ts': () =>
          Promise.resolve({ tool: fakeTool('tool_m', { allowlistEntry: 'custom:other' }) }),
        '/tools/5-factory/tool.ts': () =>
          Promise.resolve({
            tool: fakeTool('tool_f', {
              createExecutor: () => {
                throw new Error('factory exploded');
              },
            }),
          }),
        '/tools/6-good/tool.ts': () => Promise.resolve({ tool: fakeTool('tool_good') }),
      }),
    });

    expect(registry.enabledNames).toEqual(['tool_good']);
    expect(registry.failures.map((f) => f.source)).toEqual([
      '/tools/1-load/tool.ts',
      '/tools/2-shape/tool.ts',
      '/tools/3-no-export/tool.ts',
      '/tools/4-mismatch/tool.ts',
      '/tools/5-factory/tool.ts',
    ]);
    expect(registry.failures[0]?.reason).toMatch(/boom on import/);
    expect(registry.failures[4]?.reason).toMatch(/factory exploded/);
    expect(seen).toEqual(registry.failures);
    expect(registry.allowlistEntries).toEqual(['custom:tool_good']);
    expect(registry.instructions).not.toContain('tool_f');
  });

  it('rejects the second of two tools claiming the same name', async () => {
    const registry = await buildToolRegistry({
      host,
      loaders: loaders({
        '/tools/a/tool.ts': () => Promise.resolve({ tool: fakeTool('same') }),
        '/tools/b/tool.ts': () => Promise.resolve({ tool: fakeTool('same') }),
      }),
    });

    expect(registry.enabledNames).toEqual(['same']);
    expect(registry.failures).toHaveLength(1);
    expect(registry.failures[0]?.reason).toMatch(/Duplicate tool name 'same'/);
  });

  it('with no tools still yields a valid, tool-free registry', async () => {
    const registry = await buildToolRegistry({ host, loaders: {} });
    expect(registry.enabledNames).toEqual([]);
    expect(registry.allowlistEntries).toEqual([]);
    expect(registry.instructions).toMatch(/read-only assistant/);
  });
});

describe('discovered tools (the real src/tools folders)', () => {
  it('enables exactly the shipped read tools and leaves aem_create_page disabled', async () => {
    const registry = await buildToolRegistry({ host, loaders: discoverToolLoaders() });

    expect(registry.failures).toEqual([]);
    expect([...registry.enabledNames].sort()).toEqual(['aem_get_json', 'aem_query']);
    expect(registry.disabledNames).toEqual(['aem_create_page']);
    expect([...registry.allowlistEntries].sort()).toEqual([
      'custom:aem_get_json',
      'custom:aem_query',
    ]);
  });
});
