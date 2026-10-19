import { z } from 'zod';
import {
  appSettingsSnapshotSchema,
  projectSnapshotSchema,
  proxySnapshotSchema,
  serverSnapshotSchema,
  type AppSettingsSnapshot,
  type ProjectSnapshot,
  type ProxySnapshot,
  type ServerSnapshot,
} from './contracts';
import { projectIdSchema, proxyIdSchema, serverIdSchema } from './contracts';
import { agentIdSchema } from './contracts';
import { originSchema } from './contracts';
import { modelIdSchema, reasoningEffortSchema } from './contracts';
import { modelSelectionStateSchema, type ModelSelectionState } from './contracts';
import {
  environmentRootTextSchema,
  hostProxyIdSchema,
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
 * Step 04 kept this narrow: read the secret-free snapshot, set a
 * password, or clear one. Step 05 (this comment's own update) adds the
 * mutation channels that step 04 explicitly deferred - add/remove a server,
 * choose the active one, and change presentation/targeting - by wrapping the
 * pure mutation helpers already implemented in `src/main/settingsStore.ts`
 * (`applyServerPresentationChange`/`applyServerTargetingChange`/
 * `confirmOriginChange`) rather than re-deriving that logic here.
 */

/**
 * Identifies *which* target a password/secret belongs to, without ever naming
 * a `secretRef` - the renderer is never told one (see `settingsSnapshot.ts`),
 * so it can only refer to a target by the same handles the snapshot already
 * exposes: a proxy-library entry id, or an agent id (its personal-access
 * token, the Settings "Agents" tab's Token field). A host has no proxy
 * credentials of its own - it selects a library entry, whose password is set
 * through the `proxy` target.
 */
export const passwordTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('proxy'), proxyId: proxyIdSchema }).strict(),
  z.object({ kind: z.literal('agent'), agentId: agentIdSchema }).strict(),
]);

export type PasswordTarget = z.infer<typeof passwordTargetSchema>;

const PASSWORD_MAX_LENGTH = 1000;

export const setPasswordRequestSchema = z
  .object({
    target: passwordTargetSchema,
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  })
  .strict();

export type SetPasswordRequest = z.infer<typeof setPasswordRequestSchema>;

export const clearPasswordRequestSchema = z
  .object({
    target: passwordTargetSchema,
  })
  .strict();

export type ClearPasswordRequest = z.infer<typeof clearPasswordRequestSchema>;

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
  /** The target agent has no token configured yet, so there is no secretRef to use. */
  'no_token_configured',
  /** Reading or writing the settings file itself failed. */
  'storage_error',
  /** No server with the given id exists (mutation channels, step 05). */
  'server_not_found',
  /** No proxy-library entry with the given id exists. */
  'proxy_not_found',
  /** No project-library entry with the given id exists. */
  'project_not_found',
  /** No agent with the given id exists in the agent registry. */
  'agent_not_found',
  /** An origin change was requested without the matching confirmation for that exact origin. */
  'origin_change_requires_confirmation',
  /** A configured server already uses the requested origin. */
  'duplicate_origin',
  /** The requested change does not produce a valid settings document. */
  'invalid_change',
  /** The Copilot model catalogue could not be read (runtime starting, signed out, unavailable). */
  'model_catalog_unavailable',
  /** The requested model is not in the catalogue the SDK reported. */
  'model_not_available',
  /** The requested reasoning effort is not one the selected model supports. */
  'unsupported_reasoning_effort',
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
 * Result of `settings:set-password` / `settings:clear-password`.
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
 */
export const addServerRequestSchema = z
  .object({
    label: serverLabelSchema,
    origin: originSchema,
    color: serverColorSchema,
    /** Optional project id captured on a draft row (its "(Default)" choice is the absence of this key). */
    projectId: projectIdSchema.optional(),
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

/**
 * `settings:update-server-presentation` - label/colour and the project
 * reference, never bumps `revision`. `projectId: null` resets the host to
 * "(Default)" (no project); omitting it leaves the current selection alone.
 */
export const updateServerPresentationRequestSchema = z
  .object({
    serverId: serverIdSchema,
    changes: z
      .object({
        label: serverLabelSchema.optional(),
        color: serverColorSchema.optional(),
        projectId: projectIdSchema.nullable().optional(),
      })
      .strict(),
  })
  .strict();

export type UpdateServerPresentationRequest = Readonly<
  z.infer<typeof updateServerPresentationRequestSchema>
>;

/**
 * `settings:update-server-targeting` - origin/proxy-selection/TLS-exception,
 * via `applyServerTargetingChange`. A key omitted from `changes` means "leave
 * unchanged"; `null` means "remove it"; a value means "replace it" - the
 * same three-state convention `ServerTargetingChanges` itself uses. For
 * `proxyId`, `null` resets the host to "(Default)" (inherit `browser.proxy`)
 * and the string `"none"` is the explicit "No proxy" selection.
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
        proxyId: hostProxyIdSchema.nullable().optional(),
        tlsException: tlsExceptionSchema.nullable().optional(),
      })
      .strict(),
    originChangeConfirmed: z.boolean().optional(),
  })
  .strict();

export type UpdateServerTargetingRequest = Readonly<
  z.infer<typeof updateServerTargetingRequestSchema>
>;

/**
 * `settings:add-proxy` - creates one entry in the proxies library ("Add item"
 * in the Settings "Proxies" multifield). Presentation/identity only, matching
 * `addServerRequestSchema`'s split: the entry starts with no password, which
 * is set separately via `settings:set-password` with target
 * `{ kind: "proxy", proxyId }`.
 *
 * `username` is optional; when supplied the entry is created with
 * credentials (a username and a freshly-minted `secretRef`), even though no
 * password has been stored under that ref yet.
 */
export const addProxyRequestSchema = z
  .object({
    label: serverLabelSchema,
    url: originSchema,
    username: z.string().min(1).max(200).optional(),
  })
  .strict();

export type AddProxyRequest = Readonly<z.infer<typeof addProxyRequestSchema>>;

export const addProxyResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), proxy: proxySnapshotSchema }).strict(),
  z.object({ ok: z.literal(false), error: settingsIpcErrorSchema }).strict(),
]);

export type AddProxyResult =
  | { readonly ok: true; readonly proxy: ProxySnapshot }
  | { readonly ok: false; readonly error: SettingsIpcError };

export function parseAddProxyResult(candidate: unknown): AddProxyResult {
  return addProxyResultSchema.parse(candidate);
}

/**
 * `settings:update-proxy` - replaces one entry's label, address and username.
 * A full replace, not a patch: omitting `username` removes any configured
 * credentials entirely (and orphans their secret, which main best-effort
 * deletes), rather than leaving them unchanged.
 */
export const updateProxyRequestSchema = z
  .object({
    proxyId: proxyIdSchema,
    label: serverLabelSchema,
    url: originSchema,
    username: z.string().min(1).max(200).optional(),
  })
  .strict();

export type UpdateProxyRequest = Readonly<z.infer<typeof updateProxyRequestSchema>>;

/** `settings:remove-proxy`. */
export const removeProxyRequestSchema = z.object({ proxyId: proxyIdSchema }).strict();
export type RemoveProxyRequest = Readonly<z.infer<typeof removeProxyRequestSchema>>;

/**
 * `settings:reorder-proxies` - the Settings "Proxies" multifield's up/down
 * actions. The whole desired order, not one step, exactly like
 * `reorderServersRequestSchema`; main validates it is a permutation.
 */
export const reorderProxiesRequestSchema = z
  .object({
    proxyIds: z.array(proxyIdSchema),
  })
  .strict();

export type ReorderProxiesRequest = Readonly<z.infer<typeof reorderProxiesRequestSchema>>;

// ---------------------------------------------------------------------------
// Projects library (the `projects` array)
// ---------------------------------------------------------------------------

/**
 * `settings:add-project` - creates one entry in the projects library (the
 * "Add item" action of the Settings "Projects" multifield). `label` is
 * required; the content/component roots are optional free text captured while
 * the row is still a draft.
 */
export const addProjectRequestSchema = z
  .object({
    label: serverLabelSchema,
    contentRoots: environmentRootTextSchema.optional(),
    componentRoots: environmentRootTextSchema.optional(),
    contentPriorityPaths: environmentRootTextSchema.optional(),
    damRoots: environmentRootTextSchema.optional(),
  })
  .strict();

export type AddProjectRequest = Readonly<z.infer<typeof addProjectRequestSchema>>;

export const addProjectResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), project: projectSnapshotSchema }).strict(),
  z.object({ ok: z.literal(false), error: settingsIpcErrorSchema }).strict(),
]);

export type AddProjectResult =
  | { readonly ok: true; readonly project: ProjectSnapshot }
  | { readonly ok: false; readonly error: SettingsIpcError };

export function parseAddProjectResult(candidate: unknown): AddProjectResult {
  return addProjectResultSchema.parse(candidate);
}

/**
 * `settings:update-project` - replaces one entry's label and roots. A full
 * replace, not a patch, matching `updateProxyRequestSchema`'s shape: omitting a
 * roots key clears it (the reader drops an empty value on the next load).
 */
export const updateProjectRequestSchema = z
  .object({
    projectId: projectIdSchema,
    label: serverLabelSchema,
    contentRoots: environmentRootTextSchema.optional(),
    componentRoots: environmentRootTextSchema.optional(),
    contentPriorityPaths: environmentRootTextSchema.optional(),
    damRoots: environmentRootTextSchema.optional(),
  })
  .strict();

export type UpdateProjectRequest = Readonly<z.infer<typeof updateProjectRequestSchema>>;

/** `settings:remove-project`. */
export const removeProjectRequestSchema = z.object({ projectId: projectIdSchema }).strict();
export type RemoveProjectRequest = Readonly<z.infer<typeof removeProjectRequestSchema>>;

/**
 * `settings:reorder-projects` - the Settings "Projects" multifield's up/down
 * actions. The whole desired order, not one step; main validates it is a
 * permutation (see `reorderProjects` in `settingsStore.ts`).
 */
export const reorderProjectsRequestSchema = z
  .object({
    projectIds: z.array(projectIdSchema),
  })
  .strict();

export type ReorderProjectsRequest = Readonly<z.infer<typeof reorderProjectsRequestSchema>>;

// ---------------------------------------------------------------------------
// Settings mutation results (step 05)
// ---------------------------------------------------------------------------

/**
 * Result of `settings:remove-server`, `settings:update-proxy`,
 * `settings:remove-proxy` and `settings:reorder-proxies`. All
 * mutations have nothing more specific to report back than success/failure -
 * the renderer already re-fetches the whole snapshot afterward (see
 * `settingsPanel.ts`'s `reload`) - so, like `settings:set-password`,
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

/**
 * `settings:reorder-servers` - the Settings "Hosts" multifield's up/down
 * actions.
 *
 * Deliberately the whole desired order (`serverIds`), not a single
 * `{ serverId, direction }` step: the renderer already holds the list it
 * shows, and sending the complete permutation means the persisted order can
 * never disagree with what the user sees. Main validates that the list is
 * exactly the set of configured ids (every id once, none missing, none
 * unknown) before writing - see `reorderServers` in `settingsStore.ts`.
 *
 * Order is presentation, not targeting: it never bumps a `revision`, so a
 * reorder cannot interrupt an in-flight request or the live browser view. This is
 * why it is a dedicated channel rather than a use of
 * `settings:update-server-presentation` (which takes label/colour only).
 */
export const reorderServersRequestSchema = z
  .object({
    serverIds: z.array(serverIdSchema),
  })
  .strict();

export type ReorderServersRequest = Readonly<z.infer<typeof reorderServersRequestSchema>>;

/**
 * Result of `settings:reorder-servers`. Nothing more specific than
 * success/failure to report - the renderer re-reads the snapshot afterward
 * (see `settingsPanel.ts`'s `reload`) - so it reuses
 * {@link settingsIpcVoidResultSchema}, matching `settings:remove-server`.
 */
export const reorderServersResultSchema = settingsIpcVoidResultSchema;
export type ReorderServersResult = SettingsIpcVoidResult;

export function parseReorderServersResult(candidate: unknown): ReorderServersResult {
  return settingsIpcVoidResultSchema.parse(candidate);
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

// ---------------------------------------------------------------------------
// Agent settings (the "Agents" surface)
// ---------------------------------------------------------------------------

/**
 * `settings:set-agent-settings`. Every field of `changes` follows the same
 * three-state convention as `updateServerTargetingRequestSchema`: omitted means
 * "leave unchanged", `null` means "clear" (for `proxy`/`model`/
 * `reasoningEffort`; `active` is a plain boolean and is never cleared), and a
 * value means "replace". At least one key must be present - a request that
 * changes nothing is refused rather than silently writing the same document
 * back.
 *
 * `agentId` is validated as an identifier, and the handler additionally
 * requires it to name a provider in the compiled-in registry (reported as
 * `agent_not_found`). A not-yet-known provider id from a newer settings file is
 * therefore still *loadable* (see `agents.ts`) while remaining un-addressable
 * here, which is the conservative direction for a write.
 */
export const setAgentSettingsRequestSchema = z
  .object({
    agentId: agentIdSchema,
    changes: z
      .object({
        active: z.boolean().optional(),
        proxy: proxyIdSchema.nullable().optional(),
        model: modelIdSchema.nullable().optional(),
        reasoningEffort: reasoningEffortSchema.nullable().optional(),
      })
      .strict()
      .refine((changes) => Object.keys(changes).length > 0, {
        message: 'at least one setting must be supplied',
      }),
  })
  .strict();

export type SetAgentSettingsRequest = Readonly<z.infer<typeof setAgentSettingsRequestSchema>>;

/** `settings:set-agent-settings` result - the same shape as every other settings mutation. */
export const setAgentSettingsResultSchema = settingsIpcVoidResultSchema;
export type SetAgentSettingsResult = SettingsIpcVoidResult;

export function parseSetAgentSettingsResult(candidate: unknown): SetAgentSettingsResult {
  return setAgentSettingsResultSchema.parse(candidate);
}

// ---------------------------------------------------------------------------
// Browser-pane settings (the "Browser" surface)
// ---------------------------------------------------------------------------

/**
 * `settings:update-browser-settings`. A partial patch following the same
 * convention as {@link setAgentSettingsRequestSchema}: an omitted key means
 * "leave unchanged", and a request that changes nothing is refused.
 *
 * `disableNativeWebAuthn` is persisted immediately but only takes effect on
 * the next launch, because Chromium reads its feature switches once, before
 * the app is ready. `proxy` is the default proxy - a library entry id, or
 * `null` to clear it - and takes effect on the browser pane's next navigation
 * (see `browserController.ts`).
 */
export const updateBrowserSettingsRequestSchema = z
  .object({
    changes: z
      .object({
        disableNativeWebAuthn: z.boolean().optional(),
        proxy: proxyIdSchema.nullable().optional(),
      })
      .strict()
      .refine((changes) => Object.keys(changes).length > 0, {
        message: 'at least one setting must be supplied',
      }),
  })
  .strict();

export type UpdateBrowserSettingsRequest = Readonly<
  z.infer<typeof updateBrowserSettingsRequestSchema>
>;

/** `settings:update-browser-settings` result - the same shape as every other settings mutation. */
export const updateBrowserSettingsResultSchema = settingsIpcVoidResultSchema;
export type UpdateBrowserSettingsResult = SettingsIpcVoidResult;

// ---------------------------------------------------------------------------
// Self-learning settings (the Skills tab's "Self-learning" checkbox)
// ---------------------------------------------------------------------------

/**
 * `settings:update-memo-settings`. A partial patch with the same convention as
 * {@link updateBrowserSettingsRequestSchema}. Read fresh on every prompt, so
 * the change applies to the next one.
 */
export const updateMemoSettingsRequestSchema = z
  .object({
    changes: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .refine((changes) => Object.keys(changes).length > 0, {
        message: 'at least one setting must be supplied',
      }),
  })
  .strict();

export type UpdateMemoSettingsRequest = Readonly<z.infer<typeof updateMemoSettingsRequestSchema>>;
