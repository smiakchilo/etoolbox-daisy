import type { ToolExecutor } from '../../shared';

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
  readonly executor: ToolExecutor;
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
  /**
   * Aggregate token/cost usage across **every** model call the run made (the
   * SDK's `SessionUsageTotals`), unlike `getResponse()`, which is only the last
   * round. Never rejects - a failed run still reports what it spent.
   */
  getUsage(): Promise<unknown>;
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
  /**
   * Whether the run may end with an assistant text response. The chat sets this
   * to `false` when a tool result already ended the turn (`TURN_COMPLETE_RESULT_KEY`),
   * so the SDK does not spend one more model call; a one-shot answer call leaves
   * it `true` because the text *is* its answer.
   */
  readonly allowFinalResponse?: boolean;
  /**
   * Whether the run should stop after the step it is on, read by the client's
   * stop condition. The service sets it when a tool result carries the
   * turn-complete marker (`TURN_COMPLETE_RESULT_KEY`), so the SDK ends the run
   * without making the final "search is finished" model call. Omitted means no
   * early stop beyond the step cap.
   */
  readonly shouldStopTurn?: () => boolean;
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
