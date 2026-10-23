import {
  type ConversationState,
  type StateAccessor,
  type StopCondition,
  OpenRouter as AgentClient,
} from '@openrouter/agent';
import { stepCountIs } from '@openrouter/agent/stop-conditions';
import type { Tool } from '@openrouter/agent/tool-types';
import { HTTPClient, OpenRouter as PlatformClient } from '@openrouter/sdk';
import type { ReasoningEffort } from '@openrouter/sdk/models';

import type { AgentFetch } from '../../shared';
import type { OpenRouterCall, OpenRouterCallRequest, OpenRouterClient } from './types';

/**
 * The only place the OpenRouter SDK is constructed. Wraps the two clients the
 * SKILL's split describes - `@openrouter/agent`'s `OpenRouter` for `callModel`
 * and `@openrouter/sdk`'s `OpenRouter` for `models.list()` - behind this
 * agent's own {@link OpenRouterClient}, so the event-mapping service and its
 * unit tests never import the SDK.
 *
 * `serverURL` is pinned explicitly rather than left to a default: it keeps the
 * endpoint a constant of this build, independent of any ambient
 * `OPENROUTER_*` environment variable a developer or CI machine might carry.
 *
 * A selected proxy is applied by the `fetch` the host supplies
 * (`AgentHost.createProxyFetch`), not by anything in this folder: an
 * `HTTPClient` constructed with that fetcher routes every request through the
 * agent's proxy, and the host returns the global `fetch` unchanged when no
 * proxy is set.
 */

/** OpenRouter's production Responses/Models base, pinned (see the module doc). */
const OPENROUTER_SERVER_URL = 'https://openrouter.ai/api/v1';

/**
 * Bounds the tool-execution loop. A runaway model that keeps calling tools
 * must not bill the user indefinitely; twenty steps is generous for the
 * read-only AEM workflow while still terminating.
 */
const MAX_TOOL_STEPS = 20;

/** Per-request timeout for one model call, in milliseconds. */
const REQUEST_TIMEOUT_MS = 120_000;

export interface OpenRouterClientOptions {
  readonly apiKey: string | undefined;
  /**
   * The proxy-aware `fetch` the host built from this agent's resolved
   * connection (`AgentHost.createProxyFetch`). Omitted only in tests, where
   * the SDK's own default fetcher is used instead.
   */
  readonly fetch?: AgentFetch;
}

export function createOpenRouterClient(options: OpenRouterClientOptions): OpenRouterClient {
  const apiKey = options.apiKey;
  const httpClient =
    options.fetch === undefined ? undefined : new HTTPClient({ fetcher: options.fetch });

  const common = {
    ...(apiKey !== undefined ? { apiKey } : {}),
    serverURL: OPENROUTER_SERVER_URL,
    timeoutMs: REQUEST_TIMEOUT_MS,
    ...(httpClient !== undefined ? { httpClient } : {}),
  };

  const agent = new AgentClient(common);
  const platform = new PlatformClient(common);

  return {
    // The API key is the whole of OpenRouter's authentication: without one
    // there is nothing to send with. The store may hand back an empty string
    // for an unset secret - treat that as absent.
    hasApiKey: apiKey !== undefined && apiKey !== '',

    createConversationState(): unknown {
      // The SDK's `state` option is a `StateAccessor` - a `{ load, save }` pair
      // over some storage - NOT a `ConversationState` value. Handing it a bare
      // `createInitialState()` value made every turn fail immediately with
      // `this.stateAccessor.load is not a function`, before any HTTP request
      // was sent. A fresh in-memory holder per open conversation is the SDK's
      // own documented example and is what carries history between this
      // conversation's turns.
      let stored: ConversationState | null = null;
      return {
        load: () => Promise.resolve(stored),
        save: (state) => {
          stored = state;
          return Promise.resolve();
        },
      } satisfies StateAccessor;
    },

    callModel(request: OpenRouterCallRequest): OpenRouterCall {
      // Always cap the loop; additionally stop the moment a tool result says the
      // turn is over (the search composites), so the SDK does not make the final
      // "search is finished" call. `allowFinalResponse: false` is what makes that
      // stop an actual end rather than one more `toolChoice: 'none'` model turn
      // (`node_modules/@openrouter/agent/esm/inner-loop/call-model.d.ts`).
      const shouldStopTurn = request.shouldStopTurn;
      const stopWhen: StopCondition[] = [stepCountIs(MAX_TOOL_STEPS)];
      if (shouldStopTurn !== undefined) {
        stopWhen.push(() => shouldStopTurn());
      }
      return agent.callModel({
        model: request.model,
        instructions: request.instructions,
        input: request.input,
        tools: request.tools as readonly Tool[],
        state: request.state as StateAccessor,
        signal: request.signal,
        stopWhen,
        allowFinalResponse: request.allowFinalResponse ?? false,
        ...(request.reasoningEffort !== null
          ? {
              reasoning: { effort: request.reasoningEffort as ReasoningEffort },
            }
          : {}),
      });
    },

    async listModels(): Promise<unknown> {
      // `list()` pages; collect every page's models into one flat array so the
      // projection has a single, stable input shape.
      const models: unknown[] = [];
      for await (const page of await platform.models.list()) {
        const data = (page as { result?: { data?: unknown } }).result?.data;
        if (Array.isArray(data)) {
          for (const model of data as readonly unknown[]) models.push(model);
        }
      }
      return models;
    },
  };
}
