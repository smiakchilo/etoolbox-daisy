import type { AppInfo } from './app-info';
import type { AuthPresence, AuthStatus, LoginOutcome, LogoutResult } from './agent-auth';
import type {
  AddProjectRequest,
  AddProjectResult,
  AddProxyRequest,
  AddProxyResult,
  AddServerRequest,
  AddServerResult,
  GetModelSelectionResult,
  GetSettingsSnapshotResult,
  PasswordTarget,
  RemoveProjectRequest,
  RemoveProxyRequest,
  RemoveServerRequest,
  ReorderProjectsRequest,
  ReorderProxiesRequest,
  ReorderServersRequest,
  SetAgentSettingsRequest,
  SetModelPreferencesRequest,
  SettingsIpcVoidResult,
  UpdateBrowserSettingsRequest,
  UpdateProjectRequest,
  UpdateProxyRequest,
  UpdateServerPresentationRequest,
  UpdateServerPresentationResult,
  UpdateServerTargetingRequest,
  UpdateServerTargetingResult,
} from './settings-ipc';
import type {
  ApproveCertificateExceptionRequest,
  BrowserIpcVoidResult,
  BrowserNavigationState,
  BrowserSwitchState,
  CertificateBlockedInfo,
  OpenExternalRequest,
  ViewBounds,
} from './browser-ipc';
import type {
  TableExportRevealResult,
  TableExportSaveCsvRequest,
  TableExportSaveCsvResult,
} from './table-export-ipc';
import type {
  AgentChatByIdRequest,
  AgentChatHistoryListResult,
  AgentChatOpenConversationRequest,
  AgentChatOpenResult,
  AgentChatReadJournalRequest,
  AgentChatReadJournalResult,
  AgentChatRespondToInputRequest,
  AgentChatSendMessageRequest,
  AgentChatSendResult,
  AgentChatSkillsResult,
  AgentChatStatus,
  AgentChatVoidResult,
} from './agent-chat-ipc';
import type { AgentEvent, AgentId } from './contracts';
import type { AppShortcutAction } from './shortcut-ipc';

/**
 * The command-line argument main passes to the renderer's `webPreferences` in
 * an unpackaged build. The preload turns its presence into `window.daisy.devTools`,
 * which gates the dev-only composer triggers (the `!!ask` preview). A packaged
 * build never passes it, so the flag is absent and the triggers are unreachable.
 */
export const DEV_TOOLS_ARGUMENT = '--daisy-dev-tools';

/**
 * Contract for the API the app-preload bridge exposes on
 * `window.daisy`. Defined in `shared` (not in `src/preload`) so both the
 * preload implementation and the renderer's ambient type declarations depend
 * on one neutral source instead of the renderer reaching into preload's
 * project, or vice versa.
 */
export interface DaisyAppApi {
  readonly apiVersion: 1;
  /**
   * Dev-only: whether this build exposes the local development triggers (the
   * `!!ask` ask-user preview). Always `false` in a packaged build.
   */
  readonly devTools: boolean;
  getAppInfo(): Promise<AppInfo>;
  /**
   * The Copilot sign-in/out API: auth status, login, cancel-login, and
   * logout. Backs the Settings panel's Agents tab
   * (`src/renderer/src/settings/agentsSection.ts`).
   */
  readonly agent: DaisyAgentAuthApi;
  /**
   * Dedicated settings IPC surface (step 04): a secret-free snapshot plus
   * write-only password storage. The renderer UI that calls this
   * (the Settings panel) is built in step 05.
   */
  readonly settings: DaisySettingsApi;
  /**
   * The browser-shell IPC surface (step 05): navigation, server switching,
   * the reserved-region bounds channel, and TLS-exception approval.
   */
  readonly browser: DaisyBrowserApi;
  /**
   * The agent chat IPC surface (step 07): puts the application-owned
   * `AgentService` behind IPC for a renderer chat pane. The pane itself is a
   * later task; this surface only needs to exist and behave correctly.
   */
  readonly agentChat: DaisyAgentChatApi;
  /**
   * The transcript table Export surface: main shows the OS save dialog and
   * writes the CSV the user names (`format_table`'s gutter Export action).
   */
  readonly tableExport: DaisyTableExportApi;
  /**
   * The application-wide keyboard shortcut surface: main resolves a keystroke
   * to a semantic action (there is no menu bar to carry an accelerator) and
   * pushes it here. See `src/shared/shortcut-ipc.ts`.
   */
  readonly shortcuts: DaisyShortcutApi;
}

export interface DaisyShortcutApi {
  /**
   * Subscribes to `app:shortcut`, the semantic action an application-wide
   * keyboard shortcut resolved to. Returns an unsubscribe function.
   */
  onAction(listener: (action: AppShortcutAction) => void): () => void;
}

export interface DaisyTableExportApi {
  /**
   * Writes `content` to a file the user picks in the OS save dialog, defaulting
   * to `suggestedFileName`. A cancelled dialog resolves to `{ ok: true, saved:
   * false }`; only a validation or write failure is an error.
   */
  saveCsv(request: TableExportSaveCsvRequest): Promise<TableExportSaveCsvResult>;
  /**
   * Reveals the file the last successful {@link saveCsv} wrote, in the OS file
   * manager. Takes no argument - main owns the path - so the renderer can never
   * point the OS at an arbitrary file.
   */
  revealLast(): Promise<TableExportRevealResult>;
}

export interface DaisyAgentChatApi {
  getStatus(): Promise<AgentChatStatus>;
  openConversation(request: AgentChatOpenConversationRequest): Promise<AgentChatOpenResult>;
  sendMessage(request: AgentChatSendMessageRequest): Promise<AgentChatSendResult>;
  abort(request: AgentChatByIdRequest): Promise<AgentChatVoidResult>;
  closeConversation(request: AgentChatByIdRequest): Promise<AgentChatVoidResult>;
  /**
   * Delivers the user's answer to an outstanding ask-user question
   * (`user.input.requested`), releasing the turn that is waiting on it. Main
   * refuses an answer whose `requestId` names no pending question on `chatId`.
   */
  respondToInput(request: AgentChatRespondToInputRequest): Promise<AgentChatVoidResult>;
  /**
   * Reads one chat's append-only journal so a resumed conversation's transcript
   * can be repainted. Main owns the file and bounds the read; a missing or
   * unreadable journal comes back as an `ok: false` result, never a throw.
   */
  readJournal(request: AgentChatReadJournalRequest): Promise<AgentChatReadJournalResult>;
  /**
   * Reveals one chat's journal file in the OS file manager, for the
   * transcript footer's session-id anchor. Main derives the path from the
   * `chatId`; a missing journal reveals the chats directory instead. Never
   * throws - a failure comes back as an `ok: false` result.
   */
  revealJournal(request: AgentChatByIdRequest): Promise<AgentChatVoidResult>;
  /**
   * The bundled skill catalogue (name + description) for the composer's `/`
   * autocomplete. Read from the application's own `resources/skills` directory
   * in main; never throws - an unreadable catalogue comes back as `ok: false`,
   * which the pane treats as "no autocomplete".
   */
  listSkills(): Promise<AgentChatSkillsResult>;
  /**
   * Lists the stored conversations for the History panel, newest first. Main
   * derives each entry from its journal on demand; never throws - an
   * unreadable directory comes back as `ok: false`.
   */
  listConversations(): Promise<AgentChatHistoryListResult>;
  /**
   * Deletes one stored conversation. If it is the open one, its work is
   * stopped and its handle closed first; then its SDK session (when the agent
   * persists one) and its journal file are removed. Other conversations and
   * the chat's server are left untouched.
   */
  deleteConversation(request: AgentChatByIdRequest): Promise<AgentChatVoidResult>;
  /** Subscribes to `agent-chat:event`; returns an unsubscribe function. */
  onEvent(listener: (event: AgentEvent) => void): () => void;
  /**
   * Subscribes to `agent-chat:status-changed`, which carries the fresh
   * `AgentChatStatus` whenever it may have changed without a chat event (a
   * runtime recycle, or a live auth change). Returns an unsubscribe function.
   */
  onStatusChanged(listener: (status: AgentChatStatus) => void): () => void;
}

export interface DaisyBrowserApi {
  goBack(): Promise<BrowserIpcVoidResult>;
  goForward(): Promise<BrowserIpcVoidResult>;
  reload(): Promise<BrowserIpcVoidResult>;
  stop(): Promise<BrowserIpcVoidResult>;
  navigate(value: string): Promise<BrowserIpcVoidResult>;
  /**
   * Opens a validated absolute http(s) URL in the OS default browser. Used for
   * a transcript link whose origin is not a configured AEM host; main refuses
   * any other scheme.
   */
  openExternal(request: OpenExternalRequest): Promise<BrowserIpcVoidResult>;
  switchServer(serverId: string): Promise<BrowserIpcVoidResult>;
  /** Fire-and-forget: reports the renderer's `.browser-view-host` bounds. Never awaited. */
  setViewBounds(bounds: ViewBounds): void;
  approveCertificateException(
    request: ApproveCertificateExceptionRequest,
  ): Promise<BrowserIpcVoidResult>;
  /** Subscribes to `browser:state-changed`; returns an unsubscribe function. */
  onStateChanged(listener: (state: BrowserNavigationState) => void): () => void;
  /** Subscribes to `browser:switch-state-changed`; returns an unsubscribe function. */
  onSwitchStateChanged(listener: (state: BrowserSwitchState) => void): () => void;
  /**
   * Subscribes to `browser:agent-navigation`, pushed when the agent's
   * `browser_navigate` tool starts a navigation, so the pane can reveal the
   * destination over any whole-size panel or the home veil. Returns an
   * unsubscribe function.
   */
  onAgentNavigation(listener: () => void): () => void;
  /** Subscribes to `browser:certificate-blocked`; returns an unsubscribe function. */
  onCertificateBlocked(listener: (info: CertificateBlockedInfo) => void): () => void;
}

export interface DaisySettingsApi {
  getSnapshot(): Promise<GetSettingsSnapshotResult>;
  setPassword(target: PasswordTarget, password: string): Promise<SettingsIpcVoidResult>;
  clearPassword(target: PasswordTarget): Promise<SettingsIpcVoidResult>;
  addServer(request: AddServerRequest): Promise<AddServerResult>;
  removeServer(request: RemoveServerRequest): Promise<SettingsIpcVoidResult>;
  updateServerPresentation(
    request: UpdateServerPresentationRequest,
  ): Promise<UpdateServerPresentationResult>;
  updateServerTargeting(
    request: UpdateServerTargetingRequest,
  ): Promise<UpdateServerTargetingResult>;
  /** Persists the host list's order (the Settings Hosts multifield's up/down actions). */
  reorderServers(request: ReorderServersRequest): Promise<SettingsIpcVoidResult>;
  /** Creates one entry in the proxies library (the Settings "Proxies" multifield's "Add item"). */
  addProxy(request: AddProxyRequest): Promise<AddProxyResult>;
  /** Replaces one proxy entry's label/address/username. */
  updateProxy(request: UpdateProxyRequest): Promise<SettingsIpcVoidResult>;
  /** Deletes one proxy entry. */
  removeProxy(request: RemoveProxyRequest): Promise<SettingsIpcVoidResult>;
  /** Persists the proxy list's order (the Settings "Proxies" multifield's up/down actions). */
  reorderProxies(request: ReorderProxiesRequest): Promise<SettingsIpcVoidResult>;
  /** Creates one entry in the projects library (the Settings "Projects" multifield's "Add item"). */
  addProject(request: AddProjectRequest): Promise<AddProjectResult>;
  /** Replaces one project entry's label and content/component roots. */
  updateProject(request: UpdateProjectRequest): Promise<SettingsIpcVoidResult>;
  /** Deletes one project entry (clearing it from every host that referenced it). */
  removeProject(request: RemoveProjectRequest): Promise<SettingsIpcVoidResult>;
  /** Persists the project list's order (the Settings "Projects" multifield's up/down actions). */
  reorderProjects(request: ReorderProjectsRequest): Promise<SettingsIpcVoidResult>;
  /**
   * The model catalogue, the stored selection, and whether a turn currently
   * locks changes - all in one call (step 09). See
   * `SETTINGS_GET_MODEL_SELECTION_CHANNEL` for why these are not three calls.
   */
  getModelSelection(): Promise<GetModelSelectionResult>;
  setModelPreferences(request: SetModelPreferencesRequest): Promise<SettingsIpcVoidResult>;
  /**
   * Persists one provider's active flag, proxy, model and/or reasoning effort
   * (the Settings "Agents" surface). A partial patch - see
   * `SETTINGS_SET_AGENT_SETTINGS_CHANNEL`.
   */
  setAgentSettings(request: SetAgentSettingsRequest): Promise<SettingsIpcVoidResult>;
  /**
   * Persists the browser-pane flags (the Settings "Browser" tab). A partial
   * patch - see `SETTINGS_UPDATE_BROWSER_SETTINGS_CHANNEL`. Takes effect on the
   * next launch.
   */
  updateBrowserSettings(request: UpdateBrowserSettingsRequest): Promise<SettingsIpcVoidResult>;
}

/** Sign-in surface, one call per agent - see gentAuthRequestSchema. */
export interface DaisyAgentAuthApi {
  getAuthStatus(agentId: AgentId): Promise<AuthStatus>;
  /**
   * A cheap, non-starting presence probe used to gate the Settings "Set
   * active" control for an inactive provider. Never starts a runtime.
   */
  getAuthPresence(agentId: AgentId): Promise<AuthPresence>;
  login(agentId: AgentId): Promise<LoginOutcome>;
  cancelLogin(agentId: AgentId): Promise<void>;
  logout(agentId: AgentId): Promise<LogoutResult>;
}

/**
 * The AEM preload deliberately exposes nothing to the page's main world, so
 * there is no `window.daisyAem` and no interface describing one
 * (implementation-plan.md step 06). The bridge it provides is driven entirely
 * by the main process over IPC and lives in the isolated world; its wire
 * protocol is `src/shared/contracts/aemBridge.ts`. This note exists because
 * the absence of a type here is a deliberate design property, not an
 * oversight - do not reintroduce one without re-reading that decision.
 */
