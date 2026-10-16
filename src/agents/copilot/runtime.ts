import { mkdirSync } from 'node:fs';

import { buildAemToolPolicy } from './aemToolPolicy';
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
import type {
  AgentHost,
  AgentRuntime,
  AppSettings,
  LoginOutcome,
  LogoutResult,
} from '../../shared';

/**
 * GitHub Copilot's {@link AgentRuntime}: the one place that turns the host's
 * neutral services (connection, toolkit, model preferences, service install)
 * into a hardened `@github/copilot-sdk` client and an SDK-backed
 * `AgentService`. Everything Copilot-specific - the runtime child process, the
 * `copilot login` web flow, COPILOT_HOME - stays behind this file.
 */
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
        policy: buildAemToolPolicy({
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
    loadModelCatalog: async () => {
      await manager.whenReady();
      return loadModelCatalog(manager.getClient());
    },
  };
}
