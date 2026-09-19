import type { AppInfo } from './app-info';
import type { AuthStatus, LoginOutcome, LogoutResult } from './agent-auth';
import type {
  AddProxyRequest,
  AddProxyResult,
  AddServerRequest,
  AddServerResult,
  GetModelSelectionResult,
  GetSettingsSnapshotResult,
  ProxyPasswordTarget,
  RemoveProxyRequest,
  RemoveServerRequest,
  ReorderProxiesRequest,
  ReorderServersRequest,
  SetModelPreferencesRequest,
  SettingsIpcVoidResult,
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
  ViewBounds,
} from './browser-ipc';
import type {
  AgentChatByIdRequest,
  AgentChatOpenConversationRequest,
  AgentChatOpenResult,
  AgentChatSendMessageRequest,
  AgentChatSendResult,
  AgentChatStatus,
  AgentChatVoidResult,
} from './agent-chat-ipc';
import type { AgentEvent } from './contracts';

/**
 * Contract for the API the app-preload bridge exposes on
 * `window.daisy`. Defined in `shared` (not in `src/preload`) so both the
 * preload implementation and the renderer's ambient type declarations depend
 * on one neutral source instead of the renderer reaching into preload's
 * project, or vice versa.
 */
export interface DaisyAppApi {
  readonly apiVersion: 1;
  getAppInfo(): Promise<AppInfo>;
  /**
   * The Copilot sign-in/out API: auth status, login, cancel-login, and
   * logout. Backs the Settings panel's authentication section
   * (`src/renderer/src/settings/authenticationSection.ts`).
   */
  readonly agent: DaisyAgentAuthApi;
  /**
   * Dedicated settings IPC surface (step 04): a secret-free snapshot plus
   * write-only proxy-password storage. The renderer UI that calls this
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
}

export interface DaisyAgentChatApi {
  getStatus(): Promise<AgentChatStatus>;
  openConversation(request: AgentChatOpenConversationRequest): Promise<AgentChatOpenResult>;
  sendMessage(request: AgentChatSendMessageRequest): Promise<AgentChatSendResult>;
  abort(request: AgentChatByIdRequest): Promise<AgentChatVoidResult>;
  closeConversation(request: AgentChatByIdRequest): Promise<AgentChatVoidResult>;
  /** Subscribes to `agent-chat:event`; returns an unsubscribe function. */
  onEvent(listener: (event: AgentEvent) => void): () => void;
}

export interface DaisyBrowserApi {
  goBack(): Promise<BrowserIpcVoidResult>;
  goForward(): Promise<BrowserIpcVoidResult>;
  reload(): Promise<BrowserIpcVoidResult>;
  stop(): Promise<BrowserIpcVoidResult>;
  navigate(value: string): Promise<BrowserIpcVoidResult>;
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
  /** Subscribes to `browser:certificate-blocked`; returns an unsubscribe function. */
  onCertificateBlocked(listener: (info: CertificateBlockedInfo) => void): () => void;
}

export interface DaisySettingsApi {
  getSnapshot(): Promise<GetSettingsSnapshotResult>;
  setProxyPassword(target: ProxyPasswordTarget, password: string): Promise<SettingsIpcVoidResult>;
  clearProxyPassword(target: ProxyPasswordTarget): Promise<SettingsIpcVoidResult>;
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
  /**
   * The model catalogue, the stored selection, and whether a turn currently
   * locks changes - all in one call (step 09). See
   * `SETTINGS_GET_MODEL_SELECTION_CHANNEL` for why these are not three calls.
   */
  getModelSelection(): Promise<GetModelSelectionResult>;
  setModelPreferences(request: SetModelPreferencesRequest): Promise<SettingsIpcVoidResult>;
}

export interface DaisyAgentAuthApi {
  getAuthStatus(): Promise<AuthStatus>;
  login(): Promise<LoginOutcome>;
  cancelLogin(): Promise<void>;
  logout(): Promise<LogoutResult>;
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
