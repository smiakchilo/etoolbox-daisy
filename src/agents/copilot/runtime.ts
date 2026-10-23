import { mkdirSync } from 'node:fs';

import type { ReasoningSummary, SessionConfig } from '@github/copilot-sdk';

import { buildToolAllowlistPolicy } from './toolAllowlistPolicy';
import { createHardenedSession, type HardenedToolPolicy } from './toolPolicy';
import { getCopilotAuthPresence } from './authPresence';
import {
  assertNoPlaintextCredentials,
  localSignOut,
  startWebFlowLogin,
  type LoginProcessHandle,
} from './auth';
import {
  createHardenedCopilotClient,
  getAuthStatus as getSdkAuthStatus,
  resolveDefaultRuntimePathsEnv,
  toAuthStatus,
  type CopilotClient,
} from './copilotClient';
import { meta } from './meta';
import { loadModelCatalog } from './modelCatalog';
import { resolveCliExePath } from './runtimePaths';
import { createCopilotRuntimeManager } from './runtimeManager';
import { createSdkAgentService } from './sdkAgentService';
import {
  err,
  ANSWER_SESSION_INSTRUCTIONS,
  ANSWER_TIMEOUT_MS,
  parseAnswer,
  renderAnswerPrompt,
  type AgentHost,
  type AgentRuntime,
  type AppSettings,
  type AnswerRequest,
  type AnswerResult,
  type LoginOutcome,
  type LogoutResult,
} from '../../shared';

/**
 * GitHub Copilot's {@link AgentRuntime}: the one place that turns the host's
 * neutral services (connection, toolkit, model preferences, service install)
 * into a hardened `@github/copilot-sdk` client and an SDK-backed
 * `AgentService`. Everything Copilot-specific - the runtime child process, the
 * `copilot login` web flow, COPILOT_HOME - stays behind this file.
 */

/** The answer session's reasoning summary, matching the chat session's own. */
const ANSWER_REASONING_SUMMARY: ReasoningSummary = 'concise';

/**
 * The SDK spells this union in `dist/types.d.ts` but does not re-export it from
 * the package root (same reason as `sdkAgentService.ts`'s local alias).
 */
type ReasoningEffort = NonNullable<SessionConfig['reasoningEffort']>;

/**
 * An answer session has **no tools** and no skills: the model only classifies the
 * numbered items in the prompt. `createHardenedSession` still applies every
 * hardening default, including the denied permission handler.
 */
const ANSWER_POLICY: HardenedToolPolicy = {
  availableTools: [],
  instructions: ANSWER_SESSION_INSTRUCTIONS,
};

export function createCopilotRuntime(host: AgentHost): AgentRuntime {
  let inFlightLogin: LoginProcessHandle | undefined;

  const startRuntime = async (client: CopilotClient | undefined): Promise<void> => {
    if (client === undefined) return;
    // The real adapter's `authSource`/`toolHandlers` assume a started client.
    await client.start();
    const toolkit = host.toolkit();
    await host.installService(
      createSdkAgentService({
        client,
        policy: buildToolAllowlistPolicy({
          allowlistEntries: toolkit.allowlistEntries,
          instructions: toolkit.instructions,
        }),
        // The SDK's raw `auth.getStatus` response carries no `apiVersion`;
        // `toAuthStatus` projects it onto this app's `AuthStatus` DTO.
        authSource: { getAuthStatus: async () => toAuthStatus(await client.getAuthStatus()) },
        toolHandlers: toolkit.toolHandlers,
        toolDescriptors: toolkit.toolDescriptors,
        modelPreferences: host.modelPreferences,
      }),
    );
  };

  const manager = createCopilotRuntimeManager({
    recycleOnSettingsChange: true,
    startRuntime,
    // The runtime resolves its active credential inside its own process, so a
    // still-running one reports stale auth after the account changes - and it
    // would keep using the old proxy regardless. Recycled clients are always
    // stopped; already exited is the normal case and is not an error.
    stopClient: async (client) => {
      try {
        await client.stop();
      } catch {
        // Already exited or never started - nothing to clean up.
      }
    },
    createClient: ({ proxy, githubToken }) => {
      mkdirSync(host.stateDirectory, { recursive: true });
      return createHardenedCopilotClient({
        copilotHomeDir: host.stateDirectory,
        ...(proxy !== undefined ? { proxy } : {}),
        ...(githubToken !== undefined ? { githubToken } : {}),
      });
    },
    // A rejection from either resolver (secret storage unavailable, ...)
    // aborts the recycle before the working runtime is touched.
    resolveProxyOverrides: async (settings) =>
      (await host.resolveConnection(meta.id, settings)).proxy,
    resolveGithubToken: async (settings) =>
      (await host.resolveConnection(meta.id, settings)).accessToken,
  });

  const login = async (settings: AppSettings | undefined): Promise<LoginOutcome> => {
    if (inFlightLogin !== undefined) {
      return { status: 'failed', message: 'A login is already in progress' };
    }
    const cliExePath = resolveCliExePath(resolveDefaultRuntimePathsEnv());
    const copilotHomeDir = host.stateDirectory;
    mkdirSync(copilotHomeDir, { recursive: true });
    // The sign-in child reaches GitHub through the proxy the user selected for
    // the runtime, rather than bypassing it.
    const { proxy } = await host.resolveConnection(meta.id, settings);
    const handle = startWebFlowLogin(
      cliExePath,
      proxy === undefined ? { copilotHomeDir } : { copilotHomeDir, proxy },
    );
    inFlightLogin = handle;
    try {
      const outcome = await handle.outcome;
      if (outcome.status === 'success') {
        // Fail closed even on a reported success: if the CLI ever wrote
        // plaintext token material into our COPILOT_HOME, surface that as a
        // failure rather than silently accepting it.
        await assertNoPlaintextCredentials(copilotHomeDir);
        // Recycle so a still-running runtime does not keep serving its stale
        // credential resolution; symmetric with logout.
        await manager.refresh();
      }
      return outcome;
    } finally {
      inFlightLogin = undefined;
    }
  };

  const logout = async (): Promise<LogoutResult> => {
    const result = await localSignOut(host.stateDirectory);
    await manager.refresh();
    return { apiVersion: 1, warning: result.warning };
  };

  const answer = async (
    request: AnswerRequest,
    signal: AbortSignal | undefined,
  ): Promise<AnswerResult> => {
    const aborted = (): boolean => signal?.aborted === true;
    if (aborted()) return err({ message: 'The answer call was cancelled', cancelled: true });
    await manager.whenReady();
    const client = manager.getClient();
    const preference = host.modelPreferences();
    let session: Awaited<ReturnType<typeof createHardenedSession>> | undefined;
    try {
      // A fresh, tools-disabled session: the model must not see the chat's
      // history, call a tool, or emit anything into the transcript. Same
      // provider, model and reasoning effort as the conversation.
      session = await createHardenedSession(client, ANSWER_POLICY, {
        ...(preference.model !== null ? { model: preference.model } : {}),
        ...(preference.reasoningEffort !== null
          ? {
              reasoningEffort: preference.reasoningEffort as ReasoningEffort,
              reasoningSummary: ANSWER_REASONING_SUMMARY,
            }
          : {}),
      });
      const abort = (): void => {
        void session?.abort().catch(() => undefined);
      };
      if (aborted()) abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const response = await session.sendAndWait(
          { prompt: renderAnswerPrompt(request) },
          ANSWER_TIMEOUT_MS,
        );
        if (aborted()) {
          return err({ message: 'The answer call was cancelled', cancelled: true });
        }
        const text = response?.data.content;
        if (typeof text !== 'string') return err({ message: 'The agent returned no judgment' });
        return parseAnswer(text, request.items);
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    } catch {
      return aborted()
        ? err({ message: 'The answer call was cancelled', cancelled: true })
        : err({ message: 'The agent could not answer the search candidates' });
    } finally {
      await session?.disconnect().catch(() => undefined);
    }
  };

  return {
    start: (settings) => manager.start(settings),
    reconcile: (settings) => manager.reconcile(settings),
    refresh: (settings) => manager.refresh(settings),
    stop: () => manager.stop(),
    whenReady: () => manager.whenReady(),
    getAuthStatus: async () => {
      const client = manager.getClient();
      // Idempotent: an already-started runtime answers immediately, and this
      // is what starts one lazily when sign-in is attempted before startup ran.
      await client.start();
      return toAuthStatus(await getSdkAuthStatus(client));
    },
    // Cheap and non-starting: reads our own COPILOT_HOME config pointer, never
    // the runtime. Used to gate "Set active" for an inactive Copilot.
    getAuthPresence: () => getCopilotAuthPresence(host.stateDirectory),
    login,
    cancelLogin: () => {
      inFlightLogin?.cancel();
    },
    logout,
    answer,
    loadModelCatalog: async () => {
      await manager.whenReady();
      return loadModelCatalog(manager.getClient());
    },
  };
}
