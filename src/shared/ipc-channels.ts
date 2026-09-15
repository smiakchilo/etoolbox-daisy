/**
 * Channel name contracts shared between main and preload. Plain string
 * literals only — this file must stay free of Electron/Node imports so it can
 * be used from `src/shared` (see the `no-restricted-imports` ESLint rule).
 */
export const APP_INFO_CHANNEL = 'app:get-app-info' as const;

// Copilot sign-in/out surface, presented in the Settings window's
// authentication section (src/renderer/src/settingsWindow/authenticationSection.ts).
export const AGENT_GET_AUTH_STATUS_CHANNEL = 'agent:get-auth-status' as const;
export const AGENT_LOGIN_CHANNEL = 'agent:login' as const;
export const AGENT_CANCEL_LOGIN_CHANNEL = 'agent:cancel-login' as const;
export const AGENT_LOGOUT_CHANNEL = 'agent:logout' as const;

// Dedicated settings IPC surface (step 04) - see src/main/ipc/settings.ts and
// src/shared/settings-ipc.ts. Read-only snapshot plus write-only secret
// storage; server/proxy/origin mutation channels belong to step 05.
export const SETTINGS_GET_SNAPSHOT_CHANNEL = 'settings:get-snapshot' as const;
export const SETTINGS_SET_PROXY_PASSWORD_CHANNEL = 'settings:set-proxy-password' as const;
export const SETTINGS_CLEAR_PROXY_PASSWORD_CHANNEL = 'settings:clear-proxy-password' as const;

// Settings mutation (step 05) - see src/main/ipc/settingsMutation.ts and
// src/main/settingsStore.ts. Presentation/targeting edits for an existing
// server reuse `applyServerPresentationChange`/`applyServerTargetingChange`;
// these four cover what those two do not: creating/removing a server entry,
// choosing which one is active, and the separate global Copilot proxy.
export const SETTINGS_ADD_SERVER_CHANNEL = 'settings:add-server' as const;
export const SETTINGS_REMOVE_SERVER_CHANNEL = 'settings:remove-server' as const;
export const SETTINGS_SET_ACTIVE_SERVER_CHANNEL = 'settings:set-active-server' as const;
export const SETTINGS_UPDATE_SERVER_PRESENTATION_CHANNEL =
  'settings:update-server-presentation' as const;
export const SETTINGS_UPDATE_SERVER_TARGETING_CHANNEL = 'settings:update-server-targeting' as const;
export const SETTINGS_SET_COPILOT_PROXY_CHANNEL = 'settings:set-copilot-proxy' as const;

// Model / reasoning-effort selection (step 09) - see src/main/ipc/settings.ts,
// src/agent/modelCatalog.ts and src/shared/contracts/modelCatalog.ts. Read is
// a single channel rather than "list models" plus "read selection" plus "is a
// turn running": the Settings UI can only render a consistent picker from all
// three at once, and three separate round trips could interleave with a turn
// starting and produce an enabled picker for a locked selection.
export const SETTINGS_GET_MODEL_SELECTION_CHANNEL = 'settings:get-model-selection' as const;
export const SETTINGS_SET_MODEL_PREFERENCES_CHANNEL = 'settings:set-model-preferences' as const;

// Browser shell IPC surface (step 05) - see src/main/ipc/browser.ts and
// src/shared/browser-ipc.ts.
export const BROWSER_GO_BACK_CHANNEL = 'browser:go-back' as const;
export const BROWSER_GO_FORWARD_CHANNEL = 'browser:go-forward' as const;
export const BROWSER_RELOAD_CHANNEL = 'browser:reload' as const;
export const BROWSER_NAVIGATE_CHANNEL = 'browser:navigate' as const;
export const BROWSER_SET_VIEW_BOUNDS_CHANNEL = 'browser:set-view-bounds' as const;
export const BROWSER_SWITCH_SERVER_CHANNEL = 'browser:switch-server' as const;
export const BROWSER_APPROVE_CERTIFICATE_EXCEPTION_CHANNEL =
  'browser:approve-certificate-exception' as const;
export const BROWSER_REVOKE_CERTIFICATE_EXCEPTION_CHANNEL =
  'browser:revoke-certificate-exception' as const;
/** Push channel: main -> renderer, whenever the AEM view's navigation state changes. */
export const BROWSER_STATE_CHANGED_CHANNEL = 'browser:state-changed' as const;
/** Push channel: main -> renderer, whenever a server switch starts/finishes. */
export const BROWSER_SWITCH_STATE_CHANGED_CHANNEL = 'browser:switch-state-changed' as const;
/** Push channel: main -> renderer, whenever a certificate error has no matching exception. */
export const BROWSER_CERTIFICATE_BLOCKED_CHANNEL = 'browser:certificate-blocked' as const;

/** Opens the Settings child window (requirements-decisions.md section 8). */
export const APP_OPEN_SETTINGS_WINDOW_CHANNEL = 'app:open-settings-window' as const;

// Agent chat IPC surface (step 07) - see src/main/ipc/agentChat.ts and
// src/shared/agent-chat-ipc.ts. Puts the `AgentService` behind IPC for a
// renderer chat pane, distinct from the `agent:*` sign-in/out surface above.
export const AGENT_CHAT_GET_STATUS_CHANNEL = 'agent-chat:get-status' as const;
export const AGENT_CHAT_OPEN_CONVERSATION_CHANNEL = 'agent-chat:open-conversation' as const;
export const AGENT_CHAT_SEND_MESSAGE_CHANNEL = 'agent-chat:send-message' as const;
export const AGENT_CHAT_ABORT_CHANNEL = 'agent-chat:abort' as const;
export const AGENT_CHAT_CLOSE_CONVERSATION_CHANNEL = 'agent-chat:close-conversation' as const;
/** Push channel: main -> renderer, one `AgentEvent` per event, only for the currently open conversation. */
export const AGENT_CHAT_EVENT_CHANNEL = 'agent-chat:event' as const;
