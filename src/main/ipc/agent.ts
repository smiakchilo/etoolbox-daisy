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
  createHardenedCopilotClient,
  getAuthStatus as getSdkAuthStatus,
  getCopilotHomeDir,
  localSignOut,
  resolveCliExePath,
  resolveDefaultRuntimePathsEnv,
  startWebFlowLogin,
  type CopilotClient,
  type LoginProcessHandle,
} from '../../agent';

/**
 * The Copilot sign-in/out IPC handlers: auth status, login, cancel-login,
 * logout. Backs the Settings panel's authentication section
 * (`src/renderer/src/settings/authenticationSection.ts`).
 * `src/main/agentChatController.ts` (and, transitively,
 * `src/main/ipc/agentChat.ts`) also imports `../../agent` now, so this is no
 * longer the only place in `src/main` that does; no ESLint rule ever
 * enforced that claim (only `@github/copilot-sdk`/`@github/copilot` are
 * import-restricted, and only outside `src/agent/**` - see
 * `eslint.config.mjs`), so nothing but this comment needed to change.
 */

let cachedClient: CopilotClient | undefined;
let inFlightLogin: LoginProcessHandle | undefined;

function getClient(): CopilotClient {
  cachedClient ??= createHardenedCopilotClient();
  return cachedClient;
}

async function ensureClientStarted(): Promise<CopilotClient> {
  const client = getClient();
  await client.start();
  return client;
}

/**
 * Stops and discards the cached runtime so the next call starts a fresh one.
 *
 * The runtime resolves the active credential inside its own process and keeps
 * serving that resolution, so a still-running runtime reports stale auth after
 * the active-account pointer changes. Observed for real in an installed build:
 * after `logout()` the app still reported `isAuthenticated: true` with
 * `authType: "user"`, because only `config.json` had been deleted while the
 * already-started runtime kept answering from memory. A fresh runtime on the
 * same `COPILOT_HOME` correctly reports `isAuthenticated: false` (asserted by
 * the live logout test), so recycling the process is what makes sign-out
 * predictable. Done on successful login too, so both directions are symmetric
 * rather than relying on the runtime happening to notice a new credential.
 */
async function resetClient(): Promise<void> {
  const client = cachedClient;
  cachedClient = undefined;
  if (client) {
    try {
      await client.stop();
    } catch {
      // Already exited or never started - nothing to clean up.
    }
  }
}

export function registerAgentAuthHandlers(): void {
  ipcMain.handle(AGENT_GET_AUTH_STATUS_CHANNEL, async (): Promise<AuthStatus> => {
    const client = await ensureClientStarted();
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
    const handle = startWebFlowLogin(cliExePath, { copilotHomeDir });
    inFlightLogin = handle;
    try {
      const outcome = await handle.outcome;
      if (outcome.status === 'success') {
        // Fail closed even on a reported success: if the CLI ever wrote
        // plaintext token material into our COPILOT_HOME, surface that as a
        // failure rather than silently accepting it.
        await assertNoPlaintextCredentials(copilotHomeDir);
        await resetClient();
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
    await resetClient();
    return { apiVersion: 1, warning: result.warning };
  });
}
