import { ipcMain } from 'electron';
import {
  AGENT_CANCEL_LOGIN_CHANNEL,
  AGENT_GET_AUTH_STATUS_CHANNEL,
  AGENT_LOGIN_CHANNEL,
  AGENT_LOGOUT_CHANNEL,
  type AuthStatus,
  type LoginOutcome,
  type LogoutResult,
} from '../../shared';
import {
  assertNoPlaintextCredentials,
  getAuthStatus as getSdkAuthStatus,
  getCopilotHomeDir,
  localSignOut,
  resolveCliExePath,
  resolveDefaultRuntimePathsEnv,
  startWebFlowLogin,
  type CopilotClient,
  type LoginProcessHandle,
  type ProxyEnvOverrides,
} from '../../agent';

/**
 * The Copilot sign-in/out IPC handlers: auth status, login, cancel-login,
 * logout. Backs the Agents section of the Settings panel
 * (`src/renderer/src/settings/agentsSection.ts`).
 *
 * The Copilot client is no longer cached here. `ipc/agent.ts` used to keep
 * its own `cachedClient`, separate from the composition root's - which meant
 * opening Settings could spawn a second `copilot-runtime.exe`, and which made
 * it impossible for a proxy chosen in Settings to reach the runtime at all.
 * Both callers now share the one client owned by
 * `src/main/copilotRuntimeManager.ts`; this module only drives it.
 */

export interface AgentAuthDependencies {
  /**
   * The shared Copilot client. May be `undefined` in the brief window before
   * the composition root has installed the runtime manager - `getAuthStatus`
   * answers honestly rather than throwing in that window.
   */
  readonly getClient: () => CopilotClient | undefined;
  /**
   * Recycles the runtime after the active credential changes. The runtime
   * resolves the active credential inside its own process and keeps serving
   * that resolution, so a still-running one reports stale auth after the
   * account pointer changes. Observed for real in an installed build: after
   * `logout()` the app still reported `isAuthenticated: true` with
   * `authType: "user"`, because only `config.json` had been deleted while the
   * already-started runtime kept answering from memory. Recycling the process
   * is what makes sign-out predictable - and is done on successful login too,
   * so both directions are symmetric rather than relying on the runtime
   * happening to notice a new credential.
   */
  readonly refreshRuntime: () => Promise<void>;
  /**
   * The active provider's proxy environment, resolved fresh - so the sign-in
   * child process reaches GitHub through the proxy the user selected for the
   * runtime, rather than bypassing it (see the agents surface's "apply to
   * runtime" decision). `undefined` means a direct connection.
   */
  readonly getProxyOverrides: () => Promise<ProxyEnvOverrides | undefined>;
  /**
   * The deterministic fake agent service's sign-in status, when that fake is
   * selected; `undefined` on the real path.
   *
   * In fake mode the fake is the authority on "signed in": it already answers
   * `agentChat.getStatus().authenticated`, and the settings surface must not
   * disagree with it. Reading the real runtime here instead would both report
   * the opposite (nobody is signed in to the scratch profile) and start a
   * `copilot-runtime.exe` that fake mode never uses for chat.
   */
  readonly getFakeAuthStatus?: () => AuthStatus | undefined;
}

let inFlightLogin: LoginProcessHandle | undefined;

export function registerAgentAuthHandlers(deps: AgentAuthDependencies): void {
  ipcMain.handle(AGENT_GET_AUTH_STATUS_CHANNEL, async (): Promise<AuthStatus> => {
    const fakeStatus = deps.getFakeAuthStatus?.();
    if (fakeStatus !== undefined) return fakeStatus;
    const client = deps.getClient();
    if (client === undefined) {
      return {
        apiVersion: 1,
        isAuthenticated: false,
        statusMessage: 'Copilot is still starting.',
      };
    }
    // Idempotent: an already-started runtime answers immediately, and this is
    // what starts one lazily when sign-in is attempted before the chat
    // runtime's own background startup has run.
    await client.start();
    const status = await getSdkAuthStatus(client);
    return {
      apiVersion: 1,
      isAuthenticated: status.isAuthenticated,
      authType: status.authType,
      host: status.host,
      login: status.login,
      statusMessage: status.statusMessage,
    };
  });

  ipcMain.handle(AGENT_LOGIN_CHANNEL, async (): Promise<LoginOutcome> => {
    if (inFlightLogin) {
      return { status: 'failed', message: 'A login is already in progress.' };
    }
    const cliExePath = resolveCliExePath(resolveDefaultRuntimePathsEnv());
    const copilotHomeDir = getCopilotHomeDir();
    const proxy = await deps.getProxyOverrides();
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
        await deps.refreshRuntime();
      }
      return outcome;
    } finally {
      inFlightLogin = undefined;
    }
  });

  ipcMain.handle(AGENT_CANCEL_LOGIN_CHANNEL, (): void => {
    inFlightLogin?.cancel();
  });

  ipcMain.handle(AGENT_LOGOUT_CHANNEL, async (): Promise<LogoutResult> => {
    const result = await localSignOut(getCopilotHomeDir());
    await deps.refreshRuntime();
    return { apiVersion: 1, warning: result.warning };
  });
}
