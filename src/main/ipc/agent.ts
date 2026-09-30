import { ipcMain } from 'electron';
import {
  AGENT_CANCEL_LOGIN_CHANNEL,
  AGENT_GET_AUTH_STATUS_CHANNEL,
  AGENT_LOGIN_CHANNEL,
  AGENT_LOGOUT_CHANNEL,
  parseAgentAuthRequest,
  type AppSettings,
  type AuthStatus,
  type LoginOutcome,
  type LogoutResult,
} from '../../shared';
import type { AgentHub } from '../agents/hub';

/**
 * The agent sign-in/out IPC handlers: auth status, login, cancel-login,
 * logout. Backs the Agents section of the Settings panel
 * (`src/renderer/src/settings/agentsSection.ts`).
 *
 * Agent-neutral: every request names an `agentId` and is routed to that
 * agent's runtime through the {@link AgentHub}. Nothing here knows how any
 * provider signs in - the single-flight guard, the login child process and the
 * credential checks all live in the agent's own folder.
 */
export interface AgentAuthDependencies {
  readonly hub: Pick<AgentHub, 'getAuthStatus' | 'login' | 'cancelLogin' | 'logout'>;
  /**
   * Read fresh, not from the startup snapshot: the user may have changed the
   * agent's proxy since launch, and sign-in must use the proxy the runtime is
   * *currently* configured with. `undefined` when the settings file is unreadable.
   */
  readonly loadSettings: () => Promise<AppSettings | undefined>;
}

export function registerAgentAuthHandlers(deps: AgentAuthDependencies): void {
  ipcMain.handle(AGENT_GET_AUTH_STATUS_CHANNEL, (_event, request: unknown): Promise<AuthStatus> =>
    deps.hub.getAuthStatus(parseAgentAuthRequest(request).agentId),
  );

  ipcMain.handle(AGENT_LOGIN_CHANNEL, async (_event, request: unknown): Promise<LoginOutcome> => {
    const { agentId } = parseAgentAuthRequest(request);
    return deps.hub.login(agentId, await deps.loadSettings());
  });

  ipcMain.handle(AGENT_CANCEL_LOGIN_CHANNEL, (_event, request: unknown): void => {
    deps.hub.cancelLogin(parseAgentAuthRequest(request).agentId);
  });

  ipcMain.handle(AGENT_LOGOUT_CHANNEL, (_event, request: unknown): Promise<LogoutResult> =>
    deps.hub.logout(parseAgentAuthRequest(request).agentId),
  );
}
