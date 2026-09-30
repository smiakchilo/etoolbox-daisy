import type { JsonValue } from '../../../shared';
import { toolRendererRegistry, type ToolCallDetails } from './toolRegistry';

export type { ToolCallDetails, ToolCallParameter } from './toolRegistry';

/**
 * The standard "what was actually called" view of a tool call: a short
 * one-line summary for the collapsed billet plus the label/value rows revealed
 * when the billet is expanded (`transcriptView.ts`).
 *
 * This file is tool-agnostic. Each tool composes its own view in
 * `src/tools/<name>/renderer/index.ts`; `toolRegistry.ts` discovers them. A
 * tool with no renderer - or whose renderer throws - still renders its entire
 * argument object (`describeGenericArgs`), so a tool can never be silently
 * invisible in the transcript and old chats stay readable.
 *
 * That fallback is a safety net, **not** a finished design. Adding a tool
 * requires a deliberate renderer (AGENTS.md §5): the command and/or
 * parameters a reader actually needs, chosen with the user rather than
 * guessed. An agent that adds a tool must ask what to expose.
 *
 * Only display strings are produced - never DOM, never HTML. The view sets
 * every value through `textContent`: these are model-authored strings crossing
 * a process boundary, and one of them may be an AEM path an author influenced.
 */
export function describeToolCall(
  toolName: string,
  args: Readonly<Record<string, JsonValue>>,
): ToolCallDetails {
  return toolRendererRegistry.describeCall(toolName, args);
}
