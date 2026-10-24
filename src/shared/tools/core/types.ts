import type { WebviewBridgeBlockReason } from '../../contracts/webviewBridge';
import type { JsonValue } from '../../contracts';
import type { ToolError } from '../../contracts';
import type { ChatId, ServerId, ToolCallId, TurnId } from '../../contracts';
import type { Result } from '../../result';

/**
 * The runtime seam every agent tool is registered through.
 *
 * Takes this adapter's own normalized JSON arguments and the SDK's own
 * per-call `toolCallId`/cancellation `signal`, but returns this app's own
 * `Result<JsonValue, ToolError>` rather than the SDK's untyped `unknown`. That
 * is deliberate: `sdkAgentService.ts` builds `tool.result` directly from this
 * return value, so a failure already carries this app's own `ToolError`
 * classification and a real `RequestId` - there is no lossy string round trip
 * through the SDK to reconstruct it from.
 *
 * Lives in `src/shared` - not `src/agent` - so a tool module can own its own
 * executor without importing the SDK boundary (which `src/shared` may not do).
 */
export type ToolExecutor = (
  args: Readonly<Record<string, JsonValue>>,
  context: {
    readonly toolCallId: ToolCallId;
    readonly signal: AbortSignal | undefined;
    /**
     * Set only by the application's tool-to-tool bridge (`ToolHost.invokeTool`),
     * never by an agent adapter: the call comes from another tool, not the model.
     */
    readonly nested?: true;
  },
) => Promise<Result<JsonValue, ToolError>>;

/**
 * Everything about "where a request goes" that the model must never choose,
 * read fresh on every call via the application's `currentContext` provider.
 *
 * The model's tool arguments are the only per-call input an executor accepts
 * from the SDK; none of the fields below are reachable from them, and no
 * executor has a parameter that could carry an origin from tool arguments even
 * if a caller tried to supply one.
 */
export interface CurrentToolContext {
  readonly origin: string;
  readonly serverId: ServerId;
  readonly serverRevision: number;
  readonly navigationEpoch: number;
  readonly chatId: ChatId;
  readonly turnId: TurnId;
}

/**
 * The verdict of one bridge round trip, before any HTTP or JSON interpretation.
 *
 * Moved here from the main-process broker so a tool module can describe the
 * `fetchThroughBridge` seam it depends on without importing `src/main`.
 */
export type BrokerOutcome =
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly contentType: string | null;
      readonly bodyText: string;
    }
  | { readonly kind: 'blocked'; readonly reason: WebviewBridgeBlockReason }
  | { readonly kind: 'network_error'; readonly message: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'stale'; readonly status: 'stale_server_revision' | 'stale_navigation_epoch' }
  | { readonly kind: 'no_view' }
  /**
   * The browser view is live but its preload never announced it could answer
   * fetches (`WEBVIEW_BRIDGE_READY_CHANNEL`), so no request could be delivered.
   * Distinct from `no_view` - the pane is present; its bridge script is
   * missing or broken. This is an application build/packaging fault, never an
   * AEM one, and must not be reported as a timeout.
   */
  | { readonly kind: 'bridge_unavailable' };

/**
 * What a tool may vary about one bridge fetch. Everything else (credentials,
 * redirect handling, caching) is fixed by the preload. Only the two
 * non-mutating methods exist; the bridge has no write path.
 */
export interface BridgeRequestOptions {
  readonly method?: 'GET' | 'HEAD';
  /** Replaces the default JSON `Accept`, e.g. for an HTML page. */
  readonly accept?: string;
}

/**
 * A tool's model-facing registration data. `parameters` is derived from the
 * same schema that validates the call (`z.toJSONSchema`), so the two cannot
 * drift the way a hand-written JSON Schema copy eventually would.
 */
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  /**
   * The JSON Schema `z.toJSONSchema` produces. Left as `unknown` rather than
   * named against zod's internal `ZodStandardJSONSchemaPayload<T>` type:
   * `toJSONSchema` is overloaded, so `ReturnType<typeof z.toJSONSchema>`
   * resolves to whichever overload TypeScript picks last, not the one actually
   * called.
   */
  readonly parameters: unknown;
}
