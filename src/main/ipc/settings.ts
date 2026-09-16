import { randomUUID } from 'node:crypto';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
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
} from '../../shared';
import {
  addServerRequestSchema,
  clearProxyPasswordRequestSchema,
  removeServerRequestSchema,
  setCopilotProxyRequestSchema,
  setModelPreferencesRequestSchema,
  setProxyPasswordRequestSchema,
  updateServerPresentationRequestSchema,
  updateServerTargetingRequestSchema,
  type AddServerRequest,
  type AddServerResult,
  type ClearProxyPasswordRequest,
  type GetModelSelectionResult,
  type GetSettingsSnapshotResult,
  type ProxyPasswordTarget,
  type RemoveServerRequest,
  type ServerTargetingMutationKind,
  type SetCopilotProxyRequest,
  type SetModelPreferencesRequest,
  type SetProxyPasswordRequest,
  type SettingsIpcError,
  type SettingsIpcVoidResult,
  type UpdateServerPresentationRequest,
  type UpdateServerPresentationResult,
  type UpdateServerTargetingRequest,
  type UpdateServerTargetingResult,
} from '../../shared';
import { toAppSettingsSnapshot, type ServerSnapshot } from '../../shared';
import { defaultAppSettings, type AppSettings } from '../../shared';
import { isReasoningEffortValidFor, type ModelCatalogEntry } from '../../shared';
import type {
  ProxyCredentials,
  ServerConfig,
  ServerPresentationChanges,
  ServerTargetingChanges,
} from '../../shared';
import { newServerId } from '../../shared';
import { err, ok, type Result } from '../../shared';
import {
  addServer as createServerEntry,
  applyServerPresentationChange,
  applyServerTargetingChange,
  confirmOriginChange,
  loadSettings,
  removeServer as deleteServerEntry,
  saveSettings,
  updateCopilotProxy as updateCopilotProxyEntry,
  updateModelPreferences as updateModelPreferencesEntry,
  type ServerMutationKind,
} from '../settingsStore';
import type { SecretStore } from '../secretStore';
import type { Logger } from '../logger';
import { isAllowedAppNavigation } from '../security';

/**
 * The dedicated settings IPC surface (implementation-plan.md step 04/05: "UI
 * snapshots must not include saved passwords. Accept a new value only from
 * the local Settings window through dedicated IPC.").
 *
 *  - `settings:get-snapshot` - read the secret-free
 *    {@link import("../../shared/contracts/settingsSnapshot").AppSettingsSnapshot}.
 *  - `settings:set-proxy-password` / `settings:clear-proxy-password` -
 *    write-only proxy password storage, never echoed back.
 *  - `settings:add-server` / `settings:remove-server` -
 *    create/delete a server entry.
 *  - `settings:update-server-presentation` / `settings:update-server-targeting` -
 *    edit an existing server's label/colour, or its origin/proxy/TLS
 *    exception, by wrapping the pure mutation helpers already implemented in
 *    `settingsStore.ts` (`applyServerPresentationChange`/
 *    `applyServerTargetingChange`).
 *  - `settings:set-copilot-proxy` - replace the global Copilot proxy's
 *    address/username.
 *  - `settings:get-model-selection` / `settings:set-model-preferences` (step
 *    09) - read the SDK model catalogue together with the stored selection and
 *    the turn lock, and replace the stored model/reasoning-effort pair.
 *
 * There is deliberately no `settings:set-active-server` handler registered
 * here yet: choosing the active server is tied to actually switching the
 * live AEM view (`browser:switch-server` in `ipc/browser.ts`), which this
 * module must not reach into (see that module's own `BrowserController`).
 * `removeServer` below still clears `activeServerId` itself when the removed
 * server was active, since an invalid dangling reference is a settings
 * document validity concern regardless of the browser layer - see its own
 * doc comment.
 */

// ---------------------------------------------------------------------------
// Resolving a target to a secretRef - pure, no I/O
// ---------------------------------------------------------------------------

function findProxyCredentials(
  settings: AppSettings,
  target: ProxyPasswordTarget,
): ProxyCredentials | undefined {
  if (target.kind === 'copilotProxy') {
    return settings.copilotProxy?.credentials;
  }
  return settings.servers.find((server) => server.id === target.serverId)?.proxy?.credentials;
}

/**
 * Resolves a {@link ProxyPasswordTarget} to the `secretRef` already recorded
 * in `settings` for it. Never mints a new `secretRef`: assigning one to a
 * proxy is part of configuring that proxy (username + `secretRef` together),
 * which is a settings mutation reserved for step 05. A target with no proxy
 * credentials configured yet is reported as {@link SettingsIpcError}
 * `"no_proxy_configured"`, not silently created.
 */
export function resolveProxySecretRef(
  settings: AppSettings,
  target: ProxyPasswordTarget,
): Result<string, SettingsIpcError> {
  const credentials = findProxyCredentials(settings, target);
  if (!credentials) {
    return err({
      code: 'no_proxy_configured',
      message:
        target.kind === 'server'
          ? `Server "${target.serverId}" has no proxy credentials configured yet.`
          : 'The global Copilot proxy has no credentials configured yet.',
    });
  }
  return ok(credentials.secretRef);
}

function collectSecretRefs(settings: AppSettings): readonly string[] {
  const refs: string[] = [];
  if (settings.copilotProxy?.credentials) {
    refs.push(settings.copilotProxy.credentials.secretRef);
  }
  for (const server of settings.servers) {
    if (server.proxy?.credentials) {
      refs.push(server.proxy.credentials.secretRef);
    }
  }
  return refs;
}

function storageErrorFrom(message: string): SettingsIpcError {
  return { code: 'storage_error', message };
}

function secretStorageUnavailableErrorFrom(error: unknown): SettingsIpcError {
  return {
    code: 'secret_storage_unavailable',
    message: error instanceof Error ? error.message : String(error),
  };
}

// ---------------------------------------------------------------------------
// Core operations - async, but Electron-free: testable with a real
// settingsStore/secretStore and no live app/window.
// ---------------------------------------------------------------------------

/** Loads settings from `settingsDir` and reports storage failures as a `SettingsIpcError`. */
async function loadSettingsOrError(
  settingsDir: string,
): Promise<Result<AppSettings, SettingsIpcError>> {
  const loaded = await loadSettings(settingsDir);
  if (!loaded.ok) {
    return err(storageErrorFrom(loaded.error.message));
  }
  return ok(loaded.value.settings);
}

/** Implements `settings:get-snapshot`. */
export async function getSettingsSnapshot(
  settingsDir: string,
  secretStore: SecretStore,
): Promise<GetSettingsSnapshotResult> {
  const loaded = await loadSettingsOrError(settingsDir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }
  const settings = loaded.value;

  // `hasStoredSecret` must be synchronous (see `toAppSettingsSnapshot`'s
  // `HasStoredSecret` type), so every `secretRef` this document references is
  // resolved up front into a plain lookup table.
  const hasSecretByRef = new Map<string, boolean>();
  for (const secretRef of collectSecretRefs(settings)) {
    if (!hasSecretByRef.has(secretRef)) {
      hasSecretByRef.set(secretRef, await secretStore.has(secretRef));
    }
  }

  const snapshot = toAppSettingsSnapshot(
    settings,
    (secretRef) => hasSecretByRef.get(secretRef) ?? false,
  );
  return { ok: true, snapshot };
}

/** Implements `settings:set-proxy-password`. Never returns the password. */
export async function setProxyPassword(
  settingsDir: string,
  secretStore: SecretStore,
  request: SetProxyPasswordRequest,
): Promise<SettingsIpcVoidResult> {
  const loaded = await loadSettingsOrError(settingsDir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }
  const secretRef = resolveProxySecretRef(loaded.value, request.target);
  if (!secretRef.ok) {
    return { ok: false, error: secretRef.error };
  }

  try {
    await secretStore.set(secretRef.value, request.password);
  } catch (error) {
    return { ok: false, error: secretStorageUnavailableErrorFrom(error) };
  }
  return { ok: true };
}

/** Implements `settings:clear-proxy-password`. */
export async function clearProxyPassword(
  settingsDir: string,
  secretStore: SecretStore,
  request: ClearProxyPasswordRequest,
): Promise<SettingsIpcVoidResult> {
  const loaded = await loadSettingsOrError(settingsDir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }
  const secretRef = resolveProxySecretRef(loaded.value, request.target);
  if (!secretRef.ok) {
    return { ok: false, error: secretRef.error };
  }

  try {
    await secretStore.delete(secretRef.value);
  } catch (error) {
    return { ok: false, error: secretStorageUnavailableErrorFrom(error) };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Server/proxy mutation - step 05
// ---------------------------------------------------------------------------

/** Reports a `settingsStore.ts` save failure through the same `SettingsIpcError` shape as a load failure. */
async function persist(
  settingsDir: string,
  settings: AppSettings,
): Promise<Result<void, SettingsIpcError>> {
  const saved = await saveSettings(settingsDir, settings);
  if (!saved.ok) {
    return err(storageErrorFrom(saved.error.message));
  }
  return ok(undefined);
}

/**
 * Projects one {@link ServerConfig} the same way {@link getSettingsSnapshot}
 * projects every server for `settings:get-snapshot` - secret-free, with only
 * a `hasStoredPassword` boolean standing in for its proxy credentials, if
 * any. Reused here so every mutation handler below returns the freshly
 * changed server in exactly the shape the renderer already knows how to
 * render, without a second round trip back through `get-snapshot`.
 */
async function toServerSnapshot(
  server: ServerConfig,
  secretStore: SecretStore,
): Promise<ServerSnapshot> {
  const hasStoredPassword = server.proxy?.credentials
    ? await secretStore.has(server.proxy.credentials.secretRef)
    : false;
  const snapshot = toAppSettingsSnapshot(
    { ...defaultAppSettings(), servers: [server], activeServerId: server.id },
    () => hasStoredPassword,
  );
  const projected = snapshot.servers[0];
  if (!projected) {
    // `server` was just placed into `servers` above, so this is unreachable;
    // thrown (not returned as a `Result`) because it signals a bug in this
    // function itself, not a caller-triggerable failure.
    throw new Error('toServerSnapshot: projection lost the server');
  }
  return projected;
}

/** Narrows the 3-way {@link ServerMutationKind} down to the 2-way {@link ServerTargetingMutationKind} `settings:update-server-targeting` reports. `applyServerTargetingChange` never produces `"presentation"`, so that branch is unreachable from this call site. */
function targetingKind(kind: ServerMutationKind): ServerTargetingMutationKind {
  if (kind === 'presentation') {
    throw new Error('applyServerTargetingChange unexpectedly reported a presentation-only change');
  }
  return kind;
}

/** Implements `settings:add-server`. */
export async function addServer(
  settingsDir: string,
  secretStore: SecretStore,
  request: AddServerRequest,
): Promise<AddServerResult> {
  const loaded = await loadSettingsOrError(settingsDir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }

  const newId = newServerId(() => randomUUID());
  const created = createServerEntry(loaded.value, newId, request);
  if (!created.ok) {
    return { ok: false, error: { code: created.error.kind, message: created.error.message } };
  }

  const saved = await persist(settingsDir, created.value.settings);
  if (!saved.ok) {
    return { ok: false, error: saved.error };
  }

  return { ok: true, server: await toServerSnapshot(created.value.server, secretStore) };
}

/** Implements `settings:remove-server`. See `settingsStore.ts`'s `RemoveServerOutcome.wasActive` for what happens when the removed server was the active one. */
export async function removeServer(
  settingsDir: string,
  request: RemoveServerRequest,
): Promise<SettingsIpcVoidResult> {
  const loaded = await loadSettingsOrError(settingsDir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }

  const removed = deleteServerEntry(loaded.value, request.serverId);
  if (!removed.ok) {
    return { ok: false, error: { code: removed.error.kind, message: removed.error.message } };
  }

  const saved = await persist(settingsDir, removed.value.settings);
  if (!saved.ok) {
    return { ok: false, error: saved.error };
  }
  return { ok: true };
}

/**
 * Strips zod's explicit `| undefined` from an optional field of a parsed
 * request before it is passed to a pure `settingsStore.ts` function typed
 * under `exactOptionalPropertyTypes`. A zod `.optional()` field is inferred
 * as `T | undefined`, kept even when the key itself is absent; the target
 * interfaces (`ServerPresentationChanges`, `ServerTargetingChanges`,
 * `SetCopilotProxyInput`) declare `field?: T` with no such explicit
 * `undefined` in the value type, so a present-but-`undefined` key and an
 * absent key are not the same type to the compiler even though they behave
 * identically at runtime. Conditional spread - contributing the key only
 * when the value is not `undefined` - is the only way to build an object
 * literal the compiler accepts as one type without the other, without a cast.
 */

function presentationChangesFrom(
  changes: UpdateServerPresentationRequest['changes'],
): ServerPresentationChanges {
  return {
    ...(changes.label !== undefined ? { label: changes.label } : {}),
    ...(changes.color !== undefined ? { color: changes.color } : {}),
  };
}

/** Implements `settings:update-server-presentation`. */
export async function updateServerPresentation(
  settingsDir: string,
  secretStore: SecretStore,
  request: UpdateServerPresentationRequest,
): Promise<UpdateServerPresentationResult> {
  const loaded = await loadSettingsOrError(settingsDir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }

  const updated = applyServerPresentationChange(
    loaded.value,
    request.serverId,
    presentationChangesFrom(request.changes),
  );
  if (!updated.ok) {
    return { ok: false, error: { code: updated.error.kind, message: updated.error.message } };
  }

  const saved = await persist(settingsDir, updated.value.settings);
  if (!saved.ok) {
    return { ok: false, error: saved.error };
  }

  return { ok: true, server: await toServerSnapshot(updated.value.server, secretStore) };
}

function targetingChangesFrom(
  changes: UpdateServerTargetingRequest['changes'],
): ServerTargetingChanges {
  return {
    ...(changes.origin !== undefined ? { origin: changes.origin } : {}),
    ...(changes.proxy !== undefined ? { proxy: changes.proxy } : {}),
    ...(changes.tlsException !== undefined ? { tlsException: changes.tlsException } : {}),
  };
}

/**
 * Implements `settings:update-server-targeting`. `originChangeConfirmed`
 * confirms the request's own `changes.origin` (see
 * `updateServerTargetingRequestSchema`'s doc comment for why this is safe as
 * a plain boolean rather than a caller-supplied confirmation object).
 */
export async function updateServerTargeting(
  settingsDir: string,
  secretStore: SecretStore,
  request: UpdateServerTargetingRequest,
): Promise<UpdateServerTargetingResult> {
  const loaded = await loadSettingsOrError(settingsDir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }

  const confirmation =
    request.originChangeConfirmed && request.changes.origin !== undefined
      ? confirmOriginChange(request.changes.origin)
      : undefined;

  const updated = applyServerTargetingChange(
    loaded.value,
    request.serverId,
    targetingChangesFrom(request.changes),
    confirmation,
  );
  if (!updated.ok) {
    return { ok: false, error: { code: updated.error.kind, message: updated.error.message } };
  }

  const saved = await persist(settingsDir, updated.value.settings);
  if (!saved.ok) {
    return { ok: false, error: saved.error };
  }

  return {
    ok: true,
    server: await toServerSnapshot(updated.value.server, secretStore),
    kind: targetingKind(updated.value.kind),
  };
}

/**
 * Implements `settings:set-copilot-proxy`. Best-effort deletes an orphaned
 * password (see `settingsStore.ts`'s `UpdateCopilotProxyOutcome.orphanedSecretRef`)
 * the same way `clearProxyPassword` already does for an explicit clear - a
 * failure to delete the now-unreachable secret does not fail the save that
 * already succeeded.
 */
export async function setCopilotProxy(
  settingsDir: string,
  secretStore: SecretStore,
  request: SetCopilotProxyRequest,
): Promise<SettingsIpcVoidResult> {
  const loaded = await loadSettingsOrError(settingsDir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }

  const updated = updateCopilotProxyEntry(loaded.value, {
    url: request.url,
    ...(request.username !== undefined ? { username: request.username } : {}),
  });
  if (!updated.ok) {
    return { ok: false, error: { code: updated.error.kind, message: updated.error.message } };
  }

  const saved = await persist(settingsDir, updated.value.settings);
  if (!saved.ok) {
    return { ok: false, error: saved.error };
  }

  if (updated.value.orphanedSecretRef !== undefined) {
    await secretStore.delete(updated.value.orphanedSecretRef).catch(() => undefined);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Model / reasoning-effort selection (step 09)
// ---------------------------------------------------------------------------

/**
 * How this module reaches the two things the model channels need that the
 * settings file cannot tell it: what Copilot offers, and whether a turn is
 * currently running.
 *
 * Both are functions rather than values so they are evaluated per request.
 * That matters for each in a different way: the catalogue is unreadable until
 * the Copilot runtime has started in the background (well after these handlers
 * are registered), and `isTurnInFlight` must reflect the state at the moment
 * of the call, not at wiring time.
 */
export interface ModelSelectionDependencies {
  /** Reads the SDK model catalogue - in practice `loadModelCatalog(copilotClient)`. */
  readonly loadCatalog: () => Promise<
    Result<readonly ModelCatalogEntry[], { readonly message: string }>
  >;
  /** True while a chat turn is streaming or running a tool. */
  readonly isTurnInFlight: () => boolean;
  /**
   * Called after - and only after - a new preference has been persisted
   * successfully. Lets the composition root keep its synchronous
   * `ModelPreferenceCache` in step with the file without this module knowing
   * anything about the agent service.
   */
  readonly onPreferencesSaved?: (preference: {
    readonly model: string | null;
    readonly reasoningEffort: string | null;
  }) => void;
}

/**
 * Implements `settings:get-model-selection`.
 *
 * An unreadable catalogue is reported inside a successful result
 * (`catalogUnavailable: true`, `models: []`) rather than as a failure - see
 * `getModelSelectionResultSchema`'s own doc comment. Only the settings file
 * being unreadable produces `ok: false`, because in that case there is no
 * stored selection to show either.
 */
export async function getModelSelection(
  settingsDir: string,
  deps: ModelSelectionDependencies,
): Promise<GetModelSelectionResult> {
  const loaded = await loadSettingsOrError(settingsDir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }
  const settings = loaded.value;
  const catalog = await deps.loadCatalog();

  return {
    ok: true,
    state: {
      models: catalog.ok ? catalog.value : [],
      selectedModel: settings.defaultModel,
      selectedReasoningEffort: settings.defaultReasoningEffort,
      changesLocked: deps.isTurnInFlight(),
      catalogUnavailable: !catalog.ok,
    },
  };
}

/**
 * Implements `settings:set-model-preferences`.
 *
 * Three refusals, in this order, and the order is the point:
 *
 *  1. `turn_in_flight` - step 09 requires "disable changes during an active
 *     turn". Checked here and not only in the renderer, because a disabled
 *     picker is a hint and this is the enforcement.
 *  2. `model_catalog_unavailable` - a selection cannot be validated against a
 *     catalogue that could not be read, and storing an unvalidated model would
 *     defer the failure to the next prompt, where it would look like a broken
 *     conversation rather than a rejected setting.
 *  3. `model_not_available` / `unsupported_reasoning_effort` - the model must
 *     be one the SDK actually advertises, and the effort one that model
 *     actually supports.
 *
 * Clearing (`model: null`) skips the catalogue entirely: reverting to "let
 * Copilot choose" must stay possible even when the runtime is unreachable,
 * which is exactly when a user is most likely to want to undo a bad choice.
 */
export async function setModelPreferences(
  settingsDir: string,
  deps: ModelSelectionDependencies,
  request: SetModelPreferencesRequest,
): Promise<SettingsIpcVoidResult> {
  if (deps.isTurnInFlight()) {
    return {
      ok: false,
      error: {
        code: 'turn_in_flight',
        message: 'Finish or stop the current response before changing the model.',
      },
    };
  }

  if (request.model !== null) {
    const catalog = await deps.loadCatalog();
    if (!catalog.ok) {
      return {
        ok: false,
        error: { code: 'model_catalog_unavailable', message: catalog.error.message },
      };
    }
    const models = catalog.value;
    if (!models.some((model) => model.id === request.model)) {
      return {
        ok: false,
        error: {
          code: 'model_not_available',
          message: `Copilot does not currently offer the model "${request.model}".`,
        },
      };
    }
    if (!isReasoningEffortValidFor(models, request.model, request.reasoningEffort)) {
      return {
        ok: false,
        error: {
          code: 'unsupported_reasoning_effort',
          message: `The model "${request.model}" does not support the reasoning effort "${request.reasoningEffort}".`,
        },
      };
    }
  }

  const loaded = await loadSettingsOrError(settingsDir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }

  const updated = updateModelPreferencesEntry(loaded.value, {
    model: request.model,
    reasoningEffort: request.reasoningEffort,
  });
  if (!updated.ok) {
    return { ok: false, error: { code: updated.error.kind, message: updated.error.message } };
  }

  const saved = await persist(settingsDir, updated.value);
  if (!saved.ok) {
    return { ok: false, error: saved.error };
  }
  // After the write, never before: a cache updated ahead of a failed save
  // would send the next prompt to a model the settings file does not record.
  deps.onPreferencesSaved?.({
    model: updated.value.defaultModel,
    reasoningEffort: updated.value.defaultReasoningEffort,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Sender validation - the security core of this module
// ---------------------------------------------------------------------------

/**
 * The information this module actually needs about an IPC caller, reduced to
 * plain data. Deliberately not `IpcMainInvokeEvent`/`WebFrameMain` themselves:
 * those can only be produced by a live Electron renderer, which would force
 * every test of the trust decision itself to stand up a real window. This
 * shape is what {@link isTrustedLocalSettingsSender} checks, and a test can
 * construct one directly.
 */
export interface SettingsIpcSenderInfo {
  /** The sending frame's current URL (`event.senderFrame.url`). */
  readonly url: string;
  /** Whether the sending frame is the top-level frame of its `WebContents`. */
  readonly isMainFrame: boolean;
  /** The sending `WebContents`' id (`event.sender.id`). */
  readonly webContentsId: number;
}

export interface TrustedSenderExpectation {
  /**
   * Whether a `webContents.id` belongs to this app's own local UI. A
   * predicate rather than a single id because the settings surface is served
   * from the one shell window alongside the browser pane (Settings became a
   * panel in the shell, not a separate child window), and keeping a
   * predicate here lets a future surface (e.g. History as a panel) join
   * without re-typing the check. Consulted at call time, not at registration
   * time.
   */
  readonly isTrustedWebContentsId: (webContentsId: number) => boolean;
  /** Passed to `isAllowedAppNavigation` - the same "is this our own local UI?"
   * check the app's navigation guard already uses (`src/main/security.ts`),
   * reused here rather than a second, drifting definition of "local". */
  readonly rendererDistDir: string;
}

/**
 * True only for a request from one of this app's own local windows: a
 * top-level frame of a {@link TrustedSenderExpectation.isTrustedWebContentsId}
 * window, showing a URL {@link isAllowedAppNavigation} recognizes as this
 * app's own local UI (the packaged `file://`/`app://` build, or the
 * electron-vite dev server) - never remote AEM content, and never a request
 * whose sending frame has already navigated away or been destroyed (an absent
 * frame is treated as untrusted, not as a pass).
 */
export function isTrustedLocalSettingsSender(
  sender: SettingsIpcSenderInfo | undefined,
  expectation: TrustedSenderExpectation,
): boolean {
  if (!sender) return false;
  return (
    expectation.isTrustedWebContentsId(sender.webContentsId) &&
    sender.isMainFrame &&
    isAllowedAppNavigation(sender.url, expectation.rendererDistDir)
  );
}

function senderInfoFromInvokeEvent(event: IpcMainInvokeEvent): SettingsIpcSenderInfo | undefined {
  const frame = event.senderFrame;
  // `senderFrame` is `null` once the frame has navigated away or been
  // destroyed (Electron's own documented caveat) - fail closed rather than
  // treating a vanished frame as trusted.
  if (!frame) return undefined;
  return {
    url: frame.url,
    isMainFrame: frame.top === frame,
    webContentsId: event.sender.id,
  };
}

const UNTRUSTED_SENDER_ERROR: SettingsIpcError = {
  code: 'untrusted_sender',
  message: "This request must come from the local app's shell window.",
};

function invalidPayloadError(message: string): SettingsIpcError {
  return { code: 'invalid_payload', message };
}

// ---------------------------------------------------------------------------
// Wiring: registers the three ipcMain.handle channels
// ---------------------------------------------------------------------------

export interface SettingsIpcDependencies {
  readonly settingsDir: string;
  readonly secretStore: SecretStore;
  readonly logger: Logger;
  readonly rendererDistDir: string;
  /** See {@link TrustedSenderExpectation.isTrustedWebContentsId}. */
  readonly isTrustedWebContentsId: (webContentsId: number) => boolean;
  /** Backs the step-09 model/reasoning-effort channels. See {@link ModelSelectionDependencies}. */
  readonly modelSelection: ModelSelectionDependencies;
}

/**
 * Registers the settings IPC handlers. Every handler validates the sender
 * first (rejecting and logging before doing anything else) and every inbound
 * payload is parsed with zod's `safeParse` - never `.parse` - so a malformed
 * payload is reported back as `{ ok: false, error }` instead of throwing a
 * raw error across the IPC boundary.
 */
export function registerSettingsIpcHandlers(deps: SettingsIpcDependencies): void {
  const expectation: TrustedSenderExpectation = {
    isTrustedWebContentsId: deps.isTrustedWebContentsId,
    rendererDistDir: deps.rendererDistDir,
  };

  function checkSender(event: IpcMainInvokeEvent): boolean {
    const trusted = isTrustedLocalSettingsSender(senderInfoFromInvokeEvent(event), expectation);
    if (!trusted) {
      deps.logger.warn('SETTINGS_IPC_SENDER_REJECTED');
    }
    return trusted;
  }

  ipcMain.handle(
    SETTINGS_GET_SNAPSHOT_CHANNEL,
    async (event): Promise<GetSettingsSnapshotResult> => {
      if (!checkSender(event)) {
        return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      }
      return getSettingsSnapshot(deps.settingsDir, deps.secretStore);
    },
  );

  ipcMain.handle(
    SETTINGS_SET_PROXY_PASSWORD_CHANNEL,
    async (event, rawRequest: unknown): Promise<SettingsIpcVoidResult> => {
      if (!checkSender(event)) {
        return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      }
      const parsed = setProxyPasswordRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return { ok: false, error: invalidPayloadError(parsed.error.message) };
      }
      return setProxyPassword(deps.settingsDir, deps.secretStore, parsed.data);
    },
  );

  ipcMain.handle(
    SETTINGS_CLEAR_PROXY_PASSWORD_CHANNEL,
    async (event, rawRequest: unknown): Promise<SettingsIpcVoidResult> => {
      if (!checkSender(event)) {
        return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      }
      const parsed = clearProxyPasswordRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return { ok: false, error: invalidPayloadError(parsed.error.message) };
      }
      return clearProxyPassword(deps.settingsDir, deps.secretStore, parsed.data);
    },
  );

  ipcMain.handle(
    SETTINGS_ADD_SERVER_CHANNEL,
    async (event, rawRequest: unknown): Promise<AddServerResult> => {
      if (!checkSender(event)) {
        return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      }
      const parsed = addServerRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return { ok: false, error: invalidPayloadError(parsed.error.message) };
      }
      return addServer(deps.settingsDir, deps.secretStore, parsed.data);
    },
  );

  ipcMain.handle(
    SETTINGS_REMOVE_SERVER_CHANNEL,
    async (event, rawRequest: unknown): Promise<SettingsIpcVoidResult> => {
      if (!checkSender(event)) {
        return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      }
      const parsed = removeServerRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return { ok: false, error: invalidPayloadError(parsed.error.message) };
      }
      return removeServer(deps.settingsDir, parsed.data);
    },
  );

  ipcMain.handle(
    SETTINGS_UPDATE_SERVER_PRESENTATION_CHANNEL,
    async (event, rawRequest: unknown): Promise<UpdateServerPresentationResult> => {
      if (!checkSender(event)) {
        return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      }
      const parsed = updateServerPresentationRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return { ok: false, error: invalidPayloadError(parsed.error.message) };
      }
      return updateServerPresentation(deps.settingsDir, deps.secretStore, parsed.data);
    },
  );

  ipcMain.handle(
    SETTINGS_UPDATE_SERVER_TARGETING_CHANNEL,
    async (event, rawRequest: unknown): Promise<UpdateServerTargetingResult> => {
      if (!checkSender(event)) {
        return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      }
      const parsed = updateServerTargetingRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return { ok: false, error: invalidPayloadError(parsed.error.message) };
      }
      return updateServerTargeting(deps.settingsDir, deps.secretStore, parsed.data);
    },
  );

  ipcMain.handle(
    SETTINGS_SET_COPILOT_PROXY_CHANNEL,
    async (event, rawRequest: unknown): Promise<SettingsIpcVoidResult> => {
      if (!checkSender(event)) {
        return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      }
      const parsed = setCopilotProxyRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return { ok: false, error: invalidPayloadError(parsed.error.message) };
      }
      return setCopilotProxy(deps.settingsDir, deps.secretStore, parsed.data);
    },
  );

  ipcMain.handle(
    SETTINGS_GET_MODEL_SELECTION_CHANNEL,
    async (event): Promise<GetModelSelectionResult> => {
      if (!checkSender(event)) {
        return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      }
      return getModelSelection(deps.settingsDir, deps.modelSelection);
    },
  );

  ipcMain.handle(
    SETTINGS_SET_MODEL_PREFERENCES_CHANNEL,
    async (event, rawRequest: unknown): Promise<SettingsIpcVoidResult> => {
      if (!checkSender(event)) {
        return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      }
      const parsed = setModelPreferencesRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return { ok: false, error: invalidPayloadError(parsed.error.message) };
      }
      return setModelPreferences(deps.settingsDir, deps.modelSelection, parsed.data);
    },
  );
}
