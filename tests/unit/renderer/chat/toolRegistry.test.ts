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

describe('discovered renderers (the real src/tools folders)', () => {
  it('finds the shipped tools', () => {
    expect([...toolRendererRegistry.toolNames].sort()).toEqual([
      'aem_environment_facts',
      'aem_get_json',
      'aem_query',
      'ask_user',
      'format_table',
    ]);
  });
});
