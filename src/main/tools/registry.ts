/// <reference types="vite/client" />
import {
  type AemToolExecutor,
  type JsonValue,
  type Result,
  type ToolCallId,
  type ToolDescriptor,
  type ToolError,
  type ToolExecutionContext,
  type ToolHost,
  type ToolHostServices,
  type ToolModule,
  composeAssistantInstructions,
  createToolError,
  err,
  newRequestId,
  newToolCallId,
} from '../../shared';

/**
 * The one place that knows how tools are discovered. Every folder
 * `src/tools/<name>/` that contains a `tool.ts` exporting a `ToolModule`
 * named `tool` is a tool; nothing else in the application names one.
 *
 * Loading is lazy and per-tool on purpose: a tool whose module throws while
 * loading, whose manifest is malformed, or whose `createExecutor` throws is
 * reported through `onFailure` and left out. The application starts without
 * it. (A *type* error is different: it fails `tsc`/the build for everyone,
 * `disabled` or not; only deleting the folder avoids that.)
 */

export type ToolModuleLoaders = Readonly<Record<string, () => Promise<unknown>>>;

export interface ToolLoadFailure {
  /** The manifest path (or a synthetic one in tests) that failed. */
  readonly source: string;
  readonly reason: string;
}

export interface ToolRegistry {
  /** The model-callable tools' executors, keyed by tool name (no `internal` tool). */
  readonly toolHandlers: Readonly<Record<string, AemToolExecutor>>;
  readonly descriptors: readonly ToolDescriptor[];
  readonly allowlistEntries: readonly string[];
  /** The composed session instructions for exactly the model-callable tools. */
  readonly instructions: string;
  /** The model-callable tools. */
  readonly enabledNames: readonly string[];
  /** Enabled `internal` tools: reachable only through another tool's `invokeTool`. */
  readonly internalNames: readonly string[];
  readonly disabledNames: readonly string[];
  readonly failures: readonly ToolLoadFailure[];
}

export function discoverToolLoaders(): ToolModuleLoaders {
  return import.meta.glob('../../tools/*/tool.ts');
}

/** One tool call a tool made through `ToolHost.invokeTool`, as reported to the observer. */
export interface NestedToolCall {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly args: Readonly<Record<string, JsonValue>>;
}

/**
 * Hears about every nested tool call so the application can show it in the
 * transcript and the chat journal exactly like a call the model made. It is
 * told only about calls that actually run - a refused call (undeclared target,
 * self-call, depth) is returned to the caller and never surfaces.
 */
export interface NestedToolCallObserver {
  onCallStarted(call: NestedToolCall): void;
  onCallSettled(call: NestedToolCall, outcome: Result<JsonValue, ToolError>): void;
}

/**
 * The deepest a chain of `invokeTool` calls may go (a model-made call is depth
 * 0). A bound, not a design target: a composite of composites is already rare.
 */
export const MAX_NESTED_TOOL_DEPTH = 3;

function isToolModule(value: unknown): value is ToolModule {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const name = v['name'];
  if (typeof name !== 'string') return false;
  if (typeof v['createExecutor'] !== 'function') return false;
  if (v['disabled'] !== undefined && typeof v['disabled'] !== 'boolean') return false;
  if (v['internal'] !== undefined && typeof v['internal'] !== 'boolean') return false;
  const uses = v['uses'];
  if (
    uses !== undefined &&
    !(Array.isArray(uses) && uses.every((entry) => typeof entry === 'string'))
  ) {
    return false;
  }
  // An `internal` tool is a building block the model never sees, so it needs
  // no descriptor, allowlist entry or instructions.
  if (v['internal'] === true) return true;
  // A model-callable tool must describe itself and carry its allowlist entry.
  const descriptor = v['descriptor'] as { name?: unknown } | undefined;
  return (
    typeof descriptor === 'object' &&
    descriptor !== null &&
    descriptor.name === name &&
    v['allowlistEntry'] === `custom:${name}` &&
    typeof v['instructions'] === 'string'
  );
}

function describe(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Builds the per-tool `invokeTool` - the tool-to-tool bridge. Handlers are read
 * from `handlers` at call time, not at construction, so a tool may call one
 * registered after it (registration order is alphabetical, not dependency
 * order).
 */
function createInvokeTool(params: {
  readonly callerName: string;
  readonly uses: ReadonlySet<string>;
  readonly handlers: Readonly<Record<string, AemToolExecutor>>;
  readonly depths: Map<string, number>;
  readonly host: ToolHostServices;
  readonly observer: NestedToolCallObserver | undefined;
}): ToolHost['invokeTool'] {
  const { callerName, uses, handlers, depths, host, observer } = params;
  const refuse = (
    code: 'ACCESS_DENIED' | 'NOT_FOUND',
    message: string,
  ): Promise<Result<JsonValue, ToolError>> =>
    Promise.resolve(err(createToolError(code, message, newRequestId(host.idGenerator))));

  return async (name, args, parent: ToolExecutionContext) => {
    if (name === callerName) {
      return refuse('ACCESS_DENIED', `Tool '${callerName}' may not call itself`);
    }
    if (!uses.has(name)) {
      return refuse(
        'ACCESS_DENIED',
        `Tool '${callerName}' did not declare '${name}' in its 'uses' list`,
      );
    }
    const target = handlers[name];
    if (target === undefined) {
      return refuse('NOT_FOUND', `Tool '${name}' is not available (missing or disabled)`);
    }
    const depth = (depths.get(parent.toolCallId) ?? 0) + 1;
    if (depth > MAX_NESTED_TOOL_DEPTH) {
      return refuse(
        'ACCESS_DENIED',
        `Nested tool calls may go at most ${String(MAX_NESTED_TOOL_DEPTH)} levels deep`,
      );
    }

    const call: NestedToolCall = {
      toolCallId: newToolCallId(host.idGenerator),
      toolName: name,
      args,
    };
    depths.set(call.toolCallId, depth);
    observer?.onCallStarted(call);
    let outcome: Result<JsonValue, ToolError>;
    try {
      outcome = await target(args, { toolCallId: call.toolCallId, signal: parent.signal });
    } catch (caught) {
      // An executor is supposed to resolve `err(...)`, never throw; a thrown
      // one is still reported as a structured failure so the caller can react.
      outcome = err(
        createToolError(
          'UNEXPECTED_RESPONSE',
          `Tool '${name}' failed: ${describe(caught)}`.slice(0, 500),
          newRequestId(host.idGenerator),
        ),
      );
    } finally {
      depths.delete(call.toolCallId);
    }
    observer?.onCallSettled(call, outcome);
    return outcome;
  };
}

export async function buildToolRegistry(params: {
  readonly loaders: ToolModuleLoaders;
  readonly host: ToolHostServices;
  readonly onFailure?: (failure: ToolLoadFailure) => void;
  /** Told about every call a tool makes through `invokeTool`; see {@link NestedToolCallObserver}. */
  readonly nestedCalls?: NestedToolCallObserver;
}): Promise<ToolRegistry> {
  const failures: ToolLoadFailure[] = [];
  const fail = (source: string, reason: string): void => {
    const failure = { source, reason };
    failures.push(failure);
    params.onFailure?.(failure);
  };

  // Every enabled tool, internal ones included: the `invokeTool` lookup table.
  const handlers: Record<string, AemToolExecutor> = {};
  // Only what the model may call: handed to the agent.
  const modelHandlers: Record<string, AemToolExecutor> = {};
  const internalNames: string[] = [];
  const descriptors: ToolDescriptor[] = [];
  const allowlistEntries: string[] = [];
  const instructions: string[] = [];
  const disabledNames: string[] = [];
  // Nesting depth of each in-flight nested call, keyed by its tool-call id.
  const depths = new Map<string, number>();
  const usesByTool = new Map<string, readonly string[]>();

  // Sorted so the instruction text and allowlist are deterministic.
  for (const source of Object.keys(params.loaders).sort()) {
    const loader = params.loaders[source];
    if (loader === undefined) continue;
    let mod: unknown;
    try {
      mod = await loader();
    } catch (caught) {
      fail(source, `Failed to load: ${describe(caught)}`);
      continue;
    }
    const tool = (mod as { tool?: unknown } | null)?.tool;
    if (!isToolModule(tool)) {
      fail(source, 'Does not export a valid `tool` (ToolModule)');
      continue;
    }
    if (tool.disabled === true) {
      disabledNames.push(tool.name);
      continue;
    }
    if (handlers[tool.name] !== undefined) {
      fail(source, `Duplicate tool name '${tool.name}'`);
      continue;
    }
    let executor: AemToolExecutor;
    try {
      const uses = tool.uses ?? [];
      const host: ToolHost = {
        ...params.host,
        invokeTool: createInvokeTool({
          callerName: tool.name,
          uses: new Set(uses),
          handlers,
          depths,
          host: params.host,
          observer: params.nestedCalls,
        }),
      };
      executor = tool.createExecutor(host);
      handlers[tool.name] = executor;
      usesByTool.set(tool.name, uses);
    } catch (caught) {
      fail(source, `createExecutor threw: ${describe(caught)}`);
      continue;
    }
    if (tool.internal === true) {
      internalNames.push(tool.name);
      continue;
    }
    modelHandlers[tool.name] = executor;
    descriptors.push(tool.descriptor);
    allowlistEntries.push(tool.allowlistEntry);
    instructions.push(tool.instructions);
  }

  // A composite tool whose part is missing still registers - its own call
  // answers `NOT_FOUND` for the part - but the gap is reported here, once, so
  // it is visible at startup rather than only when the tool first runs.
  for (const [name, uses] of usesByTool) {
    for (const used of uses) {
      if (handlers[used] === undefined) {
        fail(`tool:${name}`, `Declared dependency '${used}' is not an enabled tool`);
      }
    }
  }

  return {
    toolHandlers: modelHandlers,
    descriptors,
    allowlistEntries,
    instructions: composeAssistantInstructions(instructions),
    enabledNames: Object.keys(modelHandlers),
    internalNames,
    disabledNames,
    failures,
  };
}
