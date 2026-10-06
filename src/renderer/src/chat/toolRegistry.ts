import type { JsonValue } from '../../../shared';
import {
  describeGenericArgs,
  type ToolCallDetails,
  type ToolRendererModule,
  type ToolResultTable,
} from '../../../shared';

export type { ToolCallDetails, ToolCallParameter } from '../../../shared';

/**
 * Discovers every tool's renderer module: `src/tools/<name>/renderer/index.ts`
 * exporting a `ToolRendererModule` named `renderer`. Nothing else in the
 * renderer names a tool.
 *
 * The glob is eager (transcript rendering is synchronous), so a renderer
 * module must do no work at load time - they are pure functions. A malformed
 * module is skipped, and a renderer function that throws falls back to the
 * generic view below, so one broken tool never takes the transcript down.
 */
export interface ToolRendererRegistry {
  describeCall(
    toolName: string,
    args: Readonly<Record<string, JsonValue>>,
    data?: JsonValue,
  ): ToolCallDetails;
  readResultTable(toolName: string, data: JsonValue | undefined): ToolResultTable | undefined;
  readonly toolNames: readonly string[];
}

function isRendererModule(value: unknown): value is ToolRendererModule {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['toolName'] === 'string' && typeof v['describeCall'] === 'function';
}

export function createToolRendererRegistry(
  modules: Readonly<Record<string, unknown>>,
): ToolRendererRegistry {
  const byName = new Map<string, ToolRendererModule>();
  for (const key of Object.keys(modules).sort()) {
    const candidate = (modules[key] as { renderer?: unknown } | undefined)?.renderer;
    if (isRendererModule(candidate) && !byName.has(candidate.toolName)) {
      byName.set(candidate.toolName, candidate);
    }
  }
  return {
    toolNames: [...byName.keys()],
    describeCall(toolName, args, data) {
      const module = byName.get(toolName);
      if (module === undefined) return describeGenericArgs(args);
      try {
        return module.describeCall(args, data);
      } catch {
        return describeGenericArgs(args);
      }
    },
    readResultTable(toolName, data) {
      const read = byName.get(toolName)?.readResultTable;
      if (read === undefined) return undefined;
      try {
        return read(data);
      } catch {
        return undefined;
      }
    },
  };
}

export const toolRendererRegistry: ToolRendererRegistry = createToolRendererRegistry(
  import.meta.glob('../../../tools/*/renderer/index.ts', { eager: true }),
);
