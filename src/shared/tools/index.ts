import { z } from 'zod';
import { err, ok, type Result } from '../result';
import { toolErrorResultSchema } from './core/resultCommon';
import {
  AEM_GET_JSON_ALLOWLIST_ENTRY,
  AEM_GET_JSON_TOOL_DESCRIPTOR,
  aemGetJsonRequestSchema,
  aemGetJsonSuccessSchema,
  renderGetJsonSuccess,
  type AemGetJsonSuccess,
} from './aemGetJson';
import {
  AEM_QUERY_ALLOWLIST_ENTRY,
  AEM_QUERY_TOOL_DESCRIPTOR,
  aemQueryRequestSchema,
  aemQuerySuccessSchema,
  renderQuerySuccess,
  type AemQuerySuccess,
} from './aemQuery';
import type { ToolDefinition } from './core/types';

export * from './core/envelope';
export * from './core/brokerOutcome';
export * from './core/resultCommon';
export * from './core/responseValidation';
export * from './core/currentPage';
export * from './core/types';
export * from './aemGetJson';
export * from './aemQuery';

/**
 * The tool registry: the one place a tool is registered.
 *
 * Adding a tool means creating one module beside `./aemGetJson.ts` and
 * `./aemQuery.ts`, then adding it to `TOOL_DEFINITIONS` and the two unions
 * below. Nothing else in `src/` needs to change: the session policy derives its
 * allowlist from `TOOL_DEFINITIONS`, the SDK adapter derives its descriptors
 * from it, and the rendering dispatch below follows the same list.
 *
 * Registration is not the whole job. Every tool must also have a deliberate
 * transcript `getDetails()` composition so its call is legible in the chat
 * pane - see `describeToolCall` in
 * `src/renderer/src/chat/toolCallDetails.ts` and AGENTS.md §5. When an agent
 * adds a tool it must ask the user what to expose there rather than fall back
 * to the generic argument dump.
 */

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: AEM_GET_JSON_TOOL_DESCRIPTOR.name,
    descriptor: AEM_GET_JSON_TOOL_DESCRIPTOR,
    allowlistEntry: AEM_GET_JSON_ALLOWLIST_ENTRY,
  },
  {
    name: AEM_QUERY_TOOL_DESCRIPTOR.name,
    descriptor: AEM_QUERY_TOOL_DESCRIPTOR,
    allowlistEntry: AEM_QUERY_ALLOWLIST_ENTRY,
  },
];

export const TOOL_DESCRIPTORS = TOOL_DEFINITIONS.map((definition) => definition.descriptor);

export const TOOL_OPERATIONS = ['aem_get_json', 'aem_query'] as const;
export type ToolOperation = (typeof TOOL_OPERATIONS)[number];

/**
 * The source-qualified allowlist entries every registered tool grants, derived
 * from the registry so the policy can never list a tool the registry does not.
 */
export const TOOL_ALLOWLIST_ENTRIES = TOOL_DEFINITIONS.map(
  (definition) => definition.allowlistEntry,
);

/**
 * The request envelope is a discriminated union keyed by `operation`, assembled
 * from each tool's own request schema. Keeping it closed - rather than an open
 * `{ operation: string; args: unknown }` - preserves the structural guarantee
 * that `args` is always the schema matching the operation it is attached to: a
 * model cannot send `aem_query`'s shape under `operation: "aem_get_json"`.
 */
export const toolRequestEnvelopeSchema = z.discriminatedUnion('operation', [
  aemGetJsonRequestSchema,
  aemQueryRequestSchema,
]);

export type ToolRequestEnvelope = z.infer<typeof toolRequestEnvelopeSchema>;

/**
 * Discriminated on `ok` first, then on `operation` within the success arm.
 * Both are literals per branch, so an object cannot satisfy more than one arm:
 * `ok: false` together with a `rows` key is rejected outright by the error
 * arm's `.strict()`, not silently accepted as "a success with zero rows".
 */
export const toolResultSchema = z.discriminatedUnion('ok', [
  z.discriminatedUnion('operation', [aemGetJsonSuccessSchema, aemQuerySuccessSchema]),
  toolErrorResultSchema,
]);

export type ToolSuccess = AemGetJsonSuccess | AemQuerySuccess;
export type ToolResult = ToolSuccess | z.infer<typeof toolErrorResultSchema>;

export function serializeToolResult(result: ToolResult): string {
  return JSON.stringify(result);
}

/**
 * `parseToolResult` returns just a validated {@link ToolResult} or just an
 * error message - exactly the shape the shared `Result` helper exists for, so
 * it is reused here rather than a second parse-outcome type.
 */
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

/**
 * Bundled base instruction appended via `HardenedToolPolicy.instructions` for a
 * real AEM session. Framed narrowly and consistently with the tools' own
 * descriptions: read-only, no invented capability.
 */
export const AEM_ASSISTANT_INSTRUCTIONS =
  'You are a read-only assistant for Adobe Experience Manager (AEM) content authors. ' +
  'Each user prompt begins with a current-page context block the application supplies: it ' +
  'names the AEM host and, when available, the JCR content path of the page currently open ' +
  "in the browser pane. Treat references such as 'this page', 'here', 'this host', and 'this " +
  "instance' as that context, and a request that names no path or server as targeting it - do " +
  'not ask the user to restate where they are. The only external capabilities available to ' +
  "you are the 'aem_get_json' tool, which reads JCR/Sling node data from the AEM instance the " +
  "user currently has open, and the 'aem_query' tool, which runs a QueryBuilder search " +
  'against that same instance. You cannot write, delete, or otherwise modify anything in AEM ' +
  "through this session. Use 'aem_get_json' when you already know the path and 'aem_query' " +
  'when you need to find nodes you cannot name. A query returns one page at a time: to see ' +
  "further results, call 'aem_query' again with a higher 'offset', and never present one page " +
  'as the complete set of matches. If the tool reports an error, read its message and ' +
  "'requiredAction' and explain them to the user rather than retrying the identical request " +
  'blindly.';

/**
 * Renders a {@link ToolResult} into the text the SDK actually hands the model.
 * The "more data exists" signal is always included in prose rather than only in
 * a field the model might not read - losing it here would recreate the
 * silent-truncation problem one layer up, in the boundary that matters most
 * because it is what the model actually sees.
 */
export function renderToolResultForModel(result: ToolResult): string {
  if (!result.ok) {
    const { error } = result;
    return (
      `AEM tool error [${error.code}]: ${error.message} ` +
      `(requestId=${error.requestId}, retryable=${String(error.retryable)}, ` +
      `requiredAction=${error.requiredAction})`
    );
  }

  return result.operation === 'aem_get_json'
    ? renderGetJsonSuccess(result)
    : renderQuerySuccess(result);
}
