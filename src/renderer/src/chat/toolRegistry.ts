import type { JsonValue } from '../../../shared';
import {
  type ToolCallDetails,
  type ToolConversationItem,
  type ToolPresentation,
  type ToolRendererModule,
  type ToolReportMessage,
  type ToolTableMessage,
  addonPins,
  describeGenericArgs,
} from '../../../shared';
import { contributeToolRenderers } from './contributedTools';

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
  /** How the transcript presents this tool's calls; `'billet'` for an unknown tool. */
  presentationOf(toolName: string): ToolPresentation;
  /** The question/answer pair a `'conversation'` tool paints; `undefined` otherwise. */
  readConversation(
    toolName: string,
    args: Readonly<Record<string, JsonValue>>,
    data?: JsonValue,
  ): ToolConversationItem | undefined;
  /** The assistant message a `'message'` tool paints; `undefined` otherwise. */
  readTableMessage(
    toolName: string,
    args: Readonly<Record<string, JsonValue>>,
    data?: JsonValue,
  ): ToolTableMessage | undefined;
  /** The structured report a `'report'` tool paints; `undefined` otherwise. */
  readReportMessage(
    toolName: string,
    args: Readonly<Record<string, JsonValue>>,
    data?: JsonValue,
  ): ToolReportMessage | undefined;
  readonly toolNames: readonly string[];
}

function isRendererModule(value: unknown): value is ToolRendererModule {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['toolName'] === 'string' && typeof v['describeCall'] === 'function';
}

export function createToolRendererRegistry(
  modules: Readonly<Record<string, unknown>>,
  contributed: readonly ToolRendererModule[] = [],
): ToolRendererRegistry {
  const byName = new Map<string, ToolRendererModule>();
  for (const key of Object.keys(modules).sort()) {
    const candidate = (modules[key] as { renderer?: unknown } | undefined)?.renderer;
    if (isRendererModule(candidate) && !byName.has(candidate.toolName)) {
      byName.set(candidate.toolName, candidate);
    }
  }
  // An add-on's tools render from the pins; a folder renderer of the same name
  // would be a build fault, so it can only ever be absent here.
  for (const candidate of contributed) {
    if (!byName.has(candidate.toolName)) byName.set(candidate.toolName, candidate);
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
    readTableMessage(toolName, args, data) {
      const read = byName.get(toolName)?.readTableMessage;
      if (read === undefined) return undefined;
      try {
        return read(args, data);
      } catch {
        return undefined;
      }
    },
    presentationOf(toolName) {
      return byName.get(toolName)?.presentation ?? 'billet';
    },
    readConversation(toolName, args, data) {
      const read = byName.get(toolName)?.readConversation;
      if (read === undefined) return undefined;
      try {
        return read(args, data);
      } catch {
        return undefined;
      }
    },
    readReportMessage(toolName, args, data) {
      const read = byName.get(toolName)?.readReportMessage;
      if (read === undefined) return undefined;
      try {
        return read(args, data);
      } catch {
        return undefined;
      }
    },
  };
}

export const toolRendererRegistry: ToolRendererRegistry = createToolRendererRegistry(
  import.meta.glob('../../../tools/*/renderer/index.ts', { eager: true }),
  contributeToolRenderers(addonPins),
);
