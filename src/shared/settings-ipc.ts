import { z } from 'zod';
import {
  appSettingsSnapshotSchema,
  serverSnapshotSchema,
  type AppSettingsSnapshot,
  type ServerSnapshot,
} from './contracts';
import { serverIdSchema } from './contracts';
import { originSchema } from './contracts';
import { modelIdSchema, reasoningEffortSchema } from './contracts';
import { modelSelectionStateSchema, type ModelSelectionState } from './contracts';
import {
  aemProxyConfigSchema,
  serverColorSchema,
  serverLabelSchema,
  tlsExceptionSchema,
} from './contracts';

/**
 * Wire contracts for the dedicated settings IPC surface
 * (implementation-plan.md step 04: "Accept a new value only from the local
 * Settings window through dedicated IPC."). Mirrors the placement of
 * `agent-auth.ts`: request/response DTOs for one IPC
 * surface live directly under `src/shared`, separate from the domain
 * contracts in `src/shared/contracts`.
 *
 * Step 04 kept this narrow: read the secret-free snapshot, set a proxy
 * password, or clear one. Step 05 (this comment's own update) adds the
 * mutation channels that step 04 explicitly deferred - add/remove a server,
 * choose the active one, and change presentation/targeting - by wrapping the
 * pure mutation helpers already implemented in `src/main/settingsStore.ts`
 * (`applyServerPresentationChange`/`applyServerTargetingChange`/
 * `confirmOriginChange`) rather than re-deriving that logic here.
 */

/**
 * Identifies *which* proxy a password belongs to, without ever naming a
 * `secretRef` - the renderer is never told one (see `settingsSnapshot.ts`),
 * so it can only refer to a proxy by the same handles the snapshot already
 * exposes: a server id, or the fixed "the global Copilot proxy" case.
 */
export const proxyPasswordTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('server'), serverId: serverIdSchema }).strict(),
  z.object({ kind: z.literal('copilotProxy') }).strict(),
]);

export type ProxyPasswordTarget = z.infer<typeof proxyPasswordTargetSchema>;

const PROXY_PASSWORD_MAX_LENGTH = 1000;

export const setProxyPasswordRequestSchema = z
  .object({
    target: proxyPasswordTargetSchema,
    password: z.string().min(1).max(PROXY_PASSWORD_MAX_LENGTH),
  })
  .strict();

export type SetProxyPasswordRequest = z.infer<typeof setProxyPasswordRequestSchema>;

export const clearProxyPasswordRequestSchema = z
  .object({
    target: proxyPasswordTargetSchema,
  })
  .strict();

export type ClearProxyPasswordRequest = z.infer<typeof clearProxyPasswordRequestSchema>;

/**
 * Distinguishable failure reasons for this IPC surface. `secret_storage_unavailable`
 * is the explicit, typed error required when OS-backed secure storage cannot
 * be used (implementation-plan.md step 04: "Failure to access secure storage
 * is an explicit error, not permission for plaintext fallback.") - there is
 * no code path that falls back to storing a password in plaintext instead.
 */
export const SETTINGS_IPC_ERROR_CODES = [
  /** The request payload failed schema validation. */
  'invalid_payload',
  /** The request did not come from the local app's Settings surface. */
  'untrusted_sender',
  /** OS-backed secure storage is unavailable; refusing any plaintext fallback. */
  'secret_storage_unavailable',
  /** The target has no proxy credentials configured yet, so there is no secretRef to use. */
  'no_proxy_configured',
  /** Reading or writing the settings file itself failed. */
  'storage_error',
  /** No server with the given id exists (mutation channels, step 05). */
  'server_not_found',
  /** An origin change was requested without the matching confirmation for that exact origin. */
  'origin_change_requires_confirmation',
  /** A configured server already uses the requested origin. */
  'duplicate_origin',
  /** The requested origin is plain HTTP and the caller did not explicitly allow it. */
  'insecure_http_not_confirmed',
  /** The requested change does not produce a valid settings document. */
  'invalid_change',
  /** The Copilot model catalogue could not be read (runtime starting, signed out, unavailable). */
  'model_catalog_unavailable',
  /** The requested model is not in the catalogue the SDK reported. */
  'model_not_available',
  /** The requested reasoning effort is not one the selected model supports. */
  'unsupported_reasoning_effort',
  /** A turn is in flight; model selection is locked until it finishes (step 09). */
  'turn_in_flight',
] as const;

export type SettingsIpcErrorCode = (typeof SETTINGS_IPC_ERROR_CODES)[number];

const ERROR_MESSAGE_MAX_LENGTH = 500;

export const settingsIpcErrorSchema = z
  .object({
    code: z.enum(SETTINGS_IPC_ERROR_CODES),
    message: z.string().min(1).max(ERROR_MESSAGE_MAX_LENGTH),
  })
  .strict();

export type SettingsIpcError = z.infer<typeof settingsIpcErrorSchema>;

/**
 * Result of `settings:get-snapshot`. Never a bare throw across IPC: a failure
 * (e.g. a corrupt settings file) is reported as `{ ok: false, error }` so the
 * renderer can display it, matching this codebase's `Result` convention
 * (`src/shared/result.ts`) rather than a rejected promise carrying an
 * arbitrary `Error`.
 */
export const getSettingsSnapshotResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), snapshot: appSettingsSnapshotSchema }).strict(),
  z.object({ ok: z.literal(false), error: settingsIpcErrorSchema }).strict(),
]);

/**
 * Declared explicitly rather than as `z.infer<typeof getSettingsSnapshotResultSchema>`:
 * zod's inferred object type does not carry the `readonly`/`readonly [...]`
 * modifiers {@link AppSettingsSnapshot} declares for its arrays, and this
 * result type is handed `AppSettingsSnapshot` values directly (from
 * `toAppSettingsSnapshot`) rather than re-parsing them, so it must match that
 * type exactly.
 */
export type GetSettingsSnapshotResult =
  | { readonly ok: true; readonly snapshot: AppSettingsSnapshot }
  | { readonly ok: false; readonly error: SettingsIpcError };

export function parseGetSettingsSnapshotResult(candidate: unknown): GetSettingsSnapshotResult {
  return getSettingsSnapshotResultSchema.parse(candidate);
}

/**
 * Result of `settings:set-proxy-password` / `settings:clear-proxy-password`.
 * The success branch carries no data at all - in particular, never the
 * password that was just set - so there is nothing for a caller to echo
 * back even by accident.
 */
export const settingsIpcVoidResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), error: settingsIpcErrorSchema }).strict(),
]);

export type SettingsIpcVoidResult = z.infer<typeof settingsIpcVoidResultSchema>;

export function parseSettingsIpcVoidResult(candidate: unknown): SettingsIpcVoidResult {
  return settingsIpcVoidResultSchema.parse(candidate);
}

// ---------------------------------------------------------------------------
// Settings mutation (step 05)
// ---------------------------------------------------------------------------

/**
 * `settings:add-server`. Presentation only - `proxy`/`tlsException` are set
 * afterward via `update-server-targeting`, matching `bumpRevision`'s "id is
 * permanent, targeting is a separate revision-bumping step" split.
 *
 * `allowInsecureHttp` must be `true` when `origin` is plain HTTP
 * (requirements-decisions.md section 4); it is ignored for an HTTPS origin.
 * See `settingsStore.ts`'s `NewServerInput.allowInsecureHttp` for why this is
 * a one-shot confirmation on the request rather than a field stored on the
 * server itself.
 */
export const addServerRequestSchema = z
  .object({
    label: serverLabelSchema,
    origin: originSchema,
    color: serverColorSchema,
    allowInsecureHttp: z.boolean(),
  })
  .strict();

export type AddServerRequest = Readonly<z.infer<typeof addServerRequestSchema>>;

export const addServerResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), server: serverSnapshotSchema }).strict(),
  z.object({ ok: z.literal(false), error: settingsIpcErrorSchema }).strict(),
]);

export type AddServerResult =
  | { readonly ok: true; readonly server: ServerSnapshot }
  | { readonly ok: false; readonly error: SettingsIpcError };

export function parseAddServerResult(candidate: unknown): AddServerResult {
  return addServerResultSchema.parse(candidate);
}

/** `settings:remove-server`. */
export const removeServerRequestSchema = z.object({ serverId: serverIdSchema }).strict();
export type RemoveServerRequest = Readonly<z.infer<typeof removeServerRequestSchema>>;

/** `settings:set-active-server`. `serverId: null` clears the active server (e.g. before removing it). */
export const setActiveServerRequestSchema = z
  .object({ serverId: serverIdSchema.nullable() })
  .strict();
export type SetActiveServerRequest = Readonly<z.infer<typeof setActiveServerRequestSchema>>;

/** `settings:update-server-presentation` - label/colour only, never bumps `revision`. */
export const updateServerPresentationRequestSchema = z
  .object({
    serverId: serverIdSchema,
    changes: z
      .object({
        label: serverLabelSchema.optional(),
        color: serverColorSchema.optional(),
      })
      .strict(),
  })
  .strict();

export type UpdateServerPresentationRequest = Readonly<
  z.infer<typeof updateServerPresentationRequestSchema>
>;

/**
 * `settings:update-server-targeting` - origin/proxy/TLS-exception, via
 * `applyServerTargetingChange`. A key omitted from `changes` means "leave
 * unchanged"; `null` means "remove it"; a value means "replace it" - the
 * same three-state convention `ServerTargetingChanges` itself uses.
 *
 * `originChangeConfirmed` is a plain boolean, not a caller-supplied
 * confirmation object: the confirmation
 * (`settingsStore.ts`'s `confirmOriginChange`) is constructed on the main
 * side from this very request's own `changes.origin`, so a renderer cannot
 * send a confirmation for one origin while the request changes to a
 * different one - the same protection the branded
 * `OriginChangeConfirmation` type gives a direct in-process caller.
 */
export const updateServerTargetingRequestSchema = z
  .object({
    serverId: serverIdSchema,
    changes: z
      .object({
        origin: originSchema.optional(),
        proxy: aemProxyConfigSchema.nullable().optional(),
        tlsException: tlsExceptionSchema.nullable().optional(),
      })
      .strict(),
    originChangeConfirmed: z.boolean().optional(),
  })
  .strict();

export type UpdateServerTargetingRequest = Readonly<
  z.infer<typeof updateServerTargetingRequestSchema>
>;

/** `settings:set-copilot-proxy`. The password itself is set separately via `settings:set-proxy-password` with target `{ kind: "copilotProxy" }`. */
export const setCopilotProxyRequestSchema = z
  .object({
    url: originSchema,
    username: z.string().min(1).max(200).optional(),
  })
  .strict();

export type SetCopilotProxyRequest = Readonly<z.infer<typeof setCopilotProxyRequestSchema>>;

// ---------------------------------------------------------------------------
// Settings mutation results (step 05)
// ---------------------------------------------------------------------------

/**
 * Result of `settings:remove-server` and `settings:set-copilot-proxy`. Both
 * mutations have nothing more specific to report back than success/failure -
 * the renderer already re-fetches the whole snapshot afterward (see
 * `settingsPanel.ts`'s `reload`) - so, like `settings:set-proxy-password`,
 * they reuse {@link settingsIpcVoidResultSchema} rather than each declaring
 * an identical-shaped result type of their own. `settings:add-server`'s
 * {@link addServerResultSchema} above already covers that channel's result.
 */

/** Result of `settings:update-server-presentation`. Never bumps `revision`, so there is no `kind` to report - unlike targeting, a presentation change never requires a safe transition. */
export const updateServerPresentationResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), server: serverSnapshotSchema }).strict(),
  z.object({ ok: z.literal(false), error: settingsIpcErrorSchema }).strict(),
]);

export type UpdateServerPresentationResult =
  | { readonly ok: true; readonly server: ServerSnapshot }
  | { readonly ok: false; readonly error: SettingsIpcError };

export function parseUpdateServerPresentationResult(
  candidate: unknown,
): UpdateServerPresentationResult {
  return updateServerPresentationResultSchema.parse(candidate);
}

/**
 * The two outcomes `applyServerTargetingChange` can report for a *successful*
 * change (see `settingsStore.ts`'s `ServerMutationKind`) - `"presentation"`
 * is excluded here because targeting changes never produce it.
 */
export const SERVER_TARGETING_MUTATION_KINDS = [
  'requires_safe_transition',
  'origin_changed',
] as const;
export type ServerTargetingMutationKind = (typeof SERVER_TARGETING_MUTATION_KINDS)[number];

/** Result of `settings:update-server-targeting`. */
export const updateServerTargetingResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      server: serverSnapshotSchema,
      kind: z.enum(SERVER_TARGETING_MUTATION_KINDS),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: settingsIpcErrorSchema }).strict(),
]);

export type UpdateServerTargetingResult =
  | {
      readonly ok: true;
      readonly server: ServerSnapshot;
      readonly kind: ServerTargetingMutationKind;
    }
  | { readonly ok: false; readonly error: SettingsIpcError };

export function parseUpdateServerTargetingResult(candidate: unknown): UpdateServerTargetingResult {
  return updateServerTargetingResultSchema.parse(candidate);
}

// ---------------------------------------------------------------------------
// Model / reasoning-effort selection (step 09)
// ---------------------------------------------------------------------------

/**
 * Result of `settings:get-model-selection`.
 *
 * Note that an unreadable model catalogue is *not* an error branch here: it is
 * `{ ok: true, state: { catalogUnavailable: true, models: [] } }`. The stored
 * selection is still meaningful and must still be displayed when Copilot's
 * runtime has not finished starting, so failing the whole read would blank out
 * a setting the user did choose. The `ok: false` branch is reserved for the
 * settings file itself being unreadable, matching every other channel here.
 */
export const getModelSelectionResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), state: modelSelectionStateSchema }).strict(),
  z.object({ ok: z.literal(false), error: settingsIpcErrorSchema }).strict(),
]);

/**
 * Declared explicitly rather than inferred, for the same reason as
 * {@link GetSettingsSnapshotResult}: zod's inferred type does not carry the
 * `readonly` array modifier {@link ModelSelectionState} declares.
 */
export type GetModelSelectionResult =
  | { readonly ok: true; readonly state: ModelSelectionState }
  | { readonly ok: false; readonly error: SettingsIpcError };

export function parseGetModelSelectionResult(candidate: unknown): GetModelSelectionResult {
  return getModelSelectionResultSchema.parse(candidate);
}

/**
 * `settings:set-model-preferences`. Both fields are required and nullable
 * rather than optional: this is a full replace, so "clear the reasoning
 * effort" is expressible (`null`) and cannot be confused with "leave it
 * alone" (which an omitted optional key would mean).
 *
 * Sending both together is deliberate. A reasoning effort is only meaningful
 * relative to a model, so splitting this into two channels would create a
 * window in which the persisted pair is a level the persisted model does not
 * support - exactly the state `isReasoningEffortValidFor`
 * (`contracts/modelCatalog.ts`) exists to make unrepresentable.
 */
export const setModelPreferencesRequestSchema = z
  .object({
    model: modelIdSchema.nullable(),
    reasoningEffort: reasoningEffortSchema.nullable(),
  })
  .strict()
  .refine((request) => request.model !== null || request.reasoningEffort === null, {
    message: 'reasoningEffort requires a model',
    path: ['reasoningEffort'],
  });

export type SetModelPreferencesRequest = Readonly<z.infer<typeof setModelPreferencesRequestSchema>>;
