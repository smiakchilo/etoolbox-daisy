import { z } from 'zod';
import {
  type Result,
  err,
  ok,
  renderToolFailureForModel,
  toolErrorResultSchema,
} from '../../src/shared';
import {
  type AemGetJsonSuccess,
  aemGetJsonRequestSchema,
  aemGetJsonSuccessSchema,
  renderGetJsonSuccess,
} from '../../src/tools/aem-get-json/aemGetJson';
import {
  type AemQuerySuccess,
  aemQueryRequestSchema,
  aemQuerySuccessSchema,
  renderQuerySuccess,
} from '../../src/tools/aem-query/aemQuery';

/**
 * Test-only closed unions over the two shipped read tools.
 *
 * The application no longer has a closed union of tools (each tool owns its own
 * request and result types); these helpers rebuild one so the transport fakes
 * and contract tests can still parse "any tool's" envelope or result.
 */

export const toolRequestEnvelopeSchema = z.discriminatedUnion('operation', [
  aemGetJsonRequestSchema,
  aemQueryRequestSchema,
]);

export type ToolRequestEnvelope = z.infer<typeof toolRequestEnvelopeSchema>;

export const toolResultSchema = z.discriminatedUnion('ok', [
  z.discriminatedUnion('operation', [aemGetJsonSuccessSchema, aemQuerySuccessSchema]),
  toolErrorResultSchema,
]);

export type ToolSuccess = AemGetJsonSuccess | AemQuerySuccess;
export type ToolResult = ToolSuccess | z.infer<typeof toolErrorResultSchema>;

export function serializeToolResult(result: ToolResult): string {
  return JSON.stringify(result);
}

export function parseToolResult(serialized: string): Result<ToolResult> {
  let candidate: unknown;
  try {
    candidate = JSON.parse(serialized);
  } catch {
    return err('malformed JSON');
  }
  const parsed = toolResultSchema.safeParse(candidate);
  if (!parsed.success) {
    return err(parsed.error.issues[0]?.message ?? 'does not match the tool result schema');
  }
  return ok(parsed.data);
}

export function renderToolResultForModel(result: ToolResult): string {
  if (!result.ok) return renderToolFailureForModel(result.error);
  return result.operation === 'aem_get_json'
    ? renderGetJsonSuccess(result)
    : renderQuerySuccess(result);
}
