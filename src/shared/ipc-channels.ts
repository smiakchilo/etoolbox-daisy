/**
 * Channel name contracts shared between main and preload. Plain string
 * literals only — this file must stay free of Electron/Node imports so it can
 * be used from `src/shared` (see the `no-restricted-imports` ESLint rule).
 */
export const APP_INFO_CHANNEL = 'app:get-app-info' as const;

/**
 * Push channel: main -> renderer, one application-wide keyboard shortcut. Main
 * matches the keystroke via `before-input-event` on both the shell's and the AEM
 * view's `WebContents` (the app has no menu bar, so a shortcut cannot be an
 * accelerator - see `src/main/shortcuts.ts`) and pushes the resolved
 * *semantic* action here; the shell renderer dispatches it onto its existing
 * toolbar/panel handlers. The payload is an `AppShortcutAction`
 * (`src/shared/shortcut-ipc.ts`).
 */
export const APP_SHORTCUT_CHANNEL = 'app:shortcut' as const;

// Copilot sign-in/out surface, presented in the Settings panel's Agents tab
// (src/renderer/src/settings/agentsSection.ts).
export const AGENT_GET_AUTH_STATUS_CHANNEL = 'agent:get-auth-status' as const;
export const AGENT_GET_AUTH_PRESENCE_CHANNEL = 'agent:get-auth-presence' as const;
export const AGENT_LOGIN_CHANNEL = 'agent:login' as const;
export const AGENT_CANCEL_LOGIN_CHANNEL = 'agent:cancel-login' as const;
export const AGENT_LOGOUT_CHANNEL = 'agent:logout' as const;

// Dedicated settings IPC surface (step 04) - see src/main/ipc/settings.ts and
// src/shared/settings-ipc.ts. Read-only snapshot plus write-only secret
// storage; server/proxy/origin mutation channels belong to step 05.
export const SETTINGS_GET_SNAPSHOT_CHANNEL = 'settings:get-snapshot' as const;
export const SETTINGS_SET_PASSWORD_CHANNEL = 'settings:set-password' as const;
export const SETTINGS_CLEAR_PASSWORD_CHANNEL = 'settings:clear-password' as const;

// Settings mutation (step 05) - see src/main/ipc/settingsMutation.ts and
// src/main/settingsStore.ts. Presentation/targeting edits for an existing
// server reuse `applyServerPresentationChange`/`applyServerTargetingChange`;
// these cover what those two do not: creating/removing a server entry and the
// separate proxies library below.
export const SETTINGS_ADD_SERVER_CHANNEL = 'settings:add-server' as const;
export const SETTINGS_REMOVE_SERVER_CHANNEL = 'settings:remove-server' as const;
export const SETTINGS_UPDATE_SERVER_PRESENTATION_CHANNEL =
  'settings:update-server-presentation' as const;
export const SETTINGS_UPDATE_SERVER_TARGETING_CHANNEL = 'settings:update-server-targeting' as const;
/**
 * The proxies library (`settings.json`'s `proxies` array), edited through the
 * Settings "Proxies" multifield. `add-proxy` creates one entry (the
 * multifield's "Add item"), `update-proxy` replaces its label/address/username,
 * `remove-proxy` deletes it, and `reorder-proxies` persists the list order.
 */
export const SETTINGS_ADD_PROXY_CHANNEL = 'settings:add-proxy' as const;
export const SETTINGS_UPDATE_PROXY_CHANNEL = 'settings:update-proxy' as const;
export const SETTINGS_REMOVE_PROXY_CHANNEL = 'settings:remove-proxy' as const;
export const SETTINGS_REORDER_PROXIES_CHANNEL = 'settings:reorder-proxies' as const;
/**
 * The projects library (`settings.json`'s `projects` array), edited through the
 * Settings "Projects" multifield and selected per hosts by the "Hosts" tab's
 * Project combobox. `add-project` creates one entry, `update-project` replaces
 * its label/roots, `remove-project` deletes it, and `reorder-projects`
 * persists the list order.
 */
export const SETTINGS_ADD_PROJECT_CHANNEL = 'settings:add-project' as const;
export const SETTINGS_UPDATE_PROJECT_CHANNEL = 'settings:update-project' as const;
export const SETTINGS_REMOVE_PROJECT_CHANNEL = 'settings:remove-project' as const;
export const SETTINGS_REORDER_PROJECTS_CHANNEL = 'settings:reorder-projects' as const;
/**
 * Persists the host list's order (the rows in the Settings "Hosts" multifield
 * can be moved up/down; the order is meaningful because it drives the browser
 * toolbar's host picker). A full permutation of the configured server ids, not
 * a single up/down step, so the renderer's view of the order is the one that is
 * persisted - see `reorderServersRequestSchema`.
 */
export const SETTINGS_REORDER_SERVERS_CHANNEL = 'settings:reorder-servers' as const;

// Model / reasoning-effort selection (step 09) - see src/main/ipc/settings.ts,
// src/agent/modelCatalog.ts and src/shared/contracts/modelCatalog.ts. Read is
// a single channel rather than "list models" plus "read selection" plus "is a
// turn running": the Settings UI can only render a consistent picker from all
// three at once, and three separate round trips could interleave with a turn
// starting and produce an enabled picker for a locked selection.
export const SETTINGS_GET_MODEL_SELECTION_CHANNEL = 'settings:get-model-selection' as const;
export const SETTINGS_SET_MODEL_PREFERENCES_CHANNEL = 'settings:set-model-preferences' as const;

/**
 * Persists one provider's active flag, proxy reference, model and/or reasoning
 * effort (the Settings "Agents" surface). A partial patch whose omitted keys
 * mean "leave unchanged" - see `setAgentSettingsRequestSchema` for the
 * three-state convention and why `agentId` must name a registered provider.
 */
export const SETTINGS_SET_AGENT_SETTINGS_CHANNEL = 'settings:set-agent-settings' as const;

/**
 * Persists the browser-pane flags (the Settings "Browser" tab). A partial
 * patch, like {@link SETTINGS_SET_AGENT_SETTINGS_CHANNEL}. The flag is read
 * before Electron is ready, so a change takes effect on the next launch.
 */
export const SETTINGS_UPDATE_BROWSER_SETTINGS_CHANNEL = 'settings:update-browser-settings' as const;

/**
 * Exports a transcript table as a CSV file (the `format_table` message's
 * gutter **Export** action). The renderer owns the serialization; main owns the
 * OS save dialog and the file write. See src/shared/table-export-ipc.ts.
 */
export const TABLE_EXPORT_SAVE_CSV_CHANNEL = 'table-export:save-csv' as const;
/**
 * Reveals the file the last successful `table-export:save-csv` wrote, in the
 * OS file manager. No request payload: main owns the path (see
 * `src/shared/table-export-ipc.ts`).
 */
export const TABLE_EXPORT_REVEAL_LAST_CHANNEL = 'table-export:reveal-last' as const;

/**
 * Opens the user's skills folder (`appPaths.skills`) in the OS file manager,
 * creating it when missing. No request payload: main owns the path (see
 * `src/shared/skills-ipc.ts`).
 */
export const SKILLS_OPEN_FOLDER_CHANNEL = 'skills:open-folder' as const;

/**
 * Opens the user's rules folder (`appPaths.rules`) in the OS file manager,
 * creating it when missing. No request payload: main owns the path (see
 * `src/shared/rules-ipc.ts`).
 */
export const RULES_OPEN_FOLDER_CHANNEL = 'rules:open-folder' as const;

/**
 * Persists the self-learning flag (the Settings "Skills" tab's checkbox). A
 * partial patch, like {@link SETTINGS_UPDATE_BROWSER_SETTINGS_CHANNEL}.
 */
export const SETTINGS_UPDATE_MEMO_SETTINGS_CHANNEL = 'settings:update-memo-settings' as const;

/**
 * Opens the memos folder (`appPaths.memos`) in the OS file manager, creating it
 * when missing. No request payload: main owns the path (see
 * `src/shared/memos-ipc.ts`).
 */
export const MEMOS_OPEN_FOLDER_CHANNEL = 'memos:open-folder' as const;
/**
 * Reveals one memo file in the OS file manager. The request names the memo by
 * its store-relative id; main derives and contains the path.
 */
export const MEMOS_REVEAL_CHANNEL = 'memos:reveal' as const;

/**
 * Saved sign-ins. `credentials:captured` is the one message the browser pane's
 * preload sends to main (a submitted sign-in form); main decides the origin
 * from the sending frame, never from the payload. `credentials:erase` backs the
 * Settings "Browser" tab's one management action. See
 * src/shared/credentials-ipc.ts.
 */
export const CREDENTIALS_CAPTURED_CHANNEL = 'credentials:captured' as const;
export const CREDENTIALS_ERASE_CHANNEL = 'credentials:erase' as const;

/**
 * Persists the Updates tab's custom update URL and startup-check flag. A
 * partial patch, like {@link SETTINGS_UPDATE_BROWSER_SETTINGS_CHANNEL}.
 */
export const SETTINGS_UPDATE_UPDATE_SETTINGS_CHANNEL = 'settings:update-update-settings' as const;

/** Reads the updater's current status (see `src/shared/updates-ipc.ts`). */
export const UPDATES_GET_STATUS_CHANNEL = 'updates:get-status' as const;
/** Checks the update sources now; resolves with the resulting status. No payload. */
export const UPDATES_CHECK_CHANNEL = 'updates:check' as const;
/** Downloads, verifies and swaps in the pending update, then restarts the app. No payload. */
export const UPDATES_APPLY_CHANNEL = 'updates:apply' as const;
/** Push channel: main -> renderer, whenever the updater's status changes. */
export const UPDATES_STATUS_CHANGED_CHANNEL = 'updates:status-changed' as const;

// Browser shell IPC surface (step 05) - see src/main/ipc/browser.ts and
// src/shared/browser-ipc.ts.
export const BROWSER_GO_BACK_CHANNEL = 'browser:go-back' as const;
export const BROWSER_GO_FORWARD_CHANNEL = 'browser:go-forward' as const;
export const BROWSER_RELOAD_CHANNEL = 'browser:reload' as const;
export const BROWSER_NAVIGATE_CHANNEL = 'browser:navigate' as const;
/** Opens an absolute http(s) URL in the OS default browser (a transcript link whose origin is not a configured host). */
export const BROWSER_OPEN_EXTERNAL_CHANNEL = 'browser:open-external' as const;
export const BROWSER_SET_VIEW_BOUNDS_CHANNEL = 'browser:set-view-bounds' as const;
export const BROWSER_SWITCH_SERVER_CHANNEL = 'browser:switch-server' as const;
/** Stops any in-flight load in the browser view (the toolbar's Refresh/Stop control). */
export const BROWSER_STOP_CHANNEL = 'browser:stop' as const;
export const BROWSER_APPROVE_CERTIFICATE_EXCEPTION_CHANNEL =
  'browser:approve-certificate-exception' as const;
/** Push channel: main -> renderer, whenever the browser view's navigation state changes. */
export const BROWSER_STATE_CHANGED_CHANNEL = 'browser:state-changed' as const;
/**
 * Push channel: main -> renderer, when the agent's `browser_navigate` tool
 * starts a navigation. Unlike an in-page navigation, this is the application
 * moving the pane on the user's behalf, so the renderer reveals the destination
 * - dismissing whatever whole-size panel (or home veil) would otherwise hide it.
 * Carries no payload: the pane only needs to know that an external,
 * application-caused navigation has begun.
 */
export const BROWSER_AGENT_NAVIGATION_CHANNEL = 'browser:agent-navigation' as const;
/**
 * Push channel: main -> renderer, when a tool read shows the host stopped
 * recognising the user (or a later read shows it recovered). Payload:
 * `BrowserAuthIncident` (src/shared/browser-ipc.ts).
 */
export const BROWSER_AUTH_INCIDENT_CHANNEL = 'browser:auth-incident' as const;
/** Push channel: main -> renderer, whenever a server switch starts/finishes. */
export const BROWSER_SWITCH_STATE_CHANGED_CHANNEL = 'browser:switch-state-changed' as const;
/** Push channel: main -> renderer, whenever a certificate error has no matching exception. */
export const BROWSER_CERTIFICATE_BLOCKED_CHANNEL = 'browser:certificate-blocked' as const;
/**
 * Find-in-page. The renderer's find bar names a logical `target` (`browser` for
 * the browser view, `chat` for the shell document); main resolves it to a
 * `WebContents` and calls `findInPage`/`stopFindInPage`. Matches come back on
 * {@link BROWSER_FIND_RESULT_CHANNEL}. See src/shared/browser-ipc.ts.
 */
export const BROWSER_FIND_CHANNEL = 'browser:find' as const;
export const BROWSER_STOP_FIND_CHANNEL = 'browser:stop-find' as const;
/** Push channel: main -> renderer, one `found-in-page` result for a find target. */
export const BROWSER_FIND_RESULT_CHANNEL = 'browser:find-result' as const;

// Agent chat IPC surface (step 07) - see src/main/ipc/agentChat.ts and
// src/shared/agent-chat-ipc.ts. Puts the `AgentService` behind IPC for a
// renderer chat pane, distinct from the `agent:*` sign-in/out surface above.
export const AGENT_CHAT_GET_STATUS_CHANNEL = 'agent-chat:get-status' as const;
export const AGENT_CHAT_OPEN_CONVERSATION_CHANNEL = 'agent-chat:open-conversation' as const;
export const AGENT_CHAT_SEND_MESSAGE_CHANNEL = 'agent-chat:send-message' as const;
export const AGENT_CHAT_ABORT_CHANNEL = 'agent-chat:abort' as const;
export const AGENT_CHAT_CLOSE_CONVERSATION_CHANNEL = 'agent-chat:close-conversation' as const;
/** Delivers the user's answer to an outstanding ask-user question (`user.input.requested`). */
export const AGENT_CHAT_RESPOND_TO_INPUT_CHANNEL = 'agent-chat:respond-to-input' as const;
/** Reads one chat's append-only journal so a resumed conversation's transcript can be repainted. */
export const AGENT_CHAT_READ_JOURNAL_CHANNEL = 'agent-chat:read-journal' as const;
/**
 * Reveals one chat's journal file in the OS file manager. Backs the transcript
 * footer's session-id anchor; main derives the file from `chatId` (never from a
 * renderer-supplied path), so the renderer can never steer the reveal.
 */
export const AGENT_CHAT_REVEAL_JOURNAL_CHANNEL = 'agent-chat:reveal-journal' as const;
/** Reads the bundled skill catalogue for the composer's `/` autocomplete. */
export const AGENT_CHAT_LIST_SKILLS_CHANNEL = 'agent-chat:list-skills' as const;
/**
 * Lists the stored conversations (a browsable History). Main derives each
 * entry from the chat's journal on demand - title from the first user message,
 * date and server from the header - so there is no second metadata store.
 */
export const AGENT_CHAT_LIST_CONVERSATIONS_CHANNEL = 'agent-chat:list-conversations' as const;
/**
 * Deletes one stored conversation: stops its work and closes its SDK handle if
 * it is the open conversation, deletes its SDK session (when the agent persists
 * one), and removes its journal file - without touching any other chat or its
 * server.
 */
export const AGENT_CHAT_DELETE_CONVERSATION_CHANNEL = 'agent-chat:delete-conversation' as const;
/** Push channel: main -> renderer, one `AgentEvent` per event, only for the currently open conversation. */
export const AGENT_CHAT_EVENT_CHANNEL = 'agent-chat:event' as const;
/**
 * Push channel: main -> renderer, an `AgentChatStatus` whenever the value
 * `agent-chat:get-status` would return may have changed *without* a chat
 * event: the runtime was recycled (a proxy/active-provider change, sign-in/out,
 * a token set/clear) or the live auth state changed. Without it the pane only
 * learns of those through its slow periodic poll, so its composer can stay
 * enabled for far longer than the Settings panel - long enough to send into a
 * conversation main has already torn down.
 */
export const AGENT_CHAT_STATUS_CHANGED_CHANNEL = 'agent-chat:status-changed' as const;
