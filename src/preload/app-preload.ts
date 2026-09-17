import { contextBridge, ipcRenderer } from 'electron';
import {
  AGENT_CANCEL_LOGIN_CHANNEL,
  AGENT_GET_AUTH_STATUS_CHANNEL,
  AGENT_LOGIN_CHANNEL,
  AGENT_LOGOUT_CHANNEL,
  AGENT_CHAT_ABORT_CHANNEL,
  AGENT_CHAT_CLOSE_CONVERSATION_CHANNEL,
  AGENT_CHAT_EVENT_CHANNEL,
  AGENT_CHAT_GET_STATUS_CHANNEL,
  AGENT_CHAT_OPEN_CONVERSATION_CHANNEL,
  AGENT_CHAT_SEND_MESSAGE_CHANNEL,
  APP_INFO_CHANNEL,
  BROWSER_APPROVE_CERTIFICATE_EXCEPTION_CHANNEL,
  BROWSER_CERTIFICATE_BLOCKED_CHANNEL,
  BROWSER_GO_BACK_CHANNEL,
  BROWSER_GO_FORWARD_CHANNEL,
  BROWSER_NAVIGATE_CHANNEL,
  BROWSER_RELOAD_CHANNEL,
  BROWSER_SET_VIEW_BOUNDS_CHANNEL,
  BROWSER_STATE_CHANGED_CHANNEL,
  BROWSER_STOP_CHANNEL,
  BROWSER_SWITCH_SERVER_CHANNEL,
  BROWSER_SWITCH_STATE_CHANGED_CHANNEL,
  SETTINGS_ADD_SERVER_CHANNEL,
  SETTINGS_CLEAR_PROXY_PASSWORD_CHANNEL,
  SETTINGS_GET_SNAPSHOT_CHANNEL,
  SETTINGS_GET_MODEL_SELECTION_CHANNEL,
  SETTINGS_REMOVE_SERVER_CHANNEL,
  SETTINGS_SET_COPILOT_PROXY_CHANNEL,
  SETTINGS_SET_MODEL_PREFERENCES_CHANNEL,
  SETTINGS_SET_PROXY_PASSWORD_CHANNEL,
  SETTINGS_UPDATE_SERVER_PRESENTATION_CHANNEL,
  SETTINGS_UPDATE_SERVER_TARGETING_CHANNEL,
  addServerRequestSchema,
  approveCertificateExceptionRequestSchema,
  clearProxyPasswordRequestSchema,
  navigateRequestSchema,
  parseAddServerResult,
  parseAgentChatByIdRequest,
  parseAgentChatEvent,
  parseAgentChatOpenConversationRequest,
  parseAgentChatOpenResult,
  parseAgentChatSendMessageRequest,
  parseAgentChatSendResult,
  parseAgentChatStatus,
  parseAgentChatVoidResult,
  parseAppInfo,
  parseAuthStatus,
  parseBrowserIpcVoidResult,
  parseBrowserNavigationState,
  parseBrowserSwitchState,
  parseCertificateBlockedInfo,
  parseGetModelSelectionResult,
  parseGetSettingsSnapshotResult,
  parseLoginOutcome,
  parseLogoutResult,
  parseSettingsIpcVoidResult,
  parseUpdateServerPresentationResult,
  parseUpdateServerTargetingResult,
  removeServerRequestSchema,
  setCopilotProxyRequestSchema,
  setModelPreferencesRequestSchema,
  setProxyPasswordRequestSchema,
  switchServerRequestSchema,
  updateServerPresentationRequestSchema,
  updateServerTargetingRequestSchema,
  viewBoundsSchema,
  type AddServerRequest,
  type AddServerResult,
  type AgentChatByIdRequest,
  type AgentChatOpenConversationRequest,
  type AgentChatOpenResult,
  type AgentChatSendMessageRequest,
  type AgentChatSendResult,
  type AgentChatStatus,
  type AgentChatVoidResult,
  type AgentEvent,
  type ApproveCertificateExceptionRequest,
  type AppInfo,
  type AuthStatus,
  type BrowserIpcVoidResult,
  type BrowserNavigationState,
  type BrowserSwitchState,
  type CertificateBlockedInfo,
  type DaisyAppApi,
  type GetModelSelectionResult,
  type GetSettingsSnapshotResult,
  type LoginOutcome,
  type LogoutResult,
  type ProxyPasswordTarget,
  type RemoveServerRequest,
  type SetCopilotProxyRequest,
  type SetModelPreferencesRequest,
  type SettingsIpcVoidResult,
  type UpdateServerPresentationRequest,
  type UpdateServerPresentationResult,
  type UpdateServerTargetingRequest,
  type UpdateServerTargetingResult,
  type ViewBounds,
} from '../shared';

/**
 * Implements the `DaisyAppApi` contract (defined in `src/shared`). Only plain
 * functions are exposed - never `ipcRenderer` itself - and every value
 * crossing the boundary is parsed with the shared Zod schema before it
 * reaches the renderer, per plan rule 5 (IPC input is `unknown` until
 * validated).
 */
const daisyApi: DaisyAppApi = {
  apiVersion: 1,
  async getAppInfo(): Promise<AppInfo> {
    const raw: unknown = await ipcRenderer.invoke(APP_INFO_CHANNEL);
    return parseAppInfo(raw);
  },
  agent: {
    async getAuthStatus(): Promise<AuthStatus> {
      const raw: unknown = await ipcRenderer.invoke(AGENT_GET_AUTH_STATUS_CHANNEL);
      return parseAuthStatus(raw);
    },
    async login(): Promise<LoginOutcome> {
      const raw: unknown = await ipcRenderer.invoke(AGENT_LOGIN_CHANNEL);
      return parseLoginOutcome(raw);
    },
    async cancelLogin(): Promise<void> {
      await ipcRenderer.invoke(AGENT_CANCEL_LOGIN_CHANNEL);
    },
    async logout(): Promise<LogoutResult> {
      const raw: unknown = await ipcRenderer.invoke(AGENT_LOGOUT_CHANNEL);
      return parseLogoutResult(raw);
    },
  },
  settings: {
    async getSnapshot(): Promise<GetSettingsSnapshotResult> {
      const raw: unknown = await ipcRenderer.invoke(SETTINGS_GET_SNAPSHOT_CHANNEL);
      return parseGetSettingsSnapshotResult(raw);
    },
    async setProxyPassword(
      target: ProxyPasswordTarget,
      password: string,
    ): Promise<SettingsIpcVoidResult> {
      const request = setProxyPasswordRequestSchema.parse({ target, password });
      const raw: unknown = await ipcRenderer.invoke(SETTINGS_SET_PROXY_PASSWORD_CHANNEL, request);
      return parseSettingsIpcVoidResult(raw);
    },
    async clearProxyPassword(target: ProxyPasswordTarget): Promise<SettingsIpcVoidResult> {
      const request = clearProxyPasswordRequestSchema.parse({ target });
      const raw: unknown = await ipcRenderer.invoke(SETTINGS_CLEAR_PROXY_PASSWORD_CHANNEL, request);
      return parseSettingsIpcVoidResult(raw);
    },
    async addServer(request: AddServerRequest): Promise<AddServerResult> {
      const parsedRequest = addServerRequestSchema.parse(request);
      const raw: unknown = await ipcRenderer.invoke(SETTINGS_ADD_SERVER_CHANNEL, parsedRequest);
      return parseAddServerResult(raw);
    },
    async removeServer(request: RemoveServerRequest): Promise<SettingsIpcVoidResult> {
      const parsedRequest = removeServerRequestSchema.parse(request);
      const raw: unknown = await ipcRenderer.invoke(SETTINGS_REMOVE_SERVER_CHANNEL, parsedRequest);
      return parseSettingsIpcVoidResult(raw);
    },
    async updateServerPresentation(
      request: UpdateServerPresentationRequest,
    ): Promise<UpdateServerPresentationResult> {
      const parsedRequest = updateServerPresentationRequestSchema.parse(request);
      const raw: unknown = await ipcRenderer.invoke(
        SETTINGS_UPDATE_SERVER_PRESENTATION_CHANNEL,
        parsedRequest,
      );
      return parseUpdateServerPresentationResult(raw);
    },
    async updateServerTargeting(
      request: UpdateServerTargetingRequest,
    ): Promise<UpdateServerTargetingResult> {
      const parsedRequest = updateServerTargetingRequestSchema.parse(request);
      const raw: unknown = await ipcRenderer.invoke(
        SETTINGS_UPDATE_SERVER_TARGETING_CHANNEL,
        parsedRequest,
      );
      return parseUpdateServerTargetingResult(raw);
    },
    async setCopilotProxy(request: SetCopilotProxyRequest): Promise<SettingsIpcVoidResult> {
      const parsedRequest = setCopilotProxyRequestSchema.parse(request);
      const raw: unknown = await ipcRenderer.invoke(
        SETTINGS_SET_COPILOT_PROXY_CHANNEL,
        parsedRequest,
      );
      return parseSettingsIpcVoidResult(raw);
    },
    async getModelSelection(): Promise<GetModelSelectionResult> {
      const raw: unknown = await ipcRenderer.invoke(SETTINGS_GET_MODEL_SELECTION_CHANNEL);
      return parseGetModelSelectionResult(raw);
    },
    async setModelPreferences(request: SetModelPreferencesRequest): Promise<SettingsIpcVoidResult> {
      const parsedRequest = setModelPreferencesRequestSchema.parse(request);
      const raw: unknown = await ipcRenderer.invoke(
        SETTINGS_SET_MODEL_PREFERENCES_CHANNEL,
        parsedRequest,
      );
      return parseSettingsIpcVoidResult(raw);
    },
  },
  agentChat: {
    async getStatus(): Promise<AgentChatStatus> {
      const raw: unknown = await ipcRenderer.invoke(AGENT_CHAT_GET_STATUS_CHANNEL);
      return parseAgentChatStatus(raw);
    },
    async openConversation(
      request: AgentChatOpenConversationRequest,
    ): Promise<AgentChatOpenResult> {
      const parsedRequest = parseAgentChatOpenConversationRequest(request);
      const raw: unknown = await ipcRenderer.invoke(
        AGENT_CHAT_OPEN_CONVERSATION_CHANNEL,
        parsedRequest,
      );
      return parseAgentChatOpenResult(raw);
    },
    async sendMessage(request: AgentChatSendMessageRequest): Promise<AgentChatSendResult> {
      const parsedRequest = parseAgentChatSendMessageRequest(request);
      const raw: unknown = await ipcRenderer.invoke(AGENT_CHAT_SEND_MESSAGE_CHANNEL, parsedRequest);
      return parseAgentChatSendResult(raw);
    },
    async abort(request: AgentChatByIdRequest): Promise<AgentChatVoidResult> {
      const parsedRequest = parseAgentChatByIdRequest(request);
      const raw: unknown = await ipcRenderer.invoke(AGENT_CHAT_ABORT_CHANNEL, parsedRequest);
      return parseAgentChatVoidResult(raw);
    },
    async closeConversation(request: AgentChatByIdRequest): Promise<AgentChatVoidResult> {
      const parsedRequest = parseAgentChatByIdRequest(request);
      const raw: unknown = await ipcRenderer.invoke(
        AGENT_CHAT_CLOSE_CONVERSATION_CHANNEL,
        parsedRequest,
      );
      return parseAgentChatVoidResult(raw);
    },
    onEvent(listener: (event: AgentEvent) => void): () => void {
      const handler = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
        listener(parseAgentChatEvent(raw));
      };
      ipcRenderer.on(AGENT_CHAT_EVENT_CHANNEL, handler);
      return () => {
        ipcRenderer.removeListener(AGENT_CHAT_EVENT_CHANNEL, handler);
      };
    },
  },
  browser: {
    async goBack(): Promise<BrowserIpcVoidResult> {
      const raw: unknown = await ipcRenderer.invoke(BROWSER_GO_BACK_CHANNEL);
      return parseBrowserIpcVoidResult(raw);
    },
    async goForward(): Promise<BrowserIpcVoidResult> {
      const raw: unknown = await ipcRenderer.invoke(BROWSER_GO_FORWARD_CHANNEL);
      return parseBrowserIpcVoidResult(raw);
    },
    async reload(): Promise<BrowserIpcVoidResult> {
      const raw: unknown = await ipcRenderer.invoke(BROWSER_RELOAD_CHANNEL);
      return parseBrowserIpcVoidResult(raw);
    },
    async stop(): Promise<BrowserIpcVoidResult> {
      const raw: unknown = await ipcRenderer.invoke(BROWSER_STOP_CHANNEL);
      return parseBrowserIpcVoidResult(raw);
    },
    async navigate(value: string): Promise<BrowserIpcVoidResult> {
      const request = navigateRequestSchema.parse({ value });
      const raw: unknown = await ipcRenderer.invoke(BROWSER_NAVIGATE_CHANNEL, request);
      return parseBrowserIpcVoidResult(raw);
    },
    async switchServer(serverId: string): Promise<BrowserIpcVoidResult> {
      const request = switchServerRequestSchema.parse({ serverId });
      const raw: unknown = await ipcRenderer.invoke(BROWSER_SWITCH_SERVER_CHANNEL, request);
      return parseBrowserIpcVoidResult(raw);
    },
    setViewBounds(bounds: ViewBounds): void {
      const request = viewBoundsSchema.parse(bounds);
      ipcRenderer.send(BROWSER_SET_VIEW_BOUNDS_CHANNEL, request);
    },
    async approveCertificateException(
      request: ApproveCertificateExceptionRequest,
    ): Promise<BrowserIpcVoidResult> {
      const parsedRequest = approveCertificateExceptionRequestSchema.parse(request);
      const raw: unknown = await ipcRenderer.invoke(
        BROWSER_APPROVE_CERTIFICATE_EXCEPTION_CHANNEL,
        parsedRequest,
      );
      return parseBrowserIpcVoidResult(raw);
    },
    onStateChanged(listener: (state: BrowserNavigationState) => void): () => void {
      const handler = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
        listener(parseBrowserNavigationState(raw));
      };
      ipcRenderer.on(BROWSER_STATE_CHANGED_CHANNEL, handler);
      return () => {
        ipcRenderer.removeListener(BROWSER_STATE_CHANGED_CHANNEL, handler);
      };
    },
    onSwitchStateChanged(listener: (state: BrowserSwitchState) => void): () => void {
      const handler = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
        listener(parseBrowserSwitchState(raw));
      };
      ipcRenderer.on(BROWSER_SWITCH_STATE_CHANGED_CHANNEL, handler);
      return () => {
        ipcRenderer.removeListener(BROWSER_SWITCH_STATE_CHANGED_CHANNEL, handler);
      };
    },
    onCertificateBlocked(listener: (info: CertificateBlockedInfo) => void): () => void {
      const handler = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
        listener(parseCertificateBlockedInfo(raw));
      };
      ipcRenderer.on(BROWSER_CERTIFICATE_BLOCKED_CHANNEL, handler);
      return () => {
        ipcRenderer.removeListener(BROWSER_CERTIFICATE_BLOCKED_CHANNEL, handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld('daisy', daisyApi);
