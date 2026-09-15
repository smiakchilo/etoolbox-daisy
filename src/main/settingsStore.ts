import { randomBytes } from 'node:crypto';
// Imported as the default (the real, mutable `fs.promises` object) rather
// than as named imports: tests spy on individual methods of this same object
// (`vi.spyOn(fsp, "rename")`, etc.) to simulate a write failing partway
// through, and that only intercepts calls made through a shared object
// reference - not calls made through named-import bindings resolved at
// module-load time.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  APP_SETTINGS_SCHEMA_VERSION,
  appSettingsSchema,
  defaultAppSettings,
  parseAppSettings,
  type AppSettings,
  type CopilotProxyConfig,
} from '../shared/contracts/appSettings';
import type { ServerId } from '../shared/contracts/ids';
import { isInsecureOrigin } from '../shared/contracts/origin';
import { err, ok, type Result } from '../shared/result';
import {
  bumpRevision,
  serverConfigSchema,
  updatePresentation,
  type ServerColor,
  type ServerConfig,
  type ServerPresentationChanges,
  type ServerTargetingChanges,
} from '../shared/contracts/serverConfig';

/**
 * Persistence and mutation orchestration for {@link AppSettings}
 * (implementation-plan.md step 04, requirements-decisions.md sections 7 and
 * 8). Validation, presentation-only edits, and revision-bumping targeting
 * edits are already implemented in `src/shared/contracts/appSettings.ts` and
 * `serverConfig.ts`; this module is only responsible for turning those into a
 * safely-persisted file and for the additional rules that only make sense at
 * the storage boundary (schema migrations, atomic writes, corruption
 * handling, and origin-change confirmation).
 *
 * The settings directory is taken as a plain injected `string` everywhere
 * below, never resolved here: this module does not import `appPaths.ts` or
 * `electron`, so it stays unit-testable under plain Vitest.
 */

export const SETTINGS_FILE_NAME = 'settings.json';

/** Path of the settings file inside `settingsDir`. Exported so tests (and the
 * caller, e.g. for backup tooling) don't have to duplicate the join. */
export function settingsFilePath(settingsDir: string): string {
  return path.join(settingsDir, SETTINGS_FILE_NAME);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

// ---------------------------------------------------------------------------
// Explicit schema migrations
// ---------------------------------------------------------------------------

/**
 * One explicit step from `fromVersion` to `toVersion`. `migrate` receives the
 * raw parsed JSON (not yet schema-validated) and must return a document
 * shaped for `toVersion`; the final result is validated by
 * `parseAppSettings` regardless, so a migration cannot itself smuggle an
 * invalid document past validation.
 */
export interface SchemaMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migrate: (data: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * The real migration registry used by {@link loadSettings}.
 *
 * Empty today, and that is honest rather than a placeholder: schema version 1
 * (`APP_SETTINGS_SCHEMA_VERSION`) is the first version this application has
 * ever written. There is no version 0 to migrate away from, so there is
 * nothing to register yet - inventing a no-op "version 0 -> 1" entry would
 * misrepresent history and give a false impression that a v0 file format ever
 * existed.
 *
 * When a future change bumps `APP_SETTINGS_SCHEMA_VERSION` to 2, add
 * `{ fromVersion: 1, toVersion: 2, migrate: (old) => ({ ...old, schemaVersion: 2, ... }) }`
 * here. `migrateSettingsData` below chains entries automatically (it looks up
 * the next step by the current version, not by array position), so multiple
 * hops in one load work with no further changes to this module.
 */
export const SETTINGS_MIGRATIONS: readonly SchemaMigration[] = [];

/**
 * Chains explicit migrations from `fromVersion` up to
 * `APP_SETTINGS_SCHEMA_VERSION`. `migrations` defaults to the real registry;
 * tests pass a substitute registry to exercise the chaining mechanism itself
 * without waiting for a real version 2 to exist.
 */
export function migrateSettingsData(
  data: Record<string, unknown>,
  fromVersion: number,
  migrations: readonly SchemaMigration[] = SETTINGS_MIGRATIONS,
): Result<Record<string, unknown>, string> {
  let current = data;
  let currentVersion = fromVersion;
  while (currentVersion < APP_SETTINGS_SCHEMA_VERSION) {
    const step = migrations.find((candidate) => candidate.fromVersion === currentVersion);
    if (!step) {
      return err(
        `no migration registered from schema version ${String(currentVersion)} to ` +
          `${String(APP_SETTINGS_SCHEMA_VERSION)}`,
      );
    }
    current = step.migrate(current);
    currentVersion = step.toVersion;
  }
  return ok(current);
}

function peekSchemaVersion(raw: unknown): Result<number, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return err('settings file does not contain a JSON object');
  }
  const version = (raw as Record<string, unknown>).schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return err('settings file is missing a numeric schemaVersion');
  }
  return ok(version);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Distinguishable reasons {@link loadSettings} can fail. A missing file is
 * deliberately *not* one of these: on a legitimate first run there is no file
 * yet and `defaultAppSettings()` is the correct answer, not an error. Every
 * kind here means something is actually wrong and the caller must not
 * silently fall back to defaults.
 */
export const SETTINGS_LOAD_ERROR_KINDS = [
  /** The file exists but could not be read (permissions, I/O error, ...). */
  'unreadable',
  /** The file's bytes are not valid JSON. */
  'unparseable',
  /** Valid JSON, but it fails `parseAppSettings` (or has no migration path). */
  'schema_invalid',
  /** `schemaVersion` is newer than this build understands. */
  'version_too_new',
] as const;

export type SettingsLoadErrorKind = (typeof SETTINGS_LOAD_ERROR_KINDS)[number];

export interface SettingsLoadError {
  readonly kind: SettingsLoadErrorKind;
  readonly message: string;
  readonly filePath: string;
}

export type SettingsLoadStatus = 'defaults' | 'loaded' | 'migrated';

export interface SettingsLoadOutcome {
  readonly settings: AppSettings;
  /**
   * `"defaults"`: no file existed (first run). `"loaded"`: the file already
   * matched `APP_SETTINGS_SCHEMA_VERSION`. `"migrated"`: the file was an
   * older version and was upgraded; `fromVersion` records what it was.
   */
  readonly status: SettingsLoadStatus;
  readonly fromVersion?: number;
}

export interface LoadSettingsOptions {
  /**
   * Overrides the migration registry used for this call. Defaults to the
   * real {@link SETTINGS_MIGRATIONS}. This exists for tests: it lets the
   * migration-chaining mechanism be proven end-to-end (a crafted old-version
   * file really does come out valid at the current version) without that
   * test being invalidated the day a real version 2 migration is added.
   */
  readonly migrations?: readonly SchemaMigration[];
}

/**
 * Loads settings from `settingsDir`, or reports defaults for a legitimate
 * first run.
 *
 * This function never writes anything - not even to "repair" a damaged file
 * - which is what guarantees a corrupt file is preserved untouched: there is
 * simply no write path here that could overwrite it. Deciding what to do
 * about a damaged file (show the user an error, offer to reset, keep a
 * backup copy) is left to the caller, who now has an explicit, distinguishable
 * error to act on instead of an exception or a silent empty document.
 */
export async function loadSettings(
  settingsDir: string,
  options: LoadSettingsOptions = {},
): Promise<Result<SettingsLoadOutcome, SettingsLoadError>> {
  const filePath = settingsFilePath(settingsDir);
  const migrations = options.migrations ?? SETTINGS_MIGRATIONS;

  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) {
      return ok({ status: 'defaults', settings: defaultAppSettings() });
    }
    return err({
      kind: 'unreadable',
      message: `could not read settings file: ${errorMessage(error)}`,
      filePath,
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    return err({
      kind: 'unparseable',
      message: `settings file is not valid JSON: ${errorMessage(error)}`,
      filePath,
    });
  }

  const versionResult = peekSchemaVersion(parsedJson);
  if (!versionResult.ok) {
    return err({ kind: 'schema_invalid', message: versionResult.error, filePath });
  }
  const fileVersion = versionResult.value;

  if (fileVersion > APP_SETTINGS_SCHEMA_VERSION) {
    return err({
      kind: 'version_too_new',
      message:
        `settings file is schema version ${String(fileVersion)}, but this build only ` +
        `understands up to version ${String(APP_SETTINGS_SCHEMA_VERSION)}. Refusing to load ` +
        `it: a newer version of the application may have written fields this build does not ` +
        `know about, and loading (and potentially re-saving) it here would destroy them.`,
      filePath,
    });
  }

  let candidate: unknown = parsedJson;
  let migratedFrom: number | undefined;
  if (fileVersion < APP_SETTINGS_SCHEMA_VERSION) {
    const migrated = migrateSettingsData(
      parsedJson as Record<string, unknown>,
      fileVersion,
      migrations,
    );
    if (!migrated.ok) {
      return err({ kind: 'schema_invalid', message: migrated.error, filePath });
    }
    candidate = migrated.value;
    migratedFrom = fileVersion;
  }

  const parsedSettings = parseAppSettings(candidate);
  if (!parsedSettings.ok) {
    return err({
      kind: 'schema_invalid',
      message: parsedSettings.error.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      filePath,
    });
  }

  if (migratedFrom !== undefined) {
    return ok({ status: 'migrated', settings: parsedSettings.value, fromVersion: migratedFrom });
  }
  return ok({ status: 'loaded', settings: parsedSettings.value });
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

export interface SettingsSaveError {
  readonly message: string;
  readonly filePath: string;
}

/**
 * Persists `settings` to `settingsDir` atomically.
 *
 * Writes to a temp file in the same directory, flushes it, and only then
 * renames it onto the real path - it never writes to `filePath` directly.
 * `fs.rename` (backed by `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING` on
 * Windows, `rename(2)` on POSIX) replaces a directory entry as one atomic
 * operation: a concurrent reader, or a process killed at any point, always
 * observes either the previous complete file or the new complete file, never
 * a partially written one. Writing in place has no such guarantee - a crash
 * between individual buffer flushes can leave a truncated, unparseable file
 * where a good one used to be.
 *
 * Any failure (creating the directory, writing the temp file, or the final
 * rename) is reported as an explicit error rather than a silent no-op, so a
 * caller can never believe a save succeeded when it did not.
 */
export async function saveSettings(
  settingsDir: string,
  settings: AppSettings,
): Promise<Result<void, SettingsSaveError>> {
  const filePath = settingsFilePath(settingsDir);
  const tempPath = path.join(
    settingsDir,
    `.${SETTINGS_FILE_NAME}.tmp-${randomBytes(8).toString('hex')}`,
  );
  const serialized = `${JSON.stringify(settings, null, 2)}\n`;

  try {
    await fsp.mkdir(settingsDir, { recursive: true });
    const handle = await fsp.open(tempPath, 'w');
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    // Best-effort cleanup: if the rename never happened, `filePath` was
    // never touched, so the previous good file (if any) is exactly as it
    // was; only a stray temp file could be left behind, and it is not
    // treated as settings.json by anything that reads this directory.
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    return err({
      message: `could not save settings: ${errorMessage(error)}`,
      filePath,
    });
  }
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Server mutations
// ---------------------------------------------------------------------------

// A real runtime symbol, not `declare const`: the object literal below must
// actually carry this key at runtime so the brand can be checked structurally
// by the type system, not merely asserted away.
const originChangeConfirmationBrand: unique symbol = Symbol('originChangeConfirmation');

/**
 * Proof that a human confirmed a specific origin change, obtainable only
 * through {@link confirmOriginChange}.
 *
 * This is deliberately not a `boolean` parameter on
 * {@link applyServerTargetingChange}. Requirements-decisions.md section 7
 * requires an origin change to go through a *separate* confirmation step; an
 * ordinary boolean can be passed as `true` out of habit, defaulted
 * permissively, or left over from copy-pasted code for an unrelated dialog,
 * and none of that would be visible at the call site. This type can only be
 * produced by naming the exact origin being confirmed, and
 * `applyServerTargetingChange` checks that name against the origin it is
 * actually about to apply - a confirmation obtained for one address cannot
 * silently authorize a change to a different one.
 */
export interface OriginChangeConfirmation {
  readonly confirmedNewOrigin: string;
  readonly [originChangeConfirmationBrand]: true;
}

/** The only way to obtain an {@link OriginChangeConfirmation}. Call this only
 * after the user has explicitly confirmed changing to `newOrigin`. */
export function confirmOriginChange(newOrigin: string): OriginChangeConfirmation {
  return { confirmedNewOrigin: newOrigin, [originChangeConfirmationBrand]: true };
}

/**
 * What a caller (step 05) must do about the currently displayed browser after
 * a mutation. Classified here, rather than acted on here, so that step 05
 * cannot miss a required transition: it reads `kind` off the result instead
 * of having to separately re-derive "did this change targeting" from the
 * before/after settings.
 *
 * `requires_safe_transition` is intentionally the outcome for *any*
 * non-origin targeting change (proxy/TLS-exception), not only for changes to
 * the currently active server: under-reporting a needed transition (missing
 * one for what turns out to be the active server) is unsafe, while
 * over-reporting it for a server that is not currently displayed is merely a
 * no-op for step 05 to skip. `origin_changed` is reported instead of
 * `requires_safe_transition` when the origin itself changed, since that is
 * the more specific and more consequential fact for step 05 to act on.
 */
export type ServerMutationKind = 'presentation' | 'requires_safe_transition' | 'origin_changed';

export interface ServerMutationOutcome {
  readonly settings: AppSettings;
  readonly server: ServerConfig;
  readonly kind: ServerMutationKind;
}

export const SERVER_MUTATION_ERROR_KINDS = [
  /** No server with the given id exists in these settings. */
  'server_not_found',
  /** The change includes an origin change with no matching confirmation. */
  'origin_change_requires_confirmation',
  /** The requested change does not produce a valid settings document. */
  'invalid_change',
] as const;

export type ServerMutationErrorKind = (typeof SERVER_MUTATION_ERROR_KINDS)[number];

export interface ServerMutationError {
  readonly kind: ServerMutationErrorKind;
  readonly message: string;
}

function findServer(settings: AppSettings, serverId: ServerId): ServerConfig | undefined {
  return settings.servers.find((server) => server.id === serverId);
}

/**
 * Replaces one server entry and re-validates the whole document (e.g. to
 * catch an origin change that collides with another configured server -
 * requirements-decisions.md section 7 forbids merging two entries that end
 * up sharing an origin). `appSettingsSchema.safeParse` is used instead of a
 * bare object spread so this validation can never be silently skipped.
 */
function withUpdatedServer(
  settings: AppSettings,
  updated: ServerConfig,
): Result<AppSettings, string> {
  const nextServers = settings.servers.map((server) =>
    server.id === updated.id ? updated : server,
  );
  const candidate = { ...settings, servers: nextServers };
  const parsed = appSettingsSchema.safeParse(candidate);
  if (!parsed.success) {
    return err(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  return ok(parsed.data);
}

/** Converts a thrown `ZodError` (or anything else) from a shared-contract
 * helper into a message, so an unexpected input is reported through the
 * `Result` convention instead of throwing across this module's API. */
function describeThrown(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  }
  return errorMessage(error);
}

/**
 * Renames/recolours a server. Never touches `revision`: implementation-plan.md
 * requires label/colour edits to work "without interrupting the
 * conversation", and `revision` exists solely to signal that *targeting*
 * information changed, which a rename or recolour never does.
 */
export function applyServerPresentationChange(
  settings: AppSettings,
  serverId: ServerId,
  changes: ServerPresentationChanges,
): Result<ServerMutationOutcome, ServerMutationError> {
  const server = findServer(settings, serverId);
  if (!server) {
    return err({ kind: 'server_not_found', message: `no server with id ${serverId}` });
  }

  let updated: ServerConfig;
  try {
    updated = updatePresentation(server, changes);
  } catch (error) {
    return err({ kind: 'invalid_change', message: describeThrown(error) });
  }

  const nextSettings = withUpdatedServer(settings, updated);
  if (!nextSettings.ok) {
    return err({ kind: 'invalid_change', message: nextSettings.error });
  }

  return ok({ settings: nextSettings.value, server: updated, kind: 'presentation' });
}

/**
 * Changes a server's origin, proxy, and/or TLS exception via
 * `bumpRevision`, which is what actually preserves the server id, increments
 * the revision, and clears any old TLS exception on an origin change (see
 * `bumpRevision`'s own documentation in `serverConfig.ts` for why that
 * clearing happens there).
 *
 * If `changes.origin` would actually change the server's origin,
 * `confirmation` is required and must name that exact new origin -
 * requirements-decisions.md section 7's "separate confirmation" for an
 * address change. A missing or mismatched confirmation causes the whole call
 * to be rejected: nothing is applied and nothing is returned as if it had
 * succeeded.
 */
export function applyServerTargetingChange(
  settings: AppSettings,
  serverId: ServerId,
  changes: ServerTargetingChanges,
  confirmation?: OriginChangeConfirmation,
): Result<ServerMutationOutcome, ServerMutationError> {
  const server = findServer(settings, serverId);
  if (!server) {
    return err({ kind: 'server_not_found', message: `no server with id ${serverId}` });
  }

  const nextOrigin = changes.origin ?? server.origin;
  const originChanging = nextOrigin !== server.origin;

  if (originChanging) {
    if (!confirmation || confirmation.confirmedNewOrigin !== nextOrigin) {
      return err({
        kind: 'origin_change_requires_confirmation',
        message:
          `changing server ${serverId} from ${server.origin} to ${nextOrigin} requires a ` +
          `confirmation naming that exact origin; none was supplied, or it named a different one`,
      });
    }
  }

  let updated: ServerConfig;
  try {
    updated = bumpRevision(server, changes);
  } catch (error) {
    return err({ kind: 'invalid_change', message: describeThrown(error) });
  }

  const nextSettings = withUpdatedServer(settings, updated);
  if (!nextSettings.ok) {
    return err({ kind: 'invalid_change', message: nextSettings.error });
  }

  return ok({
    settings: nextSettings.value,
    server: updated,
    kind: originChanging ? 'origin_changed' : 'requires_safe_transition',
  });
}

// ---------------------------------------------------------------------------
// Server creation and removal (step 05)
// ---------------------------------------------------------------------------

export const ADD_SERVER_ERROR_KINDS = [
  /** A configured server already uses this exact origin. */
  'duplicate_origin',
  /** `origin` is plain HTTP and `allowInsecureHttp` was not set. */
  'insecure_http_not_confirmed',
  /** The requested change does not produce a valid settings document. */
  'invalid_change',
] as const;

export type AddServerErrorKind = (typeof ADD_SERVER_ERROR_KINDS)[number];

export interface AddServerError {
  readonly kind: AddServerErrorKind;
  readonly message: string;
}

export interface NewServerInput {
  readonly label: string;
  readonly origin: string;
  readonly color: ServerColor;
  /**
   * Must be `true` for this call to succeed when `origin` is plain HTTP
   * (requirements-decisions.md section 4: "Plain HTTP AEM | Allowed for
   * explicitly configured addresses ... with a persistent visible
   * insecure-connection indicator"). Ignored when `origin` is HTTPS.
   *
   * There is deliberately no persisted field for this on {@link ServerConfig}
   * itself: whether an origin is insecure is already a pure derivation of its
   * scheme ({@link isInsecureOrigin}), which is exactly what drives the
   * persistent indicator this decision requires (`viewModel.ts`'s
   * `computeInsecureMarker`) - there is nothing further to store. This flag
   * only gates the *act* of adding a plain-HTTP entry through Settings: the
   * explicit checkbox the user ticks in that one moment *is* the "explicitly
   * configured" record requirements-decisions.md section 4 asks for; a
   * server, once added, carries no separate "I was allowed" bit to drift out
   * of sync with its own origin.
   */
  readonly allowInsecureHttp: boolean;
}

export interface AddServerOutcome {
  readonly settings: AppSettings;
  readonly server: ServerConfig;
}

/**
 * Creates a new server entry at revision 0, with no proxy or TLS exception -
 * matching `addServerRequestSchema`'s "presentation only" design
 * (`settings-ipc.ts`): origin/proxy/TLS-exception beyond this initial address
 * are changed afterward through {@link applyServerTargetingChange}, not here.
 * `newId` is minted by the caller (`ipc/settings.ts`, via `crypto.randomUUID`)
 * rather than here, matching `ids.ts`'s "identifier generation lives outside
 * the contract layer" split.
 */
export function addServer(
  settings: AppSettings,
  newId: ServerId,
  input: NewServerInput,
): Result<AddServerOutcome, AddServerError> {
  if (isInsecureOrigin(input.origin) && !input.allowInsecureHttp) {
    return err({
      kind: 'insecure_http_not_confirmed',
      message:
        `"${input.origin}" is a plain HTTP address; adding it requires explicitly ` +
        'confirming that plain HTTP is allowed for this server',
    });
  }

  if (settings.servers.some((server) => server.origin === input.origin)) {
    return err({
      kind: 'duplicate_origin',
      message: `a server with origin "${input.origin}" is already configured`,
    });
  }

  let candidate: ServerConfig;
  try {
    candidate = serverConfigSchema.parse({
      id: newId,
      label: input.label,
      origin: input.origin,
      color: input.color,
      revision: 0,
    });
  } catch (error) {
    return err({ kind: 'invalid_change', message: describeThrown(error) });
  }

  const parsed = appSettingsSchema.safeParse({
    ...settings,
    servers: [...settings.servers, candidate],
  });
  if (!parsed.success) {
    return err({
      kind: 'invalid_change',
      message: parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    });
  }

  return ok({ settings: parsed.data, server: candidate });
}

export interface RemoveServerOutcome {
  readonly settings: AppSettings;
  /**
   * Whether the removed server was also the active one.
   *
   * Decision (documenting the "handled deliberately" behaviour a removal of
   * the active server requires): removing the active server clears
   * `activeServerId` to `null` in the very same settings write, rather than
   * leaving it pointing at a server id that no longer exists. This is not
   * merely tidy - `appSettingsSchema`'s own `superRefine` already rejects a
   * document whose `activeServerId` does not refer to a configured server,
   * so *not* clearing it here would make every removal of the active server
   * fail validation outright. It also mirrors `setActiveServerRequestSchema`'s
   * own documented use ("`serverId: null` clears the active server, e.g.
   * before removing it"): a caller that forgets that step, or removes a
   * server directly, still ends up in the same safe state. Reacting to that
   * change at the browser layer (stopping the live view, closing auxiliary
   * windows) is out of scope for this module - see `ServerMutationOutcome`'s
   * `requires_safe_transition` for the analogous split on an existing
   * server's targeting change.
   */
  readonly wasActive: boolean;
}

/** Removes a server entry. See {@link RemoveServerOutcome.wasActive} for what happens when it was the active server. */
export function removeServer(
  settings: AppSettings,
  serverId: ServerId,
): Result<RemoveServerOutcome, ServerMutationError> {
  const server = findServer(settings, serverId);
  if (!server) {
    return err({ kind: 'server_not_found', message: `no server with id ${serverId}` });
  }

  const wasActive = settings.activeServerId === serverId;
  const candidate = {
    ...settings,
    servers: settings.servers.filter((existing) => existing.id !== serverId),
    activeServerId: wasActive ? null : settings.activeServerId,
  };

  const parsed = appSettingsSchema.safeParse(candidate);
  if (!parsed.success) {
    return err({
      kind: 'invalid_change',
      message: parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    });
  }

  return ok({ settings: parsed.data, wasActive });
}

// ---------------------------------------------------------------------------
// Global Copilot proxy (step 05)
// ---------------------------------------------------------------------------

/**
 * Stable secretRef for the single global Copilot proxy's credentials. Unlike
 * a server's AEM proxy - scoped by that server's own permanent id - there is
 * only ever one Copilot proxy, so one fixed key is enough; nothing needs to
 * mint or look up a per-instance ref for it.
 */
export const COPILOT_PROXY_SECRET_REF = 'copilotProxy';

export interface SetCopilotProxyInput {
  readonly url: string;
  /** `undefined` means "no username configured" - see {@link updateCopilotProxy} for what that does to any existing credentials. */
  readonly username?: string;
}

export interface UpdateCopilotProxyOutcome {
  readonly settings: AppSettings;
  /**
   * Set when this call just removed credentials that existed before (no
   * `username` supplied this time): the secretRef they used to point at,
   * now unreachable from `settings`. This module has no I/O of its own, so
   * it cannot delete the orphaned password itself - `ipc/settings.ts` uses
   * this to also clear it from `secretStore`, the same hygiene
   * `clearProxyPassword` already performs for an explicit clear.
   */
  readonly orphanedSecretRef?: string;
}

/**
 * Replaces the global Copilot proxy's address and (optionally) username.
 * This is a full replace, not a partial patch - matching
 * `setCopilotProxyRequestSchema`'s shape, which carries the whole proxy
 * configuration on every call, not a diff. Omitting `username` therefore
 * removes any existing credentials entirely, not merely "leaves them
 * unchanged"; the password itself is set separately, through
 * `settings:set-proxy-password` targeting `{ kind: "copilotProxy" }`.
 *
 * A pre-existing `secretRef` is preserved when a username is supplied (so a
 * simple username edit does not orphan and re-prompt for a password that is
 * otherwise unchanged); a brand new one uses {@link COPILOT_PROXY_SECRET_REF}.
 */
export function updateCopilotProxy(
  settings: AppSettings,
  input: SetCopilotProxyInput,
): Result<UpdateCopilotProxyOutcome, ServerMutationError> {
  const existingCredentials = settings.copilotProxy?.credentials;

  const nextCopilotProxy: CopilotProxyConfig =
    input.username !== undefined
      ? {
          url: input.url,
          credentials: {
            username: input.username,
            secretRef: existingCredentials?.secretRef ?? COPILOT_PROXY_SECRET_REF,
          },
        }
      : { url: input.url };

  const parsed = appSettingsSchema.safeParse({ ...settings, copilotProxy: nextCopilotProxy });
  if (!parsed.success) {
    return err({
      kind: 'invalid_change',
      message: parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    });
  }

  const orphanedSecretRef =
    input.username === undefined && existingCredentials ? existingCredentials.secretRef : undefined;

  return ok({
    settings: parsed.data,
    ...(orphanedSecretRef !== undefined ? { orphanedSecretRef } : {}),
  });
}

/**
 * The model / reasoning-effort defaults, as a pair
 * (implementation-plan.md step 09). Both nullable, never optional: this is a
 * full replace, so "clear the reasoning effort" must be expressible and must
 * not be confusable with "leave it as it was".
 */
export interface ModelPreferencesInput {
  readonly model: string | null;
  readonly reasoningEffort: string | null;
}

/**
 * Replaces `defaultModel`/`defaultReasoningEffort`.
 *
 * Pure and I/O-free, like every other mutation helper in this module: the
 * caller loads, applies, and saves. The whole document is re-validated through
 * `appSettingsSchema` rather than only the two changed fields, matching
 * `updateCopilotProxy` above - a settings document is accepted or rejected as
 * a whole, never field by field.
 *
 * Note what this function deliberately does *not* do: it never checks the
 * model against the SDK catalogue. That check belongs to the IPC layer, which
 * is where the catalogue is reachable, and keeping it out of here means a
 * model the SDK has temporarily stopped advertising (runtime not started,
 * signed out, transient outage) can still be loaded and re-saved from disk
 * rather than being silently dropped by the store - "Do not silently replace
 * the model" applies to persistence just as much as to resume.
 */
export function updateModelPreferences(
  settings: AppSettings,
  input: ModelPreferencesInput,
): Result<AppSettings, ServerMutationError> {
  const parsed = appSettingsSchema.safeParse({
    ...settings,
    defaultModel: input.model,
    defaultReasoningEffort: input.model === null ? null : input.reasoningEffort,
  });
  if (!parsed.success) {
    return err({
      kind: 'invalid_change',
      message: parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    });
  }
  return ok(parsed.data);
}
