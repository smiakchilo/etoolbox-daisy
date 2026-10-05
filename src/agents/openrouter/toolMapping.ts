import { convertMcpInputSchema } from '@openrouter/agent/mcp/schema';
import { tool } from '@openrouter/agent/tool';
import type { Tool } from '@openrouter/agent/tool-types';

import type { RunTool, ToolSpec } from './types';

/**
 * Builds the SDK `Tool[]` handed to `callModel` from this agent's own
 * {@link ToolSpec}s.
 *
 * The toolkit's `parameters` are the JSON Schema `z.toJSONSchema` produced
 * (see `src/shared/tools/core/types.ts`); `convertMcpInputSchema` converts
 * them into the Zod object `tool()` requires, so the model sees exactly the
 * schema the tool validates against. Each tool's `execute` delegates to
 * `runTool` (the service), which emits the normalized `tool.call.*`/
 * `tool.result` events and returns the model-facing value - the SDK's own
 * auto-execution loop otherwise runs the tool silently.
 *
 * Only the tools passed here are ever offered to the model; no server or
 * built-in tool is added anywhere, which is this agent's deny-by-default
 * posture (its equivalent of Copilot's explicit allowlist).
 */
export function buildOpenRouterTools(
  specs: readonly ToolSpec[],
  runTool: RunTool,
): readonly Tool[] {
  return specs.map((spec) => {
    const inputSchema = convertMcpInputSchema(spec.parameters as Record<string, unknown>);
    return tool({
      name: spec.name,
      description: spec.description,
      inputSchema,
      execute: (params: Record<string, unknown>, context) =>
        runTool(spec, params, {
          ...(context?.callId !== undefined ? { callId: context.callId } : {}),
          ...(context?.signal !== undefined ? { signal: context.signal } : {}),
        }),
    });
  });
}
