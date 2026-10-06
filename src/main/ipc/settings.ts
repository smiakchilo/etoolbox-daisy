import { randomUUID } from 'node:crypto';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  SETTINGS_ADD_PROXY_CHANNEL,
  SETTINGS_ADD_SERVER_CHANNEL,
  SETTINGS_CLEAR_PASSWORD_CHANNEL,
  SETTINGS_GET_SNAPSHOT_CHANNEL,
  SETTINGS_GET_MODEL_SELECTION_CHANNEL,
  SETTINGS_REMOVE_PROXY_CHANNEL,
  SETTINGS_REMOVE_SERVER_CHANNEL,
  SETTINGS_REORDER_PROXIES_CHANNEL,
  SETTINGS_REORDER_SERVERS_CHANNEL,
  SETTINGS_SET_AGENT_SETTINGS_CHANNEL,
  SETTINGS_SET_MODEL_PREFERENCES_CHANNEL,
  SETTINGS_SET_PASSWORD_CHANNEL,
  SETTINGS_UPDATE_BROWSER_SETTINGS_CHANNEL,
  SETTINGS_UPDATE_PROXY_CHANNEL,
  SETTINGS_UPDATE_SERVER_PRESENTATION_CHANNEL,
  SETTINGS_UPDATE_SERVER_TARGETING_CHANNEL,
} from '../../shared';
import {
  addProxyRequestSchema,
  addServerRequestSchema,
  clearPasswordRequestSchema,
  removeProxyRequestSchema,
  removeServerRequestSchema,
  reorderProxiesRequestSchema,
  reorderServersRequestSchema,
  setAgentSettingsRequestSchema,
  setModelPreferencesRequestSchema,
  setPasswordRequestSchema,
  updateBrowserSettingsRequestSchema,
  updateProxyRequestSchema,
  updateServerPresentationRequestSchema,
  updateServerTargetingRequestSchema,
  type AddProxyRequest,
  type AddProxyResult,
  type AddServerRequest,
  type AddServerResult,
  type AgentId,
  type AuthPresence,
  type ClearPasswordRequest,
  type GetModelSelectionResult,
  type GetSettingsSnapshotResult,
  type PasswordTarget,
  type ProxySnapshot,
  type RemoveProxyRequest,
  type RemoveServerRequest,
  type ReorderProxiesRequest,
  type ReorderServersRequest,
  type ServerTargetingMutationKind,
  type SetAgentSettingsRequest,
  type SetModelPreferencesRequest,
  type SetPasswordRequest,
  type SettingsIpcError,
  type SettingsIpcVoidResult,
  type UpdateBrowserSettingsRequest,
  type UpdateProxyRequest,
  type UpdateServerPresentationRequest,
  type UpdateServerPresentationResult,
  type UpdateServerTargetingRequest,
  type UpdateServerTargetingResult,
} from '../../shared';
import { toAppSettingsSnapshot, type ServerSnapshot } from '../../shared';
import { defaultAppSettings, type AppSettings } from '../../shared';
import { isReasoningEffortValidFor, type ModelCatalogEntry } from '../../shared';
import type {
  ProxyConfig,
  ProxyCredentials,
  ServerConfig,
  ServerPresentationChanges,
  ServerTargetingChanges,
} from '../../shared';
import { newProxyId, newServerId } from '../../shared';
import { isKnownAgentId, type AgentDefinition } from '../../shared';
import { err, ok, type Result } from '../../shared';
import {
  configuredAgentId,
  agentTokenSecretRef,
  addProxy as createProxyEntry,
  addServer as createServerEntry,
  applyBrowserSettingsChange,
  applyServerPresentationChange,
  applyServerTargetingChange,
  confirmOriginChange,
  loadSettings,
  removeProxy as deleteProxyEntry,
  removeServer as deleteServerEntry,
  reorderProxies as reorderProxyEntries,
  reorderServers as reorderServerEntries,
  saveSettings,
  updateAgentSettings as updateAgentSettingsEntry,
  updateAgentToken as updateAgentTokenEntry,
  updateModelPreferences as updateModelPreferencesEntry,
  updateProxy as updateProxyEntry,
  type AgentSettingsChanges,
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
 *  - `settings:set-password` / `settings:clear-password` -
 *    write-only password storage, never echoed back.
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
 * here: choosing the active server is tied to actually switching the live AEM
 * view (`browser:switch-server` in `ipc/browser.ts`), which this module must
 * not reach into (see that module's own `BrowserController`). The active host
 * is not persisted at all - it lives in the browser controller's memory - so
 * there is no settings field for a removal to keep consistent.
 */

// ---------------------------------------------------------------------------
// Resolving a target to a secretRef - pure, no I/O
// ---------------------------------------------------------------------------

function findProxyCredentials(
  settings: AppSettings,
  target: PasswordTarget,
): ProxyCredentials | undefined {
  if (target.kind === 'proxy') {
    return settings.proxies.find((proxy) => proxy.id === target.proxyId)?.credentials;
  }
  return undefined;
}

/**
 * Resolves a {@link PasswordTarget} to the `secretRef` already recorded in
 * `settings` for it. Never mints a new `secretRef`: assigning one to a proxy
 * is part of configuring that proxy (username + `secretRef` together), and an
 * agent's token reference is minted by the set call itself (see
 * {@link setAgentTokenSecret}). A target with nothing recorded yet is reported
 * as a typed `SettingsIpcError` (`"no_proxy_configured"` /
 * `"no_token_configured"`), not silently created.
 */
export function resolvePasswordSecretRef(
  settings: AppSettings,
  target: PasswordTarget,
): Result<string, SettingsIpcError> {
  if (target.kind === 'agent') {
    const secretRef = settings.agents[target.agentId]?.token?.secretRef;
    if (secretRef === undefined) {
      return err({
        code: 'no_token_configured',
        message: `Agent "${target.agentId}" has no token configured yet`,
      });
    }
    return ok(secretRef);
  }

  const credentials = findProxyCredentials(settings, target);
  if (!credentials) {
    return err({
      code: 'no_proxy_configured',
      message: `Proxy "${target.proxyId}" has no username configured yet`,
    });
  }
  return ok(credentials.secretRef);
}

function collectSecretRefs(settings: AppSettings): readonly string[] {
  const refs: string[] = [];
  for (const proxy of settings.proxies) {
    if (proxy.credentials) {
      refs.push(proxy.credentials.secretRef);
    }
  }
  for (const node of Object.values(settings.agents)) {
    if (node.token) {
      refs.push(node.token.secretRef);
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

/**
 * Stores an agent's personal-access token. On the first set the persisted
 * `token` reference is minted (deterministically, from the agent id) and
 * saved, so the snapshot can resolve `hasToken` for it; later sets just
 * overwrite the secret. The token is never validated - the app deliberately
 * does not check it - and never echoed back.
 *
 * Ordering matters: the secret is written first, then the reference is
 * persisted, and a failed persist rolls the freshly-written secret back, so
 * neither a crash nor a failure can leave a reference pointing at a missing
 * secret while also losing the token.
 */
async function setAgentTokenSecret(
  settingsDir: string,
  settings: AppSettings,
  secretStore: SecretStore,
  agentId: AgentId,
  token: string,
  definitions: readonly AgentDefinition[],
): Promise<SettingsIpcVoidResult> {
  if (!isKnownAgentId(agentId, definitions)) {
    return {
      ok: false,
      error: {
        code: 'agent_not_found',
        message: `"${agentId}" is not an agent this build supports`,
      },
    };
  }

  const existingRef = settings.agents[agentId]?.token?.secretRef;

  if (existingRef !== undefined) {
    try {
      await secretStore.set(existingRef, token);
    } catch (error) {
      return { ok: false, error: secretStorageUnavailableErrorFrom(error) };
    }
    return { ok: true };
  }

  const secretRef = agentTokenSecretRef(agentId);
  try {
    await secretStore.set(secretRef, token);
  } catch (error) {
    return { ok: false, error: secretStorageUnavailableErrorFrom(error) };
  }

  const updated = updateAgentTokenEntry(settings, agentId, { secretRef });
  if (!updated.ok) {
    await secretStore.delete(secretRef).catch(() => undefined);
    return { ok: false, error: { code: updated.error.kind, message: updated.error.message } };
  }
  const saved = await persist(settingsDir, updated.value);
  if (!saved.ok) {
    await secretStore.delete(secretRef).catch(() => undefined);
    return { ok: false, error: saved.error };
  }
  return { ok: true };
}

/**
 * Applies the token-clear activation rule: a provider whose only credential was
 * the token it just lost must not stay active. It is switched off in the same
 * write, so the settings document never records an active provider that cannot
 * serve - and the active badge, the composer gate and the hub all agree.
 *
 * An interactive provider may still hold an SSO session that outlives the token
 * (Copilot's own vault/config sign-in); `hasSsoSession` reports that cheap,
 * non-starting fact, and the `active` flag is kept when it is true. A token-only
 * provider has no such session, so it is always deactivated. A provider that
 * needs no authentication is never touched.
 */
async function deactivateIfTokenWasTheOnlyCredential(
  settings: AppSettings,
  agentId: AgentId,
  definitions: readonly AgentDefinition[],
  hasSsoSession: ((agentId: AgentId) => Promise<boolean>) | undefined,
): Promise<AppSettings> {
  const definition = definitions.find((candidate) => candidate.id === agentId);
  if (definition?.requiresAuth !== true) return settings;
  if (settings.agents[agentId]?.active !== true) return settings;
  if (definition.supportsInteractiveLogin && (await hasSsoSession?.(agentId)) === true) {
    return settings;
  }
  const deactivated = updateAgentSettingsEntry(settings, agentId, { active: false });
  return deactivated.ok ? deactivated.value : settings;
}

/**
 * Removes an agent's token reference and its stored secret (best effort), and
 * switches the provider off when the token was its only credential (see
 * {@link deactivateIfTokenWasTheOnlyCredential}).
 */
async function clearAgentTokenSecret(
  settingsDir: string,
  settings: AppSettings,
  secretStore: SecretStore,
  agentId: AgentId,
  definitions: readonly AgentDefinition[],
  hasSsoSession?: (agentId: AgentId) => Promise<boolean>,
): Promise<SettingsIpcVoidResult> {
  if (!isKnownAgentId(agentId, definitions)) {
    return {
      ok: false,
      error: {
        code: 'agent_not_found',
        message: `"${agentId}" is not an agent this build supports`,
      },
    };
  }

  const existingRef = settings.agents[agentId]?.token?.secretRef;
  if (existingRef === undefined) {
    return {
      ok: false,
      error: {
        code: 'no_token_configured',
        message: `Agent "${agentId}" has no token configured yet`,
      },
    };
  }

  const updated = updateAgentTokenEntry(settings, agentId, null);
  if (!updated.ok) {
    return { ok: false, error: { code: updated.error.kind, message: updated.error.message } };
  }
  const next = await deactivateIfTokenWasTheOnlyCredential(
    updated.value,
    agentId,
    definitions,
    hasSsoSession,
  );
  const saved = await persist(settingsDir, next);
  if (!saved.ok) {
    return { ok: false, error: saved.error };
  }
  await secretStore.delete(existingRef).catch(() => undefined);
  return { ok: true };
}

/**
 * Implements `settings:set-password`. Never returns the password.
 *
 * `onAgentTokenChanged` is invoked only after an agent token has actually been
 * stored. The Copilot runtime resolves its credential once, at process start,
 * so the caller (the composition root) recycles it - a plain proxied password
 * needs no such notice, because the runtime does not consume it.
 */
export async function setPassword(
  settingsDir: string,
  secretStore: SecretStore,
  request: SetPasswordRequest,
  definitions: readonly AgentDefinition[],
  onAgentTokenChanged?: () => void,
): Promise<SettingsIpcVoidResult> {
  const loaded = await loadSettingsOrError(settingsDir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }

  if (request.target.kind === 'agent') {
    const result = await setAgentTokenSecret(
      settingsDir,
      loaded.value,
      secretStore,
      request.target.agentId,
      request.password,
      definitions,
    );
    if (result.ok) onAgentTokenChanged?.();
    return result;
  }

  const secretRef = resolvePasswordSecretRef(loaded.value, request.target);
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

/**
 * Implements `settings:clear-password`. `onAgentTokenChanged` mirrors
 * {@link setPassword}: the runtime must be recycled so the cleared token is
 * not still in the running process's environment.
 *
 * `hasSsoSession` is the cheap, non-starting check that lets an interactive
 * provider keep its `active` flag when an SSO session outlives the cleared
 * token; see {@link deactivateIfTokenWasTheOnlyCredential}.
 */
export async function clearPassword(
  settingsDir: string,
  secretStore: SecretStore,
  request: ClearPasswordRequest,
  definitions: readonly AgentDefinition[],
  onAgentTokenChanged?: () => void,
  hasSsoSession?: (agentId: AgentId) => Promise<boolean>,
): Promise<SettingsIpcVoidResult> {
  const loaded = await loadSettingsOrError(settingsDir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }

  if (request.target.kind === 'agent') {
    const result = await clearAgentTokenSecret(
      settingsDir,
      loaded.value,
      secretStore,
      request.target.agentId,
      definitions,
      hasSsoSession,
    );
    if (result.ok) onAgentTokenChanged?.();
    return result;
  }

  const secretRef = resolvePasswordSecretRef(loaded.value, request.target);
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
 * projects every server for `settings:get-snapshot`. A host carries no secret
 * of its own - its proxy selection is a library entry id, and any password
 * belongs to that entry - so no `secretStore` lookup is needed here. Reused so
 * every mutation handler below returns the freshly changed server in exactly
 * the shape the renderer already knows how to render, without a second round
 * trip back through `get-snapshot`.
 */
function toServerSnapshot(server: ServerConfig): ServerSnapshot {
  const snapshot = toAppSettingsSnapshot({ ...defaultAppSettings(), hosts: [server] }, () => false);
  const projected = snapshot.hosts[0];
  if (!projected) {
    // `server` was just placed into `hosts` above, so this is unreachable;
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
  const created = createServerEntry(loaded.value, newId, {
    label: request.label,
    origin: request.origin,
    color: request.color,
    ...(request.contentRoots !== undefined ? { contentRoots: request.contentRoots } : {}),
    ...(request.componentRoots !== undefined ? { componentRoots: request.componentRoots } : {}),
  });
  if (!created.ok) {
    return { ok: false, error: { code: created.error.kind, message: created.error.message } };
  }

  const saved = await persist(settingsDir, created.value.settings);
  if (!saved.ok) {
    return { ok: false, error: saved.error };
  }

  return { ok: true, server: toServerSnapshot(created.value.server) };
}

/** Implements `settings:remove-server`. */
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

  const saved = await persist(settingsDir, removed.value);
  if (!saved.ok) {
    return { ok: false, error: saved.error };
  }
  return { ok: true };
}

/**
 * Implements `settings:reorder-servers`. The requested order is validated as a
 * permutation of the configured servers by `settingsStore.ts`'s
 * `reorderServers`; a mismatch is `invalid_change` (the store's
 * `ServerMutationError` kinds are a subset of `SettingsIpcErrorCode`).
 */
export async function reorderServers(
  settingsDir: string,
  request: ReorderServersRequest,
): Promise<SettingsIpcVoidResult> {
  const loaded = await loadSettingsOrError(settingsDir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }

  const reordered = reorderServerEntries(loaded.value, request.serverIds);
  if (!reordered.ok) {
    return { ok: false, error: { code: reordered.error.kind, message: reordered.error.message } };
  }

  const saved = await persist(settingsDir, reordered.value);
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
 * `NewProxyInput`) declare `field?: T` with no such explicit
 * `undefined` in the value type, so a present-but-`undefined` key and an
 * absent key are not the same type to the compiler even though they behave
 * identically at runtime. Conditional spread - contributing the key only
 * when the value is not `undefined` - is the only way to build an object
 * literal the compiler accepts as one type without the other, without a cast.
 */

function agentSettingsChangesFrom(
  changes: SetAgentSettingsRequest['changes'],
): AgentSettingsChanges {
  return {
    ...(changes.active !== undefined ? { active: changes.active } : {}),
    ...(changes.proxy !== undefined ? { proxy: changes.proxy } : {}),
    ...(changes.model !== undefined ? { model: changes.model } : {}),
    ...(changes.reasoningEffort !== undefined ? { reasoningEffort: changes.reasoningEffort } : {}),
  };
}

function presentationChangesFrom(
  changes: UpdateServerPresentationRequest['changes'],
): ServerPresentationChanges {
  return {
    ...(changes.label !== undefined ? { label: changes.label } : {}),
    ...(changes.color !== undefined ? { color: changes.color } : {}),
    ...(changes.contentRoots !== undefined ? { contentRoots: changes.contentRoots } : {}),
    ...(changes.componentRoots !== undefined ? { componentRoots: changes.componentRoots } : {}),
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

  return { ok: true, server: toServerSnapshot(updated.value.server) };
}

function targetingChangesFrom(
  changes: UpdateServerTargetingRequest['changes'],
): ServerTargetingChanges {
  return {
    ...(changes.origin !== undefined ? { origin: changes.origin } : {}),
    ...(changes.proxyId !== undefined ? { proxyId: changes.proxyId } : {}),
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
    server: toServerSnapshot(updated.value.server),
    kind: targetingKind(updated.value.kind),
  };
}

/**
 * Projects one proxy-library entry the same secret-free way
 * {@link getSettingsSnapshot} projects every proxy, so `settings:add-proxy`
 * returns the freshly-created entry in the shape the renderer already knows
 * how to render - without a second round trip back through `get-snapshot`.
 */
async function toProxySnapshot(
  proxy: ProxyConfig,
  secretStore: SecretStore,
): Promise<ProxySnapshot> {
  const hasStoredPassword = proxy.credentials
    ? await secretStore.has(proxy.credentials.secretRef)
    : false;
  const snapshot = toAppSettingsSnapshot(
    { ...defaultAppSettings(), proxies: [proxy] },
    () => hasStoredPassword,
  );
  const projected = snapshot.proxies[0];
  if (!projected) {
    // `proxy` was just placed into `proxies` above, so this is unreachable;
    // thrown (not returned as a `Result`) because it signals a bug in this
    // function itself, not a caller-triggerable failure.
    throw new Error('toProxySnapshot: projection lost the proxy');
  }
  return projected;
}

/** Implements `settings:add-proxy`. */
export async function addProxy(
  settingsDir: string,
  secretStore: SecretStore,
  request: AddProxyRequest,
): Promise<AddProxyResult> {
  const loaded = await loadSettingsOrError(settingsDir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }

  const newId = newProxyId(() => randomUUID());
  const created = createProxyEntry(loaded.value, newId, {
    label: request.label,
    url: request.url,
    ...(request.username !== undefined ? { username: request.username } : {}),
  });
  if (!created.ok) {
    return { ok: false, error: { code: created.error.kind, message: created.error.message } };
  }

  const saved = await persist(settingsDir, created.value.settings);
  if (!saved.ok) {
    return { ok: false, error: saved.error };
  }

  return { ok: true, proxy: await toProxySnapshot(created.value.proxy, secretStore) };
}

/**
 * Implements `settings:update-proxy`. Best-effort deletes an orphaned
 * password (see `settingsStore.ts`'s `UpdateProxyOutcome.orphanedSecretRef`)
 * the same way `clearPassword` already does for an explicit clear - a
 * failure to delete the now-unreachable secret does not fail the save that
 * already succeeded.
 */
export async function updateProxy(
  settingsDir: string,
  secretStore: SecretStore,
  request: UpdateProxyRequest,
): Promise<SettingsIpcVoidResult> {
  const loaded = await loadSettingsOrError(settingsDir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }

  const updated = updateProxyEntry(loaded.value, request.proxyId, {
    label: request.label,
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

/** Implements `settings:remove-proxy`. Best-effort deletes the removed entry's orphaned password. */
export async function removeProxy(
  settingsDir: string,
  secretStore: SecretStore,
  request: RemoveProxyRequest,
): Promise<SettingsIpcVoidResult> {
  const loaded = await loadSettingsOrError(settingsDir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }

  const removed = deleteProxyEntry(loaded.value, request.proxyId);
  if (!removed.ok) {
    return { ok: false, error: { code: removed.error.kind, message: removed.error.message } };
  }

  const saved = await persist(settingsDir, removed.value.settings);
  if (!saved.ok) {
    return { ok: false, error: saved.error };
  }

  if (removed.value.orphanedSecretRef !== undefined) {
    await secretStore.delete(removed.value.orphanedSecretRef).catch(() => undefined);
  }
  return { ok: true };
}

/** Implements `settings:reorder-proxies`. The requested order is validated as a permutation by `settingsStore.ts`'s `reorderProxies`. */
export async function reorderProxies(
  settingsDir: string,
  request: ReorderProxiesRequest,
): Promise<SettingsIpcVoidResult> {
  const loaded = await loadSettingsOrError(settingsDir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }

  const reordered = reorderProxyEntries(loaded.value, request.proxyIds);
  if (!reordered.ok) {
    return { ok: false, error: { code: reordered.error.kind, message: reordered.error.message } };
  }

  const saved = await persist(settingsDir, reordered.value);
  if (!saved.ok) {
    return { ok: false, error: saved.error };
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
  /** The discovered agents; decides which node is the configured one. */
  readonly definitions: readonly AgentDefinition[];
  /** Reads the SDK model catalogue - in practice the configured agent's runtime `loadModelCatalog`. */
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
  const agentId = configuredAgentId(settings, deps.definitions);
  if (agentId === undefined) {
    return {
      ok: true,
      state: {
        models: [],
        selectedModel: null,
        selectedReasoningEffort: null,
        changesLocked: deps.isTurnInFlight(),
        catalogUnavailable: true,
      },
    };
  }
  const catalog = await deps.loadCatalog();
  const configuredNode = settings.agents[agentId];

  return {
    ok: true,
    state: {
      models: catalog.ok ? catalog.value : [],
      selectedModel: configuredNode?.model ?? null,
      selectedReasoningEffort: configuredNode?.reasoningEffort ?? null,
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
        message: 'Finish or stop the current response before changing the model',
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
          message: `The agent does not currently offer the model "${request.model}"`,
        },
      };
    }
    if (!isReasoningEffortValidFor(models, request.model, request.reasoningEffort)) {
      return {
        ok: false,
        error: {
          code: 'unsupported_reasoning_effort',
          message: `The model "${request.model}" does not support the reasoning effort "${request.reasoningEffort}"`,
        },
      };
    }
  }

  const loaded = await loadSettingsOrError(settingsDir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }

  const agentId = configuredAgentId(loaded.value, deps.definitions);
  if (agentId === undefined) {
    return { ok: false, error: { code: 'agent_not_found', message: 'No agent is available' } };
  }
  const updated = updateModelPreferencesEntry(loaded.value, agentId, {
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
  const savedNode = updated.value.agents[agentId];
  deps.onPreferencesSaved?.({
    model: savedNode?.model ?? null,
    reasoningEffort: savedNode?.reasoningEffort ?? null,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Agent settings (the "Agents" surface)
// ---------------------------------------------------------------------------

/**
 * How the agent-settings channel reaches the two things the settings file
 * cannot tell it: whether a turn currently locks changes, and what the runtime
 * layer must do about a yes/no/proxy/recycle decision. Both are functions
 * evaluated per request, for the same reasons as
 * {@link ModelSelectionDependencies}.
 */
export interface AgentSettingsDependencies {
  /** The discovered agents; an id outside this list is `agent_not_found`. */
  readonly definitions: readonly AgentDefinition[];
  /** Reads the SDK model catalogue - in practice the configured agent's runtime `loadModelCatalog`. */
  readonly loadCatalog: () => Promise<
    Result<readonly ModelCatalogEntry[], { readonly message: string }>
  >;
  /** True while a chat turn is streaming or running a tool. */
  readonly isTurnInFlight: () => boolean;
  /**
   * Called after - and only after - an agent-settings change has been
   * persisted successfully, with the whole new document. The composition root
   * decides whether the change requires recycling the Copilot runtime (a proxy
   * or active-provider change does; a model/effort change does not) - see
   * `agents/copilot/runtimeManager.ts`. Never called on a failed save, so the runtime
   * is never recycled for a change the file does not record.
   *
   * The handler awaits the returned promise before reporting the write as done.
   * An active-provider switch therefore does not resolve until the hub has
   * switched runtimes, so the renderer's follow-up snapshot reload reads a
   * runtime that is actually ready (otherwise its auth/model reads race the
   * still-starting new runtime and the Model/Reasoning pickers stay disabled).
   */
  readonly onAgentSettingsSaved: (settings: AppSettings) => void | Promise<void>;
}

/**
 * Implements `settings:set-agent-settings`.
 *
 * Refusals, in this order, and the order matters:
 *
 *  1. `turn_in_flight` - step 09's "disable changes during an active turn"
 *     applies to the agent item as a whole (the proxy picker locks with the
 *     rest); the renderer disabling the controls is a courtesy, this is the
 *     enforcement.
 *  2. `agent_not_found` - the id must name a provider this build actually
 *     implements, not merely one a (possibly newer) settings file mentions.
 *  3. `proxy_not_found` - a named proxy must exist, or the document would fail
 *     its own schema as `invalid_change` for a reason the user cannot act on.
 *  4. `model_catalog_unavailable` / `model_not_available` /
 *     `unsupported_reasoning_effort` - the same catalogue validation
 *     `settings:set-model-preferences` performs, against the model/effort the
 *     document would hold *after* this change (so setting an effort alone is
 *     checked against the model already stored). Consulted only when the
 *     request actually chooses a model or an effort: a proxy or
 *     active-provider change must be persistable even when the catalogue
 *     cannot be read, because that is exactly the state a user is in when
 *     changing the proxy to restore connectivity. Validating the *stored*
 *     model against the *old* runtime's unreadable catalogue is what used to
 *     refuse the very write that would have fixed the connection.
 *
 * Clearing (`model: null`, `proxy: null`) skips catalogue validation for that
 * field: reverting to "let Copilot choose" must stay possible even when the
 * runtime is unreachable, which is when a user is most likely to want to undo.
 */
export async function setAgentSettings(
  settingsDir: string,
  deps: AgentSettingsDependencies,
  request: SetAgentSettingsRequest,
): Promise<SettingsIpcVoidResult> {
  if (deps.isTurnInFlight()) {
    return {
      ok: false,
      error: {
        code: 'turn_in_flight',
        message: 'Finish or stop the current response before changing agent settings',
      },
    };
  }

  if (!isKnownAgentId(request.agentId, deps.definitions)) {
    return {
      ok: false,
      error: {
        code: 'agent_not_found',
        message: `"${request.agentId}" is not an agent this build supports`,
      },
    };
  }

  const loaded = await loadSettingsOrError(settingsDir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }
  const existingNode = loaded.value.agents[request.agentId];

  const { changes } = request;
  if (changes.proxy !== undefined && changes.proxy !== null) {
    if (!loaded.value.proxies.some((proxy) => proxy.id === changes.proxy)) {
      return {
        ok: false,
        error: {
          code: 'proxy_not_found',
          message: `No proxy with id "${changes.proxy}" is configured`,
        },
      };
    }
  }

  // Catalogue validation applies only when this request actually chooses a
  // model or a reasoning effort. A proxy or active-provider change is about
  // *reaching* Copilot, not about which model to use, so it must be persistable
  // while the catalogue is unreadable - which is precisely the state a user is
  // in when changing the proxy to fix connectivity. Refusing the proxy write
  // because the old runtime cannot read the catalogue is backwards.
  const choosesModelOrEffort = changes.model !== undefined || changes.reasoningEffort !== undefined;

  // The model/effort the document would hold after this change, so a change to
  // either alone is validated against the other as it currently stands.
  const effectiveModel =
    changes.model === undefined
      ? existingNode?.model
      : changes.model === null
        ? undefined
        : changes.model;
  const effectiveEffort =
    changes.reasoningEffort === undefined
      ? existingNode?.reasoningEffort
      : changes.reasoningEffort === null
        ? undefined
        : changes.reasoningEffort;

  if (choosesModelOrEffort && effectiveModel !== undefined) {
    const catalog = await deps.loadCatalog();
    if (!catalog.ok) {
      return {
        ok: false,
        error: { code: 'model_catalog_unavailable', message: catalog.error.message },
      };
    }
    const models = catalog.value;
    if (!models.some((model) => model.id === effectiveModel)) {
      return {
        ok: false,
        error: {
          code: 'model_not_available',
          message: `The agent does not currently offer the model "${effectiveModel}"`,
        },
      };
    }
    if (!isReasoningEffortValidFor(models, effectiveModel, effectiveEffort ?? null)) {
      return {
        ok: false,
        error: {
          code: 'unsupported_reasoning_effort',
          message: `The model "${effectiveModel}" does not support the reasoning effort "${String(effectiveEffort)}"`,
        },
      };
    }
  }

  const updated = updateAgentSettingsEntry(
    loaded.value,
    request.agentId,
    agentSettingsChangesFrom(changes),
  );
  if (!updated.ok) {
    return { ok: false, error: { code: updated.error.kind, message: updated.error.message } };
  }

  const saved = await persist(settingsDir, updated.value);
  if (!saved.ok) {
    return { ok: false, error: saved.error };
  }
  // Awaited, not fired and forgotten: switching the active provider (or
  // recycling it for a proxy) must have completed before this write is reported
  // as done, so the renderer's follow-up reload reads a runtime that is ready
  // rather than one still starting. See `onAgentSettingsSaved`.
  await deps.onAgentSettingsSaved(updated.value);
  return { ok: true };
}

/**
 * Implements `settings:update-browser-settings`.
 *
 * Persists the Browser tab's flags. Unlike the agent-settings channel there is
 * nothing to validate against a live runtime and nothing to recycle: the flag
 * is consumed at the next startup (`src/main/index.ts`), so this is a plain
 * load -> patch -> save. A no-op patch is already refused by the request schema.
 */
export async function updateBrowserSettings(
  settingsDir: string,
  request: UpdateBrowserSettingsRequest,
): Promise<SettingsIpcVoidResult> {
  const loaded = await loadSettingsOrError(settingsDir);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }

  // A named default proxy must exist, or the document would fail its own
  // schema as `invalid_change` for a reason the user cannot act on - the same
  // guard `setAgentSettings` applies to an agent's proxy.
  const { proxy } = request.changes;
  if (proxy !== undefined && proxy !== null) {
    if (!loaded.value.proxies.some((entry) => entry.id === proxy)) {
      return {
        ok: false,
        error: {
          code: 'proxy_not_found',
          message: `No proxy with id "${proxy}" is configured`,
        },
      };
    }
  }

  const saved = await persist(
    settingsDir,
    applyBrowserSettingsChange(loaded.value, request.changes),
  );
  if (!saved.ok) {
    return { ok: false, error: saved.error };
  }
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
  message: "This request must come from the local app's shell window",
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
  /** Backs the agent-settings channel. See {@link AgentSettingsDependencies}. */
  readonly agentSettings: AgentSettingsDependencies;
  /** The discovered agents, for the agent-token channels. */
  readonly agentDefinitions: readonly AgentDefinition[];
  /**
   * Cheap, non-starting sign-in presence per provider. Consulted only when a
   * token is cleared: an interactive provider that still has an SSO session
   * keeps its `active` flag, every other provider is switched off in the same
   * write. Never starts a provider's runtime.
   */
  readonly getAgentAuthPresence: (agentId: AgentId) => Promise<AuthPresence>;
  /**
   * Called after an agent personal-access token has been successfully set or
   * cleared. The Copilot runtime resolves its credential once, at process
   * start, so a token change needs an unconditional recycle - which the
   * composition root performs (the agent hub's `refresh`). Deliberately
   * not called for a server/proxy password (the runtime does not consume one),
   * nor on a failed change.
   */
  readonly onAgentTokenChanged?: () => void;
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
    SETTINGS_SET_PASSWORD_CHANNEL,
    async (event, rawRequest: unknown): Promise<SettingsIpcVoidResult> => {
      if (!checkSender(event)) {
        return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      }
      const parsed = setPasswordRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return { ok: false, error: invalidPayloadError(parsed.error.message) };
      }
      return setPassword(
        deps.settingsDir,
        deps.secretStore,
        parsed.data,
        deps.agentDefinitions,
        deps.onAgentTokenChanged,
      );
    },
  );

  ipcMain.handle(
    SETTINGS_CLEAR_PASSWORD_CHANNEL,
    async (event, rawRequest: unknown): Promise<SettingsIpcVoidResult> => {
      if (!checkSender(event)) {
        return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      }
      const parsed = clearPasswordRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return { ok: false, error: invalidPayloadError(parsed.error.message) };
      }
      return clearPassword(
        deps.settingsDir,
        deps.secretStore,
        parsed.data,
        deps.agentDefinitions,
        deps.onAgentTokenChanged,
        (agentId) => deps.getAgentAuthPresence(agentId).then((presence) => presence.present),
      );
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
    SETTINGS_REORDER_SERVERS_CHANNEL,
    async (event, rawRequest: unknown): Promise<SettingsIpcVoidResult> => {
      if (!checkSender(event)) {
        return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      }
      const parsed = reorderServersRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return { ok: false, error: invalidPayloadError(parsed.error.message) };
      }
      return reorderServers(deps.settingsDir, parsed.data);
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
    SETTINGS_ADD_PROXY_CHANNEL,
    async (event, rawRequest: unknown): Promise<AddProxyResult> => {
      if (!checkSender(event)) {
        return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      }
      const parsed = addProxyRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return { ok: false, error: invalidPayloadError(parsed.error.message) };
      }
      return addProxy(deps.settingsDir, deps.secretStore, parsed.data);
    },
  );

  ipcMain.handle(
    SETTINGS_UPDATE_PROXY_CHANNEL,
    async (event, rawRequest: unknown): Promise<SettingsIpcVoidResult> => {
      if (!checkSender(event)) {
        return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      }
      const parsed = updateProxyRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return { ok: false, error: invalidPayloadError(parsed.error.message) };
      }
      return updateProxy(deps.settingsDir, deps.secretStore, parsed.data);
    },
  );

  ipcMain.handle(
    SETTINGS_REMOVE_PROXY_CHANNEL,
    async (event, rawRequest: unknown): Promise<SettingsIpcVoidResult> => {
      if (!checkSender(event)) {
        return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      }
      const parsed = removeProxyRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return { ok: false, error: invalidPayloadError(parsed.error.message) };
      }
      return removeProxy(deps.settingsDir, deps.secretStore, parsed.data);
    },
  );

  ipcMain.handle(
    SETTINGS_REORDER_PROXIES_CHANNEL,
    async (event, rawRequest: unknown): Promise<SettingsIpcVoidResult> => {
      if (!checkSender(event)) {
        return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      }
      const parsed = reorderProxiesRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return { ok: false, error: invalidPayloadError(parsed.error.message) };
      }
      return reorderProxies(deps.settingsDir, parsed.data);
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

  ipcMain.handle(
    SETTINGS_SET_AGENT_SETTINGS_CHANNEL,
    async (event, rawRequest: unknown): Promise<SettingsIpcVoidResult> => {
      if (!checkSender(event)) {
        return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      }
      const parsed = setAgentSettingsRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return { ok: false, error: invalidPayloadError(parsed.error.message) };
      }
      return setAgentSettings(deps.settingsDir, deps.agentSettings, parsed.data);
    },
  );

  ipcMain.handle(
    SETTINGS_UPDATE_BROWSER_SETTINGS_CHANNEL,
    async (event, rawRequest: unknown): Promise<SettingsIpcVoidResult> => {
      if (!checkSender(event)) {
        return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      }
      const parsed = updateBrowserSettingsRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return { ok: false, error: invalidPayloadError(parsed.error.message) };
      }
      return updateBrowserSettings(deps.settingsDir, parsed.data);
    },
  );
}
