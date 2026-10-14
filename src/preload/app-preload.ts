import { contextBridge, ipcRenderer } from 'electron';
import {
  AGENT_CANCEL_LOGIN_CHANNEL,
  AGENT_GET_AUTH_PRESENCE_CHANNEL,
  AGENT_GET_AUTH_STATUS_CHANNEL,
  AGENT_LOGIN_CHANNEL,
  AGENT_LOGOUT_CHANNEL,
  AGENT_CHAT_ABORT_CHANNEL,
  AGENT_CHAT_CLOSE_CONVERSATION_CHANNEL,
  AGENT_CHAT_EVENT_CHANNEL,
  AGENT_CHAT_GET_STATUS_CHANNEL,
  AGENT_CHAT_LIST_SKILLS_CHANNEL,
  AGENT_CHAT_RESPOND_TO_INPUT_CHANNEL,
  AGENT_CHAT_OPEN_CONVERSATION_CHANNEL,
  AGENT_CHAT_READ_JOURNAL_CHANNEL,
  AGENT_CHAT_REVEAL_JOURNAL_CHANNEL,
  AGENT_CHAT_SEND_MESSAGE_CHANNEL,
  AGENT_CHAT_STATUS_CHANGED_CHANNEL,
  APP_INFO_CHANNEL,
  BROWSER_APPROVE_CERTIFICATE_EXCEPTION_CHANNEL,
  BROWSER_CERTIFICATE_BLOCKED_CHANNEL,
  BROWSER_GO_BACK_CHANNEL,
  BROWSER_GO_FORWARD_CHANNEL,
  BROWSER_NAVIGATE_CHANNEL,
  DEV_TOOLS_ARGUMENT,
  BROWSER_OPEN_EXTERNAL_CHANNEL,
  BROWSER_RELOAD_CHANNEL,
  BROWSER_SET_VIEW_BOUNDS_CHANNEL,
  BROWSER_STATE_CHANGED_CHANNEL,
  BROWSER_STOP_CHANNEL,
  BROWSER_SWITCH_SERVER_CHANNEL,
  BROWSER_SWITCH_STATE_CHANGED_CHANNEL,
  SETTINGS_ADD_PROJECT_CHANNEL,
  SETTINGS_ADD_PROXY_CHANNEL,
  SETTINGS_ADD_SERVER_CHANNEL,
  SETTINGS_CLEAR_PASSWORD_CHANNEL,
  SETTINGS_GET_SNAPSHOT_CHANNEL,
  SETTINGS_GET_MODEL_SELECTION_CHANNEL,
  SETTINGS_REMOVE_PROJECT_CHANNEL,
  SETTINGS_REMOVE_PROXY_CHANNEL,
  SETTINGS_REMOVE_SERVER_CHANNEL,
  SETTINGS_REORDER_PROJECTS_CHANNEL,
  SETTINGS_REORDER_PROXIES_CHANNEL,
  SETTINGS_REORDER_SERVERS_CHANNEL,
  SETTINGS_SET_AGENT_SETTINGS_CHANNEL,
  SETTINGS_SET_MODEL_PREFERENCES_CHANNEL,
  SETTINGS_SET_PASSWORD_CHANNEL,
  SETTINGS_UPDATE_BROWSER_SETTINGS_CHANNEL,
  SETTINGS_UPDATE_PROJECT_CHANNEL,
  SETTINGS_UPDATE_PROXY_CHANNEL,
  SETTINGS_UPDATE_SERVER_PRESENTATION_CHANNEL,
  SETTINGS_UPDATE_SERVER_TARGETING_CHANNEL,
  TABLE_EXPORT_REVEAL_LAST_CHANNEL,
  TABLE_EXPORT_SAVE_CSV_CHANNEL,
  addProjectRequestSchema,
  addProxyRequestSchema,
  addServerRequestSchema,
  approveCertificateExceptionRequestSchema,
  clearPasswordRequestSchema,
  navigateRequestSchema,
  openExternalRequestSchema,
  parseAddProjectResult,
  parseAddProxyResult,
  parseAddServerResult,
  parseAgentChatByIdRequest,
  parseAgentChatEvent,
  parseAgentChatOpenConversationRequest,
  parseAgentChatOpenResult,
  parseAgentChatReadJournalRequest,
  parseAgentChatReadJournalResult,
  parseAgentChatRespondToInputRequest,
  parseAgentChatSendMessageRequest,
  parseAgentChatSendResult,
  parseAgentChatSkillsResult,
  parseAgentChatStatus,
  parseAgentChatVoidResult,
  parseAppInfo,
  agentAuthRequestSchema,
  parseAuthPresence,
  parseAuthStatus,
  parseBrowserIpcVoidResult,
  parseBrowserNavigationState,
  parseBrowserSwitchState,
  parseCertificateBlockedInfo,
  parseGetModelSelectionResult,
  parseGetSettingsSnapshotResult,
  parseLoginOutcome,
  parseLogoutResult,
  parseReorderServersResult,
  parseSettingsIpcVoidResult,
  parseTableExportRevealResult,
  parseTableExportSaveCsvResult,
  parseUpdateServerPresentationResult,
  parseUpdateServerTargetingResult,
  removeProjectRequestSchema,
  removeProxyRequestSchema,
  removeServerRequestSchema,
  reorderProjectsRequestSchema,
  reorderProxiesRequestSchema,
  reorderServersRequestSchema,
  setAgentSettingsRequestSchema,
  setModelPreferencesRequestSchema,
  setPasswordRequestSchema,
  switchServerRequestSchema,
  tableExportSaveCsvRequestSchema,
  updateBrowserSettingsRequestSchema,
  updateProjectRequestSchema,
  updateProxyRequestSchema,
  updateServerPresentationRequestSchema,
  updateServerTargetingRequestSchema,
  viewBoundsSchema,
  type AddProjectRequest,
  type AddProjectResult,
  type AddProxyRequest,
  type AddProxyResult,
  type AddServerRequest,
  type AddServerResult,
  type AgentChatByIdRequest,
  type AgentChatOpenConversationRequest,
  type AgentChatOpenResult,
  type AgentChatReadJournalRequest,
  type AgentChatReadJournalResult,
  type AgentChatRespondToInputRequest,
  type AgentChatSendMessageRequest,
  type AgentChatSendResult,
  type AgentChatSkillsResult,
  type AgentChatStatus,
  type AgentChatVoidResult,
  type AgentEvent,
  type AgentId,
  type ApproveCertificateExceptionRequest,
  type AppInfo,
  type AuthPresence,
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
  type OpenExternalRequest,
  type PasswordTarget,
  type RemoveProjectRequest,
  type RemoveProxyRequest,
  type RemoveServerRequest,
  type ReorderProjectsRequest,
  type ReorderProxiesRequest,
  type ReorderServersRequest,
  type SetAgentSettingsRequest,
  type SetModelPreferencesRequest,
  type SettingsIpcVoidResult,
  type TableExportRevealResult,
  type TableExportSaveCsvRequest,
  type TableExportSaveCsvResult,
  type UpdateBrowserSettingsRequest,
  type UpdateProjectRequest,
  type UpdateProxyRequest,
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
  // Set only when main passed `--daisy-dev-tools` (an unpackaged build); gates
  // the dev-only composer triggers in the renderer.
  devTools: process.argv.includes(DEV_TOOLS_ARGUMENT),
  async getAppInfo(): Promise<AppInfo> {
    const raw: unknown = await ipcRenderer.invoke(APP_INFO_CHANNEL);
    return parseAppInfo(raw);
  },
  agent: {
    async getAuthStatus(agentId: AgentId): Promise<AuthStatus> {
      const request = agentAuthRequestSchema.parse({ agentId });
      const raw: unknown = await ipcRenderer.invoke(AGENT_GET_AUTH_STATUS_CHANNEL, request);
      return parseAuthStatus(raw);
    },
    async getAuthPresence(agentId: AgentId): Promise<AuthPresence> {
      const request = agentAuthRequestSchema.parse({ agentId });
      const raw: unknown = await ipcRenderer.invoke(AGENT_GET_AUTH_PRESENCE_CHANNEL, request);
      return parseAuthPresence(raw);
    },
    async login(agentId: AgentId): Promise<LoginOutcome> {
      const request = agentAuthRequestSchema.parse({ agentId });
      const raw: unknown = await ipcRenderer.invoke(AGENT_LOGIN_CHANNEL, request);
      return parseLoginOutcome(raw);
    },
    async cancelLogin(agentId: AgentId): Promise<void> {
      const request = agentAuthRequestSchema.parse({ agentId });
      await ipcRenderer.invoke(AGENT_CANCEL_LOGIN_CHANNEL, request);
    },
    async logout(agentId: AgentId): Promise<LogoutResult> {
      const request = agentAuthRequestSchema.parse({ agentId });
      const raw: unknown = await ipcRenderer.invoke(AGENT_LOGOUT_CHANNEL, request);
      return parseLogoutResult(raw);
    },
  },
  settings: {
    async getSnapshot(): Promise<GetSettingsSnapshotResult> {
      const raw: unknown = await ipcRenderer.invoke(SETTINGS_GET_SNAPSHOT_CHANNEL);
      return parseGetSettingsSnapshotResult(raw);
    },
    async setPassword(target: PasswordTarget, password: string): Promise<SettingsIpcVoidResult> {
      const request = setPasswordRequestSchema.parse({ target, password });
      const raw: unknown = await ipcRenderer.invoke(SETTINGS_SET_PASSWORD_CHANNEL, request);
      return parseSettingsIpcVoidResult(raw);
    },
    async clearPassword(target: PasswordTarget): Promise<SettingsIpcVoidResult> {
      const request = clearPasswordRequestSchema.parse({ target });
      const raw: unknown = await ipcRenderer.invoke(SETTINGS_CLEAR_PASSWORD_CHANNEL, request);
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
    async reorderServers(request: ReorderServersRequest): Promise<SettingsIpcVoidResult> {
      const parsedRequest = reorderServersRequestSchema.parse(request);
      const raw: unknown = await ipcRenderer.invoke(
        SETTINGS_REORDER_SERVERS_CHANNEL,
        parsedRequest,
      );
      return parseReorderServersResult(raw);
    },
    async addProxy(request: AddProxyRequest): Promise<AddProxyResult> {
      const parsedRequest = addProxyRequestSchema.parse(request);
      const raw: unknown = await ipcRenderer.invoke(SETTINGS_ADD_PROXY_CHANNEL, parsedRequest);
      return parseAddProxyResult(raw);
    },
    async updateProxy(request: UpdateProxyRequest): Promise<SettingsIpcVoidResult> {
      const parsedRequest = updateProxyRequestSchema.parse(request);
      const raw: unknown = await ipcRenderer.invoke(SETTINGS_UPDATE_PROXY_CHANNEL, parsedRequest);
      return parseSettingsIpcVoidResult(raw);
    },
    async removeProxy(request: RemoveProxyRequest): Promise<SettingsIpcVoidResult> {
      const parsedRequest = removeProxyRequestSchema.parse(request);
      const raw: unknown = await ipcRenderer.invoke(SETTINGS_REMOVE_PROXY_CHANNEL, parsedRequest);
      return parseSettingsIpcVoidResult(raw);
    },
    async reorderProxies(request: ReorderProxiesRequest): Promise<SettingsIpcVoidResult> {
      const parsedRequest = reorderProxiesRequestSchema.parse(request);
      const raw: unknown = await ipcRenderer.invoke(
        SETTINGS_REORDER_PROXIES_CHANNEL,
        parsedRequest,
      );
      return parseSettingsIpcVoidResult(raw);
    },
    async addProject(request: AddProjectRequest): Promise<AddProjectResult> {
      const parsedRequest = addProjectRequestSchema.parse(request);
      const raw: unknown = await ipcRenderer.invoke(SETTINGS_ADD_PROJECT_CHANNEL, parsedRequest);
      return parseAddProjectResult(raw);
    },
    async updateProject(request: UpdateProjectRequest): Promise<SettingsIpcVoidResult> {
      const parsedRequest = updateProjectRequestSchema.parse(request);
      const raw: unknown = await ipcRenderer.invoke(SETTINGS_UPDATE_PROJECT_CHANNEL, parsedRequest);
      return parseSettingsIpcVoidResult(raw);
    },
    async removeProject(request: RemoveProjectRequest): Promise<SettingsIpcVoidResult> {
      const parsedRequest = removeProjectRequestSchema.parse(request);
      const raw: unknown = await ipcRenderer.invoke(SETTINGS_REMOVE_PROJECT_CHANNEL, parsedRequest);
      return parseSettingsIpcVoidResult(raw);
    },
    async reorderProjects(request: ReorderProjectsRequest): Promise<SettingsIpcVoidResult> {
      const parsedRequest = reorderProjectsRequestSchema.parse(request);
      const raw: unknown = await ipcRenderer.invoke(
        SETTINGS_REORDER_PROJECTS_CHANNEL,
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
    async setAgentSettings(request: SetAgentSettingsRequest): Promise<SettingsIpcVoidResult> {
      const parsedRequest = setAgentSettingsRequestSchema.parse(request);
      const raw: unknown = await ipcRenderer.invoke(
        SETTINGS_SET_AGENT_SETTINGS_CHANNEL,
        parsedRequest,
      );
      return parseSettingsIpcVoidResult(raw);
    },
    async updateBrowserSettings(
      request: UpdateBrowserSettingsRequest,
    ): Promise<SettingsIpcVoidResult> {
      const parsedRequest = updateBrowserSettingsRequestSchema.parse(request);
      const raw: unknown = await ipcRenderer.invoke(
        SETTINGS_UPDATE_BROWSER_SETTINGS_CHANNEL,
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
    async respondToInput(request: AgentChatRespondToInputRequest): Promise<AgentChatVoidResult> {
      const parsedRequest = parseAgentChatRespondToInputRequest(request);
      const raw: unknown = await ipcRenderer.invoke(
        AGENT_CHAT_RESPOND_TO_INPUT_CHANNEL,
        parsedRequest,
      );
      return parseAgentChatVoidResult(raw);
    },
    async readJournal(request: AgentChatReadJournalRequest): Promise<AgentChatReadJournalResult> {
      const parsedRequest = parseAgentChatReadJournalRequest(request);
      const raw: unknown = await ipcRenderer.invoke(AGENT_CHAT_READ_JOURNAL_CHANNEL, parsedRequest);
      return parseAgentChatReadJournalResult(raw);
    },
    async revealJournal(request: AgentChatByIdRequest): Promise<AgentChatVoidResult> {
      const parsedRequest = parseAgentChatByIdRequest(request);
      const raw: unknown = await ipcRenderer.invoke(
        AGENT_CHAT_REVEAL_JOURNAL_CHANNEL,
        parsedRequest,
      );
      return parseAgentChatVoidResult(raw);
    },
    async listSkills(): Promise<AgentChatSkillsResult> {
      const raw: unknown = await ipcRenderer.invoke(AGENT_CHAT_LIST_SKILLS_CHANNEL);
      return parseAgentChatSkillsResult(raw);
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
    onStatusChanged(listener: (status: AgentChatStatus) => void): () => void {
      const handler = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
        listener(parseAgentChatStatus(raw));
      };
      ipcRenderer.on(AGENT_CHAT_STATUS_CHANGED_CHANNEL, handler);
      return () => {
        ipcRenderer.removeListener(AGENT_CHAT_STATUS_CHANGED_CHANNEL, handler);
      };
    },
  },
  tableExport: {
    async saveCsv(request: TableExportSaveCsvRequest): Promise<TableExportSaveCsvResult> {
      const parsedRequest = tableExportSaveCsvRequestSchema.parse(request);
      const raw: unknown = await ipcRenderer.invoke(TABLE_EXPORT_SAVE_CSV_CHANNEL, parsedRequest);
      return parseTableExportSaveCsvResult(raw);
    },
    async revealLast(): Promise<TableExportRevealResult> {
      const raw: unknown = await ipcRenderer.invoke(TABLE_EXPORT_REVEAL_LAST_CHANNEL);
      return parseTableExportRevealResult(raw);
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
    async openExternal(request: OpenExternalRequest): Promise<BrowserIpcVoidResult> {
      const parsedRequest = openExternalRequestSchema.parse(request);
      const raw: unknown = await ipcRenderer.invoke(BROWSER_OPEN_EXTERNAL_CHANNEL, parsedRequest);
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
