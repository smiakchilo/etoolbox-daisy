import type { AemToolExecutor } from '../../shared';

/**
 * Folder-local contracts for the OpenRouter agent.
 *
 * Deliberately free of SDK imports so the event-mapping service
 * (`agentService.ts`) and its unit tests never load `@openrouter/agent`: the
 * SDK is confined to `client.ts`, `toolMapping.ts` and `modelCatalog.ts`, and
 * reaches the service only through these structural interfaces.
 */

/** One tool the model may call, mapped from the host toolkit (plus the skill tool). */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /**
   * The tool's model-facing JSON Schema parameters (the host's
   * `ToolDescriptor.parameters`, or a hand-written schema for the skill tool).
   */
  readonly parameters: unknown;
  readonly executor: AemToolExecutor;
}

/** Per-call context the SDK supplies to a tool's `execute`. */
export interface ToolCallContext {
  /** The SDK's own call id, when present. Parsed into this app's brand by the service. */
  readonly callId?: string;
  /** Aborts when the run is cancelled or the tool's deadline elapses. */
  readonly signal?: AbortSignal;
}

/**
 * Runs one tool call on behalf of the SDK: emits the normalized
 * `tool.call.requested`/`approved`/`result` events and returns the value the
 * model should see. Implemented by `agentService.ts`; injected into
 * `toolMapping.ts` so the mapping module never touches the event stream.
 */
export type RunTool = (spec: ToolSpec, args: unknown, context: ToolCallContext) => Promise<unknown>;

/** The consumable surface of one `callModel` result. */
export interface OpenRouterCall {
  getTextStream(): AsyncIterableIterator<string>;
  getReasoningStream(): AsyncIterableIterator<string>;
  /** Drives the run to completion; rejects on failure or abort. */
  getResponse(): Promise<unknown>;
}

/** Everything the service needs to start one model run. `tools`/`state` are opaque. */
export interface OpenRouterCallRequest {
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly instructions: string;
  readonly input: string;
  readonly tools: readonly unknown[];
  readonly state: unknown;
  readonly signal: AbortSignal;
}

/** The seam the service depends on; the real implementation wraps the SDK clients. */
export interface OpenRouterClient {
  /** False when no API key is configured; sending is refused. */
  readonly hasApiKey: boolean;
  /** A fresh in-memory conversation state handle for one open conversation. */
  createConversationState(): unknown;
  callModel(request: OpenRouterCallRequest): OpenRouterCall;
  /** The raw `models.list()` pages' models, projected by `modelCatalog.ts`. */
  listModels(): Promise<unknown>;
}
