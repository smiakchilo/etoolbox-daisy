import type { JsonValue } from '../../src/shared/contracts/agentEvents';

/**
 * The fake "agent" (implementation-plan.md step 03 success criterion:
 * contracts "successfully used by the fake agent/transport").
 *
 * A model only ever produces a tool name plus a JSON arguments object - see
 * the SDK tool-call shape normalized by `toolCallRequestedEventSchema` in
 * `agentEvents.ts` (`toolName` + `arguments: Record<string, JsonValue>`).
 * `FakeAgentToolCall` mirrors exactly that pair and nothing else: it has no
 * `serverId`, `origin`, `proxy`, `headers`, HTTP method, or timeout field,
 * so a caller cannot supply one - not because a validator strips it later,
 * but because the type has no place to put it. `operation` is a plain
 * `string`, not the `ToolOperation` literal union, specifically so an
 * "unknown operation" call (a real model can invoke a tool name that does
 * not exist) is constructible; `args` is a JSON-safe record so hostile
 * *values* (wrong types, extra keys, traversal strings, reserved predicate
 * keys, ...) can be expressed, while still ruling out non-JSON payloads a
 * real SDK boundary could never carry either.
 */
export interface FakeAgentToolCall {
  readonly operation: string;
  readonly args: Record<string, JsonValue>;
}

/** Emits a well- or ill-formed `aem_get_json` call, exactly as a model would. */
export function aemGetJsonCall(args: Record<string, JsonValue>): FakeAgentToolCall {
  return { operation: 'aem_get_json', args };
}

/** Emits a well- or ill-formed `aem_query` call, exactly as a model would. */
export function aemQueryCall(args: Record<string, JsonValue>): FakeAgentToolCall {
  return { operation: 'aem_query', args };
}

/** Emits a call against a tool name the application never registered. */
export function unknownOperationCall(
  operation: string,
  args: Record<string, JsonValue> = {},
): FakeAgentToolCall {
  return { operation, args };
}
