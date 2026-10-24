import { randomUUID } from 'node:crypto';

import {
  type AgentHost,
  type AgentRuntime,
  type AppSettings,
  type AuthPresence,
  type AuthStatus,
  type ModelCatalogResult,
  type OneShotCall,
  err,
  ok,
} from '../../shared';
import { AUTO_MODEL, createOpenRouterAgentService } from './agentService';
import { authPresenceFromToken, authStatusFromToken } from './auth';
import { createOpenRouterClient } from './client';
import { meta } from './meta';
import { loadOpenRouterModelCatalog } from './modelCatalog';
import { buildOpenRouterTools } from './toolMapping';
import type { OpenRouterCall, OpenRouterClient, ToolSpec } from './types';
import { mapOpenRouterUsage, readUsageTotals } from './usageDiagnostics';

/**
 * OpenRouter's {@link AgentRuntime}: turns the host's neutral services
 * (connection, proxy fetcher, toolkit, model preferences, service install) into
 * an SDK-backed `AgentService`. Everything OpenRouter-specific - the API key,
 * the model catalogue, the skill tool - stays behind this file.
 *
 * Unlike Copilot there is no child process to start or stop; the client is a
 * stateless HTTP wrapper, so "recycling" just rebuilds it with a fresh key /
 * proxy and reinstalls the service. The install is serialized and gated on a
 * cheap descriptor exactly as Copilot's manager is, so a proxy change recycles
 * and a model change does not.
 */

const NO_RUNTIME_DESCRIPTOR = '<none>';

/**
 * A cheap, synchronous fingerprint of the settings that shape the runtime - the
 * selected proxy id and whether a key reference exists - so a model-only change
 * does not recycle. Derived from the settings node (not the resolved secret),
 * so `reconcile` and `install` can compute the identical value.
 */
function settingsDescriptor(settings: AppSettings | undefined, hasKey: boolean): string {
  const node = settings?.agents[meta.id];
  return `${node?.proxy ?? ''}|${node?.token !== undefined ? 'ref' : 'none'}|${hasKey ? 'key' : 'none'}`;
}

export function createOpenRouterRuntime(host: AgentHost): AgentRuntime {
  let client: OpenRouterClient | undefined;
  let token: string | undefined;
  let descriptor = NO_RUNTIME_DESCRIPTOR;
  let currentSettings: AppSettings | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  function buildSpecs(): ToolSpec[] {
    const toolkit = host.toolkit();
    const specs: ToolSpec[] = [];
    for (const descriptorOrSpec of toolkit.toolDescriptors) {
      const executor = toolkit.toolHandlers[descriptorOrSpec.name];
      if (executor === undefined) continue;
      specs.push({
        name: descriptorOrSpec.name,
        description: descriptorOrSpec.description,
        parameters: descriptorOrSpec.parameters,
        executor,
      });
    }
    return specs;
  }

  function install(settings: AppSettings | undefined): Promise<void> {
    // Serialized like Copilot's manager: a login/token recycle and a settings
    // recycle must not interleave two installs. A failed install rejects this
    // caller but leaves the chain usable.
    const run = inFlight.then(async () => {
      const connection = await host.resolveConnection(meta.id, settings);
      const nextToken = connection.accessToken;
      const nextClient = createOpenRouterClient({
        apiKey: nextToken,
        fetch: host.createProxyFetch(connection),
      });
      const specs = buildSpecs();
      await host.installService(
        createOpenRouterAgentService({
          client: nextClient,
          authStatus: authStatusFromToken(nextToken),
          instructions: host.toolkit().instructions,
          buildTools: (runTool) => buildOpenRouterTools(specs, runTool),
          modelPreferences: host.modelPreferences,
          idGenerator: randomUUID,
        }),
      );
      client = nextClient;
      token = nextToken;
      descriptor = settingsDescriptor(settings, nextToken !== undefined && nextToken !== '');
      currentSettings = settings;
    });
    inFlight = run.catch(() => undefined);
    return run;
  }

  /**
   * The secondary-turn routine (`AgentRuntime.complete`, see
   * `src/shared/agents/oneShot.ts`): one prompt on a fresh conversation state.
   * It knows nothing of the tool asking - the prompt and the reply's meaning are
   * the caller's - only how to run the call and to report its usage.
   */
  const complete: OneShotCall = async (request, signal, reportUsage) => {
    const aborted = (): boolean => signal?.aborted === true;
    if (aborted()) {
      return err({ message: 'The call was cancelled', cancelled: true });
    }
    await inFlight;
    if (client === undefined || !client.hasApiKey) {
      return err({ message: 'OpenRouter is not available' });
    }
    const preference = host.modelPreferences();
    // A fresh state, no tools, and a final answer allowed (the text is the
    // reply, unlike the chat's 'turn-complete' stop).
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (aborted()) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const startedAt = Date.now();
    let call: OpenRouterCall | undefined;
    try {
      call = client.callModel({
        model: preference.model ?? AUTO_MODEL,
        reasoningEffort: preference.reasoningEffort,
        instructions: request.instructions,
        input: request.prompt,
        tools: [],
        state: client.createConversationState(),
        signal: controller.signal,
        allowFinalResponse: true,
      });
      let text = '';
      const collected = (async () => {
        for await (const delta of call.getTextStream()) text += delta;
      })();
      await Promise.all([Promise.resolve().then(() => call?.getResponse()), collected]);
      if (controller.signal.aborted) {
        return err({ message: 'The call was cancelled', cancelled: true });
      }
      return ok(text);
    } catch {
      return controller.signal.aborted
        ? err({ message: 'The call was cancelled', cancelled: true })
        : err({ message: 'The agent could not complete the request' });
    } finally {
      signal?.removeEventListener('abort', abort);
      // The call is no chat turn, but it spends the chat's tokens: whatever it
      // used - failed or cancelled included - is reported.
      if (call !== undefined) {
        const totals = await readUsageTotals(call);
        const usage = mapOpenRouterUsage(undefined, totals, {
          durationMs: Date.now() - startedAt,
          reasoningEffort: preference.reasoningEffort,
        });
        if (usage !== undefined) reportUsage(usage);
      }
    }
  };
  return {
    start: (settings) => install(settings),

    reconcile: (settings) => {
      const nextDescriptor = settingsDescriptor(settings, token !== undefined && token !== '');
      if (nextDescriptor === descriptor) return Promise.resolve();
      return install(settings);
    },

    refresh: (settings) => install(settings ?? currentSettings),

    stop: () => {
      client = undefined;
      token = undefined;
      descriptor = NO_RUNTIME_DESCRIPTOR;
      currentSettings = undefined;
      return Promise.resolve();
    },

    whenReady: () => inFlight,

    // Both auth projections read `token`, which is assigned only at the end of
    // `install`. Awaiting the install chain first (exactly as
    // `loadModelCatalog` does) keeps an auth read that races startup from
    // answering a false "signed out": the Agents tab gates its Model/Effort
    // pickers on the live status, so a false signed-out disabled them until
    // the user touched another control and forced a second read. `inFlight`
    // never rejects, and awaiting it starts nothing - unlike Copilot's
    // `getAuthStatus`, which must start a child process, this only waits out an
    // install the runtime is already performing.
    getAuthStatus: async (): Promise<AuthStatus> => {
      await inFlight;
      return authStatusFromToken(token);
    },

    getAuthPresence: async (): Promise<AuthPresence> => {
      await inFlight;
      return authPresenceFromToken(token);
    },

    complete,

    loadModelCatalog: async (): Promise<ModelCatalogResult> => {
      await inFlight;
      if (client === undefined) {
        return { ok: false, error: { message: 'OpenRouter is not available' } };
      }
      return loadOpenRouterModelCatalog(client);
    },
  };
}
