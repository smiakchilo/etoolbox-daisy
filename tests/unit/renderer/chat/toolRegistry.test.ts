import { describe, expect, it } from 'vitest';
import {
  createToolRendererRegistry,
  toolRendererRegistry,
} from '../../../../src/renderer/src/chat/toolRegistry';
import type { ToolRendererModule } from '../../../../src/shared';

function rendererModule(overrides: Partial<ToolRendererModule> = {}): ToolRendererModule {
  return {
    toolName: 'demo_tool',
    describeCall: () => ({ summary: 'demo', parameters: [] }),
    ...overrides,
  };
}

describe('createToolRendererRegistry', () => {
  it('dispatches by tool name to the tool-owned renderer', () => {
    const registry = createToolRendererRegistry({
      './demo/renderer/index.ts': { renderer: rendererModule() },
    });
    expect(registry.describeCall('demo_tool', {}).summary).toBe('demo');
    expect(registry.toolNames).toEqual(['demo_tool']);
  });

  it('falls back to the generic view for a tool with no renderer, so it is never invisible', () => {
    const registry = createToolRendererRegistry({});
    const details = registry.describeCall('unknown_tool', { a: 'b' });
    expect(details.parameters.map((p) => p.label)).toContain('a');
  });

  it('falls back to the generic view when a renderer throws', () => {
    const registry = createToolRendererRegistry({
      './demo/renderer/index.ts': {
        renderer: rendererModule({
          describeCall: () => {
            throw new Error('renderer bug');
          },
        }),
      },
    });
    expect(() => registry.describeCall('demo_tool', { a: 'b' })).not.toThrow();
    expect(registry.describeCall('demo_tool', { a: 'b' }).parameters.length).toBeGreaterThan(0);
  });

  it('skips a malformed module and keeps the healthy ones', () => {
    const registry = createToolRendererRegistry({
      './bad/renderer/index.ts': { renderer: { toolName: 7 } },
      './none/renderer/index.ts': {},
      './demo/renderer/index.ts': { renderer: rendererModule() },
    });
    expect(registry.toolNames).toEqual(['demo_tool']);
  });

  it('keeps the first of two renderers claiming one tool name', () => {
    const registry = createToolRendererRegistry({
      './a/renderer/index.ts': { renderer: rendererModule() },
      './b/renderer/index.ts': {
        renderer: rendererModule({ describeCall: () => ({ summary: 'second', parameters: [] }) }),
      },
    });
    expect(registry.describeCall('demo_tool', {}).summary).toBe('demo');
  });

  it('returns undefined rather than throwing when readTableMessage throws', () => {
    const registry = createToolRendererRegistry({
      './demo/renderer/index.ts': {
        renderer: rendererModule({
          readTableMessage: () => {
            throw new Error('table bug');
          },
        }),
      },
    });
    expect(registry.readTableMessage('demo_tool', {})).toBeUndefined();
    expect(registry.readTableMessage('other', {})).toBeUndefined();
  });
});

describe('readActions', () => {
  const action = { kind: 'memo.undo', target: 'a.md' } as const;

  it('returns the actions the tool-owned renderer reads', () => {
    const registry = createToolRendererRegistry({
      './demo/renderer/index.ts': { renderer: rendererModule({ readActions: () => [action] }) },
    });
    expect(registry.readActions('demo_tool', {}, {})).toEqual([action]);
  });

  it('returns no actions for an unknown tool, a renderer without readActions, or a throwing one', () => {
    const registry = createToolRendererRegistry({
      './demo/renderer/index.ts': { renderer: rendererModule() },
      './bad/renderer/index.ts': {
        renderer: rendererModule({
          toolName: 'bad_tool',
          readActions: () => {
            throw new Error('actions bug');
          },
        }),
      },
    });
    expect(registry.readActions('unknown', {}, {})).toEqual([]);
    expect(registry.readActions('demo_tool', {}, {})).toEqual([]);
    expect(registry.readActions('bad_tool', {}, {})).toEqual([]);
  });
});

describe('discovered renderers (the real src/tools folders)', () => {
  it('finds the shipped tools', () => {
    expect([...toolRendererRegistry.toolNames].sort()).toEqual([
      'aem_get_json',
      'aem_query',
      'aem_query_format_ask',
      'aem_semantic_search',
      'ask_user',
      'browser_navigate',
      'environment_facts',
      'format_table',
      'memo',
      'memo_reflection',
      'skill',
      'skill_resource',
      'skill_script',
    ]);
  });
});
