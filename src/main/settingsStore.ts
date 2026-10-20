import { createHash, randomBytes } from 'node:crypto';
// Imported as the default (the real, mutable `fs.promises` object) rather
// than as named imports: tests spy on individual methods of this same object
// (`vi.spyOn(fsp, "rename")`, etc.) to simulate a write failing partway
// through, and that only intercepts calls made through a shared object
// reference - not calls made through named-import bindings resolved at
// module-load time.
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  appSettingsSchema,
  browserSettingsSchema,
  defaultAppSettings,
  parseAppSettings,
  projectConfigSchema,
  updateSettingsSchema,
  updateUrlSchema,
  type AgentToken,
  type AppSettings,
  type BrowserSettings,
  type ProjectConfig,
  type ProxyConfig,
} from '../shared';
import type { ProjectId, ProxyId, ServerId } from '../shared';
import { resolveConfiguredAgentId, type AgentDefinition } from '../shared';
import type { AgentId } from '../shared';
import {
  HOST_PROXY_NONE,
  hostProxyIdSchema,
  newProxyId,
  originSchema,
  parseOrigin,
  projectIdSchema,
  proxyIdSchema,
  serverIdSchema,
  serverLabelSchema,
} from '../shared';
import { err, ok, type Result } from '../shared';
import {
  agentIdSchema,
  modelIdSchema,
  reasoningEffortSchema,
  serverColorSchema,
  serverRevisionSchema,
  tlsExceptionSchema,
} from '../shared';
import {
  bumpRevision,
  proxyConfigSchema,
  serverConfigSchema,
  updatePresentation,
  type ServerColor,
  type ServerConfig,
  type ServerPresentationChanges,
  type ServerTargetingChanges,
} from '../shared';

/**
 * Persistence and mutation orchestration for {@link AppSettings}
 * (implementation-plan.md step 04, requirements-decisions.md sections 7 and
 * 8). Validation, presentation-only edits, and revision-bumping targeting
 * edits are already implemented in `src/shared/contracts/appSettings.ts` and
 * `serverConfig.ts`; this module is only responsible for turning those into a
 * safely-persisted file and for the additional rules that only make sense at
 * the storage boundary (atomic writes, corruption handling, and origin-change
 * confirmation).
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
  /** Valid JSON, but it fails `parseAppSettings`. */
  'schema_invalid',
] as const;

export type SettingsLoadErrorKind = (typeof SETTINGS_LOAD_ERROR_KINDS)[number];

export interface SettingsLoadError {
  readonly kind: SettingsLoadErrorKind;
  readonly message: string;
  readonly filePath: string;
}

export type SettingsLoadStatus = 'defaults' | 'loaded';

export interface SettingsLoadOutcome {
  readonly settings: AppSettings;
  /** `"defaults"`: no file existed (first run). `"loaded"`: a file was read and validated. */
  readonly status: SettingsLoadStatus;
}

/**
 * Deterministic `ProxyId` for a proxy entry whose own `id` could not be read.
 * Derived from the address and position rather than minted randomly so the
 * same repaired file yields the same id on every launch: `loadSettings` never
 * writes, so a random id would change on each start until some other change
 * happened to persist the document.
 */
function repairedProxyId(url: string, index: number): ProxyId {
  const digest = createHash('sha256')
    .update(`${url}#${String(index)}`)
    .digest('hex')
    .slice(0, 32);
  return newProxyId(() => `repaired-${digest}`);
}

/**
 * Fills in the identity fields (`id`, `label`) a proxy-library entry is
 * missing, so a hand-edited file that moved the old single `copilotProxy`
 * node into `proxies` (keeping `url`/`credentials` but not the newer
 * `id`/`label`) still loads instead of failing the whole document.
 *
 * Deliberately narrow and non-destructive:
 *
 *  - Only `id` and `label` are repaired. `label` defaults to the entry's
 *    address, exactly as a blank label does in the Settings UI; a missing
 *    `id` is derived deterministically (see {@link repairedProxyId}).
 *  - Every other key is left exactly as written, so a file smuggling an
 *    unexpected field (e.g. a plaintext `password`) still fails the strict
 *    schema rather than being silently stripped and accepted.
 *  - An entry that is not an object, or whose `url` is not a valid origin, is
 *    dropped: there is no address to label it with and nothing usable to keep.
 *
 * Pure and I/O-free. Returns the input untouched when there is nothing to
 * repair, so a healthy document is byte-for-byte the same value.
 */
export function repairProxyEntries(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const document = raw as Record<string, unknown>;
  const proxies = document['proxies'];
  if (!Array.isArray(proxies)) return raw;

  let changed = false;
  const repaired: unknown[] = [];
  proxies.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      changed = true;
      return;
    }
    const record = entry as Record<string, unknown>;
    const url = originSchema.safeParse(record['url']);
    if (!url.success) {
      changed = true;
      return;
    }
    const next: Record<string, unknown> = { ...record };
    if (!proxyIdSchema.safeParse(next['id']).success) {
      next['id'] = repairedProxyId(url.data, index);
      changed = true;
    }
    if (!serverLabelSchema.safeParse(next['label']).success) {
      next['label'] = url.data;
      changed = true;
    }
    repaired.push(next);
  });

  if (!changed) return raw;
  return { ...document, proxies: repaired };
}

/**
 * Keys this build recognises in each object of the persisted document. Anything
 * else is stripped by {@link normalizeSettingsDocument} so a hand-edit that
 * introduces an unrecognised key (a typo, a leftover from an older shape) does
 * not fail the whole load.
 */
const SETTINGS_DOCUMENT_KEYS = [
  'hosts',
  'projects',
  'proxies',
  'agents',
  'browser',
  'memos',
  'updates',
] as const;
const SERVER_ENTRY_KEYS = [
  'id',
  'label',
  'origin',
  'color',
  'proxyId',
  'tlsException',
  'projectId',
  'revision',
] as const;
const PROJECT_ENTRY_KEYS = [
  'id',
  'label',
  'contentRoots',
  'componentRoots',
  'contentPriorityPaths',
  'damRoots',
] as const;
const PROXY_ENTRY_KEYS = ['id', 'label', 'url', 'credentials'] as const;
const AGENT_ENTRY_KEYS = ['active', 'proxy', 'model', 'reasoningEffort', 'token'] as const;
const BROWSER_ENTRY_KEYS = ['disableNativeWebAuthn', 'proxy'] as const;
const MEMO_ENTRY_KEYS = ['enabled'] as const;
const UPDATE_ENTRY_KEYS = ['url', 'checkOnStartup'] as const;

/** Matches the Settings UI default and a fresh entry's colour. */
const DEFAULT_SERVER_COLOR: ServerColor = { kind: 'swatch', swatch: 'blue' };
const LABEL_MAX_LENGTH = 100;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A shallow copy of `source` carrying only `keys` — unknown keys are dropped. */
function pickKnownKeys(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      picked[key] = source[key];
    }
  }
  return picked;
}

/** A default label for a host, derived from its origin exactly as the toolbar's "add host" flow does. */
function labelFromOrigin(origin: string): string {
  try {
    return new URL(origin).host.slice(0, LABEL_MAX_LENGTH);
  } catch {
    return origin.slice(0, LABEL_MAX_LENGTH);
  }
}

/** Matches `environmentRootTextSchema`'s bound in `serverConfig.ts`. */
const ROOT_TEXT_MAX_LENGTH = 2000;

/**
 * Trims a usable roots line out of a hand-written value, or `undefined` when
 * there is nothing usable. Empty/whitespace values are dropped - the same as
 * omitting the field - so an explicit clear survives only in memory and is
 * gone from the document on the next load.
 */
function normalizeRootText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, ROOT_TEXT_MAX_LENGTH);
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Trims a usable label out of a hand-written value, falling back to the origin's host. */
function normalizeLabel(value: unknown, origin: string): string {
  if (typeof value === 'string') {
    const trimmed = value.trim().slice(0, LABEL_MAX_LENGTH);
    if (trimmed.length > 0) return trimmed;
  }
  return labelFromOrigin(origin);
}

/**
 * Normalizes one host's proxy selection. The three persisted states are
 * "absent" (Default), the literal {@link HOST_PROXY_NONE} ("No proxy"), and a
 * proxy-library entry id. A hand-edit that writes a falsy value (`null`, `""`)
 * is treated as "absent" (Default), exactly as the reader is forgiving
 * elsewhere; `"none"` is kept; a real id is kept only when it names a
 * configured entry, otherwise the whole reference is dropped - which reverts
 * the host to "(Default)" rather than failing the load.
 */
function normalizeHostProxyId(
  value: unknown,
  proxyIds: ReadonlySet<string>,
): Record<string, unknown> {
  if (value === HOST_PROXY_NONE) return { proxyId: HOST_PROXY_NONE };
  const proxyId = hostProxyIdSchema.safeParse(value);
  if (proxyId.success && proxyId.data !== HOST_PROXY_NONE && proxyIds.has(proxyId.data)) {
    return { proxyId: proxyId.data };
  }
  return {};
}

/**
 * Normalizes one host's project selection: a real project id is kept only when
 * it names a configured project, otherwise the whole reference is dropped -
 * which reverts the host to "(Default)" rather than failing the load. There is
 * no sentinel here (unlike `proxyId`): absent is the only "no project" state.
 */
function normalizeHostProjectId(
  value: unknown,
  projectIds: ReadonlySet<string>,
): Record<string, unknown> {
  const projectId = projectIdSchema.safeParse(value);
  if (projectId.success && projectIds.has(projectId.data)) {
    return { projectId: projectId.data };
  }
  return {};
}

/** Trims a usable label out of a hand-written value, or `undefined` when there is none. */
function normalizeTextLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, LABEL_MAX_LENGTH);
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalizes one project-library entry. A project has no address to derive a
 * label from, so an entry with no usable `id` or `label` is dropped entirely
 * (the caller then clears any host that referenced it). Roots are normalized
 * like a host's used to be; every other key is stripped.
 */
function normalizeProjectEntry(entry: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(entry)) return undefined;
  const record = pickKnownKeys(entry, PROJECT_ENTRY_KEYS);

  const id = projectIdSchema.safeParse(record['id']);
  if (!id.success) return undefined;

  const label = normalizeTextLabel(record['label']);
  if (label === undefined) return undefined;

  const next: Record<string, unknown> = { id: id.data, label };
  const contentRoots = normalizeRootText(record['contentRoots']);
  if (contentRoots !== undefined) next['contentRoots'] = contentRoots;
  const componentRoots = normalizeRootText(record['componentRoots']);
  if (componentRoots !== undefined) next['componentRoots'] = componentRoots;
  const contentPriorityPaths = normalizeRootText(record['contentPriorityPaths']);
  if (contentPriorityPaths !== undefined) next['contentPriorityPaths'] = contentPriorityPaths;
  const damRoots = normalizeRootText(record['damRoots']);
  if (damRoots !== undefined) next['damRoots'] = damRoots;
  return next;
}

/**
 * Normalizes one host entry, or returns `undefined` when it cannot be made
 * usable (no valid `id` or `origin`) — the caller drops it. Every other field
 * gets a default: a missing colour is blue, a missing revision is 0, a missing
 * or unusable label is derived from the origin.
 */
function normalizeServerEntry(
  entry: unknown,
  proxyIds: ReadonlySet<string>,
  projectIds: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (!isPlainObject(entry)) return undefined;
  const record = pickKnownKeys(entry, SERVER_ENTRY_KEYS);

  const id = serverIdSchema.safeParse(record['id']);
  if (!id.success) return undefined;

  if (typeof record['origin'] !== 'string') return undefined;
  const origin = parseOrigin(record['origin']);
  if (!origin.ok) return undefined;

  const color = serverColorSchema.safeParse(record['color']);
  const revision = serverRevisionSchema.safeParse(record['revision']);

  const next: Record<string, unknown> = {
    id: id.data,
    origin: origin.origin,
    label: normalizeLabel(record['label'], origin.origin),
    color: color.success ? color.data : DEFAULT_SERVER_COLOR,
    revision: revision.success ? revision.data : 0,
    ...normalizeHostProxyId(record['proxyId'], proxyIds),
    ...normalizeHostProjectId(record['projectId'], projectIds),
  };

  const tlsException = tlsExceptionSchema.safeParse(record['tlsException']);
  if (tlsException.success) next['tlsException'] = tlsException.data;

  return next;
}

/**
 * Strips unknown keys from one proxy-library entry after
 * {@link repairProxyEntries} has supplied its identity fields. `credentials`
 * is copied through untouched so the strict credentials schema still rejects a
 * smuggled plaintext `password`.
 */
function normalizeProxyEntry(entry: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(entry)) return undefined;
  return pickKnownKeys(entry, PROXY_ENTRY_KEYS);
}

/**
 * Normalizes one agent node. `active` defaults to `false`; a dangling `proxy`
 * reference is cleared; a `reasoningEffort` with no `model` to attach to is
 * dropped (the strict schema requires the pair). The `token` object is copied
 * through untouched, like a proxy's `credentials`: the strict
 * `agentTokenSchema` must still reject a hand-written plaintext token, so a
 * bug that persists one cannot be silently stripped.
 */
function normalizeAgentEntry(
  value: unknown,
  proxyIds: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const record = pickKnownKeys(value, AGENT_ENTRY_KEYS);

  const next: Record<string, unknown> = { active: record['active'] === true };

  const proxy = proxyIdSchema.safeParse(record['proxy']);
  if (proxy.success && proxyIds.has(proxy.data)) next['proxy'] = proxy.data;

  const model = modelIdSchema.safeParse(record['model']);
  if (model.success) next['model'] = model.data;

  const effort = reasoningEffortSchema.safeParse(record['reasoningEffort']);
  if (model.success && effort.success) next['reasoningEffort'] = effort.data;

  if (record['token'] !== undefined) next['token'] = record['token'];

  return next;
}

/**
 * Makes a hand-edited settings document loadable by filling every missing
 * field with a default and discarding what cannot be made usable, so that any
 * JSON-valid file remains loadable. This is the *only* place the application
 * is forgiving about the persisted document's shape: the contract schemas
 * themselves stay strict, and the result of this function is still validated
 * by {@link parseAppSettings} before it is trusted.
 *
 * What it does, in order:
 *
 *  - Deletes unrecognised keys at every level it manages, except inside a
 *    `credentials` object — that stays untouched so a plaintext `password`
 *    still fails the strict schema rather than being silently stripped.
 *  - Defaults the top-level `hosts`/`projects`/`proxies` to `[]` and `agents`
 *    to the default provider when they are missing or the wrong shape.
 *  - Repairs proxy entries (via {@link repairProxyEntries}) and drops entries
 *    with no usable address.
 *  - Drops a project entry with no usable `id` or `label`.
 *  - Drops a host with no usable `id`/`origin`, and fills its label, colour
 *    and revision.
 *  - Clears a host's reference to a project that does not exist, a host's or
 *    agent's reference to a proxy that does not exist, and an agent's
 *    `reasoningEffort` that has no `model`.
 *  - Keeps only the first active agent and the first of any duplicated host id,
 *    host origin, project id or proxy id, so an integrity slip cannot fail the
 *    load.
 *
 * Never writes anything. A healthy document is reconstructed (key order is not
 * preserved), but its values are unchanged.
 */
export function normalizeSettingsDocument(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const repaired = repairProxyEntries(raw);
  if (!isPlainObject(repaired)) return repaired;
  const document = pickKnownKeys(repaired, SETTINGS_DOCUMENT_KEYS);

  const proxies: Record<string, unknown>[] = [];
  const proxyIds = new Set<string>();
  const proxiesRaw = Array.isArray(document['proxies']) ? document['proxies'] : [];
  for (const entry of proxiesRaw) {
    const normalized = normalizeProxyEntry(entry);
    const id = normalized?.['id'];
    if (!normalized || typeof id !== 'string' || proxyIds.has(id)) continue;
    proxyIds.add(id);
    proxies.push(normalized);
  }

  const projects: Record<string, unknown>[] = [];
  const projectIds = new Set<string>();
  const projectsRaw = Array.isArray(document['projects']) ? document['projects'] : [];
  for (const entry of projectsRaw) {
    const normalized = normalizeProjectEntry(entry);
    const id = normalized?.['id'];
    if (!normalized || typeof id !== 'string' || projectIds.has(id)) continue;
    projectIds.add(id);
    projects.push(normalized);
  }

  const hosts: Record<string, unknown>[] = [];
  const serverIds = new Set<string>();
  const serverOrigins = new Set<string>();
  const hostsRaw = Array.isArray(document['hosts']) ? document['hosts'] : [];
  for (const entry of hostsRaw) {
    const normalized = normalizeServerEntry(entry, proxyIds, projectIds);
    const id = normalized?.['id'];
    const origin = normalized?.['origin'];
    if (
      !normalized ||
      typeof id !== 'string' ||
      typeof origin !== 'string' ||
      serverIds.has(id) ||
      serverOrigins.has(origin)
    ) {
      continue;
    }
    serverIds.add(id);
    serverOrigins.add(origin);
    hosts.push(normalized);
  }

  const agentsSource: Record<string, unknown> = isPlainObject(document['agents'])
    ? document['agents']
    : {};
  const agents: Record<string, Record<string, unknown>> = {};
  let activeSeen = false;
  for (const [key, value] of Object.entries(agentsSource)) {
    const id = agentIdSchema.safeParse(key);
    const normalized = normalizeAgentEntry(value, proxyIds);
    if (!id.success || !normalized) continue;
    if (normalized['active'] === true) {
      if (activeSeen) normalized['active'] = false;
      else activeSeen = true;
    }
    agents[id.data] = normalized;
  }

  // The browser flags are a flat object of booleans plus the optional default
  // proxy. A non-boolean flag is dropped rather than passed on, and a default
  // proxy naming a missing entry is dropped (no default), so a hand-edit
  // cannot fail the whole load - the schema then restores the defaults.
  const browserSource = pickKnownKeys(
    isPlainObject(document['browser']) ? document['browser'] : {},
    BROWSER_ENTRY_KEYS,
  );
  const browser: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(browserSource)) {
    if (key === 'proxy') continue;
    if (typeof value === 'boolean') browser[key] = value;
  }
  const browserProxy = proxyIdSchema.safeParse(browserSource['proxy']);
  if (browserProxy.success && proxyIds.has(browserProxy.data)) {
    browser['proxy'] = browserProxy.data;
  }

  // Self-learning is one boolean; a non-boolean is dropped (default on).
  const memoSource = pickKnownKeys(
    isPlainObject(document['memos']) ? document['memos'] : {},
    MEMO_ENTRY_KEYS,
  );
  const memos: Record<string, unknown> = {};
  if (typeof memoSource['enabled'] === 'boolean') memos['enabled'] = memoSource['enabled'];

  // A custom update URL that is not a valid https URL is dropped (built-ins
  // only) and a non-boolean startup flag is dropped (default off), so a
  // hand-edit cannot fail the whole load.
  const updateSource = pickKnownKeys(
    isPlainObject(document['updates']) ? document['updates'] : {},
    UPDATE_ENTRY_KEYS,
  );
  const updates: Record<string, unknown> = {};
  if (updateUrlSchema.safeParse(updateSource['url']).success) updates['url'] = updateSource['url'];
  if (typeof updateSource['checkOnStartup'] === 'boolean') {
    updates['checkOnStartup'] = updateSource['checkOnStartup'];
  }

  return {
    hosts,
    projects,
    proxies,
    agents,
    browser,
    memos,
    updates,
  };
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
 *
 * The one exception to "the file is loaded exactly as written" is
 * {@link normalizeSettingsDocument}: missing fields are defaulted, unknown
 * keys are stripped, and unusable entries are dropped in memory (never written
 * back here), so a hand-edited file cannot make the whole settings load fail.
 * A `credentials` object is left untouched so a plaintext `password` still
 * fails the strict schema.
 */
export async function loadSettings(
  settingsDir: string,
): Promise<Result<SettingsLoadOutcome, SettingsLoadError>> {
  const filePath = settingsFilePath(settingsDir);

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

  // Fill in missing fields with defaults, strip unknown keys, and drop whatever
  // cannot be made usable, so a hand-edited file does not fail the whole load.
  // A `credentials` object is never stripped, so a smuggled plaintext password
  // still fails in `parseAppSettings` below.
  const parsedSettings = parseAppSettings(normalizeSettingsDocument(parsedJson));
  if (!parsedSettings.ok) {
    return err({
      kind: 'schema_invalid',
      message: parsedSettings.error.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      filePath,
    });
  }

  return ok({ status: 'loaded', settings: parsedSettings.value });
}

/**
 * Synchronous counterpart of {@link loadSettings}, for the one decision that
 * must be made before Electron is ready: whether to disable the native Windows
 * WebAuthn API (`src/main/index.ts`). Chromium reads its feature switches once,
 * at process start, so the persisted flag cannot be read asynchronously.
 *
 * Never fails: a missing or damaged file yields {@link defaultAppSettings},
 * because a settings file must not be able to block startup, and the default
 * (`disableNativeWebAuthn: true`) is the safe direction. Any real problem is
 * still reported by the ordinary async {@link loadSettings} path.
 */
export function loadSettingsSync(settingsDir: string): AppSettings {
  let raw: string;
  try {
    raw = readFileSync(settingsFilePath(settingsDir), 'utf8');
  } catch {
    return defaultAppSettings();
  }
  try {
    const parsed = parseAppSettings(normalizeSettingsDocument(JSON.parse(raw)));
    return parsed.ok ? parsed.value : defaultAppSettings();
  } catch {
    return defaultAppSettings();
  }
}

/**
 * Applies a `settings:update-browser-settings` patch to a document and returns
 * the updated document. Pure: the caller persists it. An omitted key means
 * "leave unchanged"; `proxy: null` clears the default proxy (direct), a
 * {@link ProxyId} sets it.
 */
export function applyBrowserSettingsChange(
  settings: AppSettings,
  changes: {
    readonly disableNativeWebAuthn?: boolean | undefined;
    readonly proxy?: ProxyId | null | undefined;
  },
): AppSettings {
  let browser: BrowserSettings =
    changes.disableNativeWebAuthn === undefined
      ? settings.browser
      : { ...settings.browser, disableNativeWebAuthn: changes.disableNativeWebAuthn };

  if (changes.proxy !== undefined) {
    const next: Record<string, unknown> = { ...browser };
    if (changes.proxy === null) {
      delete next['proxy'];
    } else {
      next['proxy'] = changes.proxy;
    }
    browser = browserSettingsSchema.parse(next);
  }

  return { ...settings, browser };
}

/**
 * Applies a `settings:update-memo-settings` patch to a document and returns
 * the updated document. Pure: the caller persists it.
 */
export function applyMemoSettingsChange(
  settings: AppSettings,
  changes: { readonly enabled?: boolean | undefined },
): AppSettings {
  if (changes.enabled === undefined) return settings;
  return { ...settings, memos: { ...settings.memos, enabled: changes.enabled } };
}

/**
 * Applies a `settings:update-update-settings` patch to a document and returns
 * the updated document. Pure: the caller persists it. An omitted key means
 * "leave unchanged"; `url: null` clears the custom update folder.
 */
export function applyUpdateSettingsChange(
  settings: AppSettings,
  changes: {
    readonly url?: string | null | undefined;
    readonly checkOnStartup?: boolean | undefined;
  },
): AppSettings {
  const next: Record<string, unknown> = { ...settings.updates };
  if (changes.checkOnStartup !== undefined) next['checkOnStartup'] = changes.checkOnStartup;
  if (changes.url === null) delete next['url'];
  else if (changes.url !== undefined) next['url'] = changes.url;
  return { ...settings, updates: updateSettingsSchema.parse(next) };
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
  /** No proxy-library entry with the given id exists in these settings. */
  'proxy_not_found',
  /** No project-library entry with the given id exists in these settings. */
  'project_not_found',
] as const;

export type ServerMutationErrorKind = (typeof SERVER_MUTATION_ERROR_KINDS)[number];

export interface ServerMutationError {
  readonly kind: ServerMutationErrorKind;
  readonly message: string;
}

function findServer(settings: AppSettings, serverId: ServerId): ServerConfig | undefined {
  return settings.hosts.find((server) => server.id === serverId);
}

/**
 * Replaces one server entry and re-validates the whole document (e.g. to
 * catch an origin change that collides with another configured server -
 * requirements-decisions.md section 7 forbids merging two entries that end
 * up sharing an origin). `appSettingsSchema.safeParse` is used instead of a
 * bare object spread so this validation can never be silently skipped.
 */
function withUpdatedServer(settings: AppSettings, updated: ServerConfig): Result<AppSettings> {
  const nextServers = settings.hosts.map((server) => (server.id === updated.id ? updated : server));
  const candidate = { ...settings, hosts: nextServers };
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
  /** Optional project id captured while the row was a draft ("(Default)" is the absence of this key). */
  readonly projectId?: ProjectId;
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
  if (settings.hosts.some((server) => server.origin === input.origin)) {
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
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      revision: 0,
    });
  } catch (error) {
    return err({ kind: 'invalid_change', message: describeThrown(error) });
  }

  const parsed = appSettingsSchema.safeParse({
    ...settings,
    hosts: [...settings.hosts, candidate],
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

/** Removes a server entry, returning the updated settings for the caller to persist. */
export function removeServer(
  settings: AppSettings,
  serverId: ServerId,
): Result<AppSettings, ServerMutationError> {
  const server = findServer(settings, serverId);
  if (!server) {
    return err({ kind: 'server_not_found', message: `no server with id ${serverId}` });
  }

  const candidate = {
    ...settings,
    hosts: settings.hosts.filter((existing) => existing.id !== serverId),
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

  return ok(parsed.data);
}

/**
 * Reorders the configured servers to exactly the order given by `orderedIds`
 * (the Settings "Hosts" multifield's up/down actions).
 *
 * The argument is the whole desired order, not one up/down step, so the order
 * persisted is the one the user is looking at. It must be a *permutation* of
 * the configured ids: every configured id exactly once, no unknown id, none
 * missing. Anything else is rejected as `invalid_change` rather than being
 * partially applied - a partial application would silently drop servers from
 * the document, which is a data-loss bug, not a validation nicety.
 *
 * Order is presentation only. `revision` is untouched on every server (it
 * exists to signal a change in *where/how* a server is reached, and nothing
 * about reaching it changed), and `activeServerId` is untouched too - the
 * active server is identified by id, never by position.
 */
export function reorderServers(
  settings: AppSettings,
  orderedIds: readonly ServerId[],
): Result<AppSettings, ServerMutationError> {
  if (orderedIds.length !== settings.hosts.length) {
    return err({
      kind: 'invalid_change',
      message:
        `the requested order lists ${String(orderedIds.length)} server(s), but ` +
        `${String(settings.hosts.length)} are configured; the order must list every server exactly once`,
    });
  }

  const byId = new Map(settings.hosts.map((server) => [server.id, server]));
  const seen = new Set<string>();
  const reordered: ServerConfig[] = [];
  for (const id of orderedIds) {
    if (seen.has(id)) {
      return err({
        kind: 'invalid_change',
        message: `duplicate server id in the requested order: ${id}`,
      });
    }
    seen.add(id);
    const server = byId.get(id);
    if (!server) {
      return err({ kind: 'invalid_change', message: `no server with id ${id}` });
    }
    reordered.push(server);
  }

  const parsed = appSettingsSchema.safeParse({ ...settings, hosts: reordered });
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

// ---------------------------------------------------------------------------
// Proxy library (the `proxies` array)
// ---------------------------------------------------------------------------

/**
 * Deterministic `secretRef` for one proxy-library entry's credentials. Unlike
 * the old single fixed key, each entry needs its own: scoping it by the
 * entry's permanent id (mirroring how a server's host proxy is scoped by the
 * server id) keeps it stable across label/address edits and reorders, and
 * means a freshly-created entry can name its secret before any password is
 * stored.
 */
export function proxySecretRef(proxyId: ProxyId): string {
  return `proxy:${proxyId}`;
}

/**
 * Deterministic `secretRef` for one provider's personal-access token. Scoping
 * it by the provider's permanent id keeps it stable across every other edit,
 * and lets the IPC layer name the secret before any token is stored.
 */
export function agentTokenSecretRef(agentId: AgentId): string {
  return `agent-token:${agentId}`;
}

export interface NewProxyInput {
  readonly label: string;
  readonly url: string;
  /** `undefined` means "no username configured" (no credentials object). */
  readonly username?: string;
}

/**
 * Creates a new proxy-library entry at the end of the list, optionally with
 * credentials (and so a fresh `secretRef`). The password itself is stored
 * separately through `settings:set-password`; a credentials object with
 * no secret stored under its ref is a valid intermediate state (`hasPassword`
 * simply reads `false`).
 */
export function addProxy(
  settings: AppSettings,
  newId: ProxyId,
  input: NewProxyInput,
): Result<{ readonly settings: AppSettings; readonly proxy: ProxyConfig }, ServerMutationError> {
  let candidate: ProxyConfig;
  try {
    candidate = proxyConfigSchema.parse({
      id: newId,
      label: input.label,
      url: input.url,
      ...(input.username !== undefined
        ? { credentials: { username: input.username, secretRef: proxySecretRef(newId) } }
        : {}),
    });
  } catch (error) {
    return err({ kind: 'invalid_change', message: describeThrown(error) });
  }

  const parsed = appSettingsSchema.safeParse({
    ...settings,
    proxies: [...settings.proxies, candidate],
  });
  if (!parsed.success) {
    return err({
      kind: 'invalid_change',
      message: parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    });
  }

  return ok({ settings: parsed.data, proxy: candidate });
}

export interface UpdateProxyOutcome {
  readonly settings: AppSettings;
  readonly proxy: ProxyConfig;
  /**
   * Set when this call just removed credentials that existed before (no
   * `username` supplied this time): the secretRef they used to point at,
   * now unreachable from `settings`. This module has no I/O of its own, so
   * it cannot delete the orphaned password itself - `ipc/settings.ts` uses
   * this to also clear it from `secretStore`, the same hygiene
   * `clearPassword` already performs for an explicit clear.
   */
  readonly orphanedSecretRef?: string;
}

/**
 * Replaces one proxy-library entry's label, address and (optionally) username.
 * This is a full replace, not a partial patch - matching
 * `updateProxyRequestSchema`'s shape. Omitting `username` therefore removes
 * any existing credentials entirely, not merely "leaves them unchanged"; the
 * password itself is set separately, through `settings:set-password`
 * targeting `{ kind: "proxy", proxyId }`.
 *
 * A pre-existing `secretRef` is preserved when a username is supplied (so a
 * simple username edit does not orphan and re-prompt for a password that is
 * otherwise unchanged).
 */
export function updateProxy(
  settings: AppSettings,
  proxyId: ProxyId,
  input: NewProxyInput,
): Result<UpdateProxyOutcome, ServerMutationError> {
  const existing = settings.proxies.find((proxy) => proxy.id === proxyId);
  if (!existing) {
    return err({ kind: 'proxy_not_found', message: `no proxy with id ${proxyId}` });
  }
  const existingCredentials = existing.credentials;

  let updated: ProxyConfig;
  try {
    updated = proxyConfigSchema.parse({
      id: proxyId,
      label: input.label,
      url: input.url,
      ...(input.username !== undefined
        ? {
            credentials: {
              username: input.username,
              secretRef: existingCredentials?.secretRef ?? proxySecretRef(proxyId),
            },
          }
        : {}),
    });
  } catch (error) {
    return err({ kind: 'invalid_change', message: describeThrown(error) });
  }

  const nextProxies = settings.proxies.map((proxy) => (proxy.id === proxyId ? updated : proxy));
  const parsed = appSettingsSchema.safeParse({ ...settings, proxies: nextProxies });
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
    proxy: updated,
    ...(orphanedSecretRef !== undefined ? { orphanedSecretRef } : {}),
  });
}

export interface RemoveProxyOutcome {
  readonly settings: AppSettings;
  /** The removed entry's secretRef, if it had credentials, for best-effort secret cleanup. */
  readonly orphanedSecretRef?: string;
}

/** Removes one proxy-library entry. */
export function removeProxy(
  settings: AppSettings,
  proxyId: ProxyId,
): Result<RemoveProxyOutcome, ServerMutationError> {
  const existing = settings.proxies.find((proxy) => proxy.id === proxyId);
  if (!existing) {
    return err({ kind: 'proxy_not_found', message: `no proxy with id ${proxyId}` });
  }

  // Clear the reference from every host that named it, in the same write:
  // `appSettingsSchema` rejects a host whose `proxyId` names a missing proxy,
  // so removing the entry without this would make the document invalid. The
  // host reverts to "(Default)" (the `proxyId` key is deleted), which is the
  // documented meaning of an absent reference.
  const nextHosts: unknown[] = settings.hosts.map((host) => {
    if (host.proxyId !== proxyId) return host;
    const cleared: Record<string, unknown> = { ...host };
    delete cleared['proxyId'];
    return cleared;
  });

  // The browser default proxy must not dangle either: clearing it reverts to
  // "no default proxy" (direct), the same as an absent key.
  const nextBrowser: Record<string, unknown> = { ...settings.browser };
  if (settings.browser.proxy === proxyId) {
    delete nextBrowser['proxy'];
  }

  // An agent's `proxy` reference is validated the same way, so it must be
  // cleared in the same write too - otherwise removing an entry the active
  // agent uses would be refused as `invalid_change` rather than applied.
  const nextAgents: Record<string, unknown> = {};
  for (const [agentId, node] of Object.entries(settings.agents)) {
    if (node.proxy !== proxyId) {
      nextAgents[agentId] = node;
      continue;
    }
    const cleared: Record<string, unknown> = { ...node };
    delete cleared['proxy'];
    nextAgents[agentId] = cleared;
  }

  const parsed = appSettingsSchema.safeParse({
    ...settings,
    hosts: nextHosts,
    browser: nextBrowser,
    agents: nextAgents,
    proxies: settings.proxies.filter((proxy) => proxy.id !== proxyId),
  });
  if (!parsed.success) {
    return err({
      kind: 'invalid_change',
      message: parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    });
  }

  const orphanedSecretRef = existing.credentials?.secretRef;
  return ok({
    settings: parsed.data,
    ...(orphanedSecretRef !== undefined ? { orphanedSecretRef } : {}),
  });
}

/**
 * Reorders the proxy library to exactly the order given by `orderedIds`.
 * Mirrors {@link reorderServers}: the whole desired order, validated as a
 * permutation (every configured id exactly once, no unknown id, none missing)
 * so a mismatch is rejected rather than partially applied.
 */
export function reorderProxies(
  settings: AppSettings,
  orderedIds: readonly ProxyId[],
): Result<AppSettings, ServerMutationError> {
  if (orderedIds.length !== settings.proxies.length) {
    return err({
      kind: 'invalid_change',
      message:
        `the requested order lists ${String(orderedIds.length)} proxy(ies), but ` +
        `${String(settings.proxies.length)} are configured; the order must list every proxy exactly once`,
    });
  }

  const byId = new Map(settings.proxies.map((proxy) => [proxy.id, proxy]));
  const seen = new Set<string>();
  const reordered: ProxyConfig[] = [];
  for (const id of orderedIds) {
    if (seen.has(id)) {
      return err({
        kind: 'invalid_change',
        message: `duplicate proxy id in the requested order: ${id}`,
      });
    }
    seen.add(id);
    const proxy = byId.get(id);
    if (!proxy) {
      return err({ kind: 'invalid_change', message: `no proxy with id ${id}` });
    }
    reordered.push(proxy);
  }

  const parsed = appSettingsSchema.safeParse({ ...settings, proxies: reordered });
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

// ---------------------------------------------------------------------------
// Projects library (the `projects` array)
// ---------------------------------------------------------------------------

export interface NewProjectInput {
  readonly label: string;
  /** Optional free-text content roots (omitted/empty means "no roots written"). */
  readonly contentRoots?: string;
  /** Optional free-text component roots. */
  readonly componentRoots?: string;
  /** Optional free-text content priority paths. */
  readonly contentPriorityPaths?: string;
  /** Optional free-text DAM roots (omitted/empty means "use the `/content/dam` default"). */
  readonly damRoots?: string;
}

/**
 * Builds a project entry from `input`, dropping empty root strings (the same as
 * omitting the field). Shared by {@link addProject}/{@link updateProject} so the
 * two cannot diverge on what "no roots" looks like.
 */
function buildProject(
  id: ProjectId,
  input: NewProjectInput,
): Result<ProjectConfig, ServerMutationError> {
  const contentRoots = input.contentRoots?.trim();
  const componentRoots = input.componentRoots?.trim();
  const contentPriorityPaths = input.contentPriorityPaths?.trim();
  const damRoots = input.damRoots?.trim();
  try {
    return ok(
      projectConfigSchema.parse({
        id,
        label: input.label,
        ...(contentRoots !== undefined && contentRoots.length > 0 ? { contentRoots } : {}),
        ...(componentRoots !== undefined && componentRoots.length > 0 ? { componentRoots } : {}),
        ...(contentPriorityPaths !== undefined && contentPriorityPaths.length > 0
          ? { contentPriorityPaths }
          : {}),
        ...(damRoots !== undefined && damRoots.length > 0 ? { damRoots } : {}),
      }),
    );
  } catch (error) {
    return err({ kind: 'invalid_change', message: describeThrown(error) });
  }
}

/** Creates a new project-library entry at the end of the list. */
export function addProject(
  settings: AppSettings,
  newId: ProjectId,
  input: NewProjectInput,
): Result<
  { readonly settings: AppSettings; readonly project: ProjectConfig },
  ServerMutationError
> {
  const built = buildProject(newId, input);
  if (!built.ok) return built;

  const parsed = appSettingsSchema.safeParse({
    ...settings,
    projects: [...settings.projects, built.value],
  });
  if (!parsed.success) {
    return err({
      kind: 'invalid_change',
      message: parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    });
  }

  return ok({ settings: parsed.data, project: built.value });
}

/**
 * Replaces one project-library entry's label and roots. This is a full
 * replace, not a partial patch - matching `updateProjectRequestSchema`'s shape,
 * so omitting a roots key clears it.
 */
export function updateProject(
  settings: AppSettings,
  projectId: ProjectId,
  input: NewProjectInput,
): Result<
  { readonly settings: AppSettings; readonly project: ProjectConfig },
  ServerMutationError
> {
  if (!settings.projects.some((project) => project.id === projectId)) {
    return err({ kind: 'project_not_found', message: `no project with id ${projectId}` });
  }

  const built = buildProject(projectId, input);
  if (!built.ok) return built;

  const nextProjects = settings.projects.map((project) =>
    project.id === projectId ? built.value : project,
  );
  const parsed = appSettingsSchema.safeParse({ ...settings, projects: nextProjects });
  if (!parsed.success) {
    return err({
      kind: 'invalid_change',
      message: parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    });
  }

  return ok({ settings: parsed.data, project: built.value });
}

/**
 * Removes one project-library entry, clearing the reference from every host
 * that named it in the same write: `appSettingsSchema` rejects a host whose
 * `projectId` names a missing project, so removing the entry without this would
 * make the document invalid. The host reverts to "(Default)" (no project, the
 * `/content`/`/apps` defaults), which is the documented meaning of an absent
 * reference.
 */
export function removeProject(
  settings: AppSettings,
  projectId: ProjectId,
): Result<AppSettings, ServerMutationError> {
  if (!settings.projects.some((project) => project.id === projectId)) {
    return err({ kind: 'project_not_found', message: `no project with id ${projectId}` });
  }

  const nextHosts: unknown[] = settings.hosts.map((host) => {
    if (host.projectId !== projectId) return host;
    const cleared: Record<string, unknown> = { ...host };
    delete cleared['projectId'];
    return cleared;
  });

  const parsed = appSettingsSchema.safeParse({
    ...settings,
    hosts: nextHosts,
    projects: settings.projects.filter((project) => project.id !== projectId),
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

/**
 * Reorders the project library to exactly the order given by `orderedIds`.
 * Mirrors {@link reorderProxies}: the whole desired order, validated as a
 * permutation (every configured id exactly once, no unknown id, none missing)
 * so a mismatch is rejected rather than partially applied.
 */
export function reorderProjects(
  settings: AppSettings,
  orderedIds: readonly ProjectId[],
): Result<AppSettings, ServerMutationError> {
  if (orderedIds.length !== settings.projects.length) {
    return err({
      kind: 'invalid_change',
      message:
        `the requested order lists ${String(orderedIds.length)} project(s), but ` +
        `${String(settings.projects.length)} are configured; the order must list every project exactly once`,
    });
  }

  const byId = new Map(settings.projects.map((project) => [project.id, project]));
  const seen = new Set<string>();
  const reordered: ProjectConfig[] = [];
  for (const id of orderedIds) {
    if (seen.has(id)) {
      return err({
        kind: 'invalid_change',
        message: `duplicate project id in the requested order: ${id}`,
      });
    }
    seen.add(id);
    const project = byId.get(id);
    if (!project) {
      return err({ kind: 'invalid_change', message: `no project with id ${id}` });
    }
    reordered.push(project);
  }

  const parsed = appSettingsSchema.safeParse({ ...settings, projects: reordered });
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
 * The provider the document is *configured* to drive: the single node in
 * `agents` whose `active` flag is set and that this build actually has, else
 * the first discovered agent when the document has no usable active node (a
 * fresh file, or a user who turned every provider's radio off). `undefined`
 * only when no agent is discovered at all, which every reader treats as "no
 * agent to drive" rather than an error.
 *
 * Deliberately *not* the renderer's notion of "the active agent": the runtime
 * must exist (and be reachable through the configured proxy) even while the
 * configured provider is signed out, otherwise it could never be signed in to.
 * What the UI shows as active is gated by eligibility - see
 * `resolveEffectiveActiveAgentId` in `src/shared/contracts/agents.ts`.
 */
export function configuredAgentId(
  settings: AppSettings,
  definitions: readonly AgentDefinition[],
): AgentId | undefined {
  return resolveConfiguredAgentId(settings.agents, definitions);
}

/**
 * A partial patch to one provider's settings, following the same three-state
 * convention `updateServerTargetingRequestSchema` uses: an omitted key means
 * "leave unchanged", `null` means "clear" (for `proxy`/`model`/
 * `reasoningEffort`), and a value means "replace".
 */
export interface AgentSettingsChanges {
  readonly active?: boolean;
  readonly proxy?: ProxyId | null;
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
}

/** Distinguishable reasons {@link updateAgentSettings} can fail. */
export const AGENT_MUTATION_ERROR_KINDS = [
  /** The change does not produce a valid settings document. */
  'invalid_change',
] as const;

export type AgentMutationErrorKind = (typeof AGENT_MUTATION_ERROR_KINDS)[number];

export interface AgentMutationError {
  readonly kind: AgentMutationErrorKind;
  readonly message: string;
}

/**
 * Applies one provider's active/proxy/model/effort change and re-validates the
 * whole document (like every other mutation helper here).
 *
 * Two cross-field rules are enforced by construction on top of the schema's own
 * `superRefine`, so the two can never disagree:
 *
 *  - Activating one provider clears every other node's `active` in the same
 *    write. The schema permits *at most* one active node; this is what makes
 *    the intended one win rather than turning the write into `invalid_change`.
 *  - Clearing `model` also clears `reasoningEffort`. The schema rejects an
 *    effort with no model, and an effort left behind after its model was
 *    cleared would silently apply to whatever model is picked next.
 *
 * Pure and I/O-free: the caller loads, applies, and saves.
 */
export function updateAgentSettings(
  settings: AppSettings,
  agentId: AgentId,
  changes: AgentSettingsChanges,
): Result<AppSettings, AgentMutationError> {
  const nextNode: Record<string, unknown> = { active: false, ...settings.agents[agentId] };

  if (changes.active !== undefined) {
    nextNode['active'] = changes.active;
  }

  if (changes.proxy !== undefined) {
    if (changes.proxy === null) {
      delete nextNode['proxy'];
    } else {
      nextNode['proxy'] = changes.proxy;
    }
  }

  if (changes.model !== undefined) {
    if (changes.model === null) {
      delete nextNode['model'];
      // An effort is only meaningful relative to a model - see this
      // function's own doc comment.
      delete nextNode['reasoningEffort'];
    } else {
      nextNode['model'] = changes.model;
      if (changes.reasoningEffort === null) {
        delete nextNode['reasoningEffort'];
      } else if (changes.reasoningEffort !== undefined) {
        nextNode['reasoningEffort'] = changes.reasoningEffort;
      }
    }
  } else if (changes.reasoningEffort !== undefined) {
    if (changes.reasoningEffort === null) {
      delete nextNode['reasoningEffort'];
    } else {
      nextNode['reasoningEffort'] = changes.reasoningEffort;
    }
  }

  const nextAgents: Record<string, unknown> = { ...settings.agents };
  nextAgents[agentId] = nextNode;
  if (changes.active === true) {
    for (const [id, node] of Object.entries(settings.agents)) {
      if (id === agentId) continue;
      nextAgents[id] = { ...node, active: false };
    }
  }

  const parsed = appSettingsSchema.safeParse({ ...settings, agents: nextAgents });
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

/**
 * Adds, replaces or clears one provider's personal-access-token *reference*.
 * The token's plaintext is never here: `token` carries only the `secretRef`
 * the IPC layer will store it under, and `null` removes the reference. Pure
 * and I/O-free, like every other mutation helper: the caller loads, applies,
 * saves, and stores or deletes the actual secret.
 *
 * A missing node is created (inactive), matching {@link updateAgentSettings}:
 * the document starts with no agent nodes, so the first write for a discovered
 * agent has to make its node. Whether the id names a real agent is the IPC
 * layer's check, against the discovered catalogue.
 */
export function updateAgentToken(
  settings: AppSettings,
  agentId: AgentId,
  token: AgentToken | null,
): Result<AppSettings, AgentMutationError> {
  const nextNode: Record<string, unknown> = { active: false, ...settings.agents[agentId] };
  if (token === null) {
    delete nextNode['token'];
  } else {
    nextNode['token'] = token;
  }

  const parsed = appSettingsSchema.safeParse({
    ...settings,
    agents: { ...settings.agents, [agentId]: nextNode },
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

/**
 * Replaces the *active* provider's model/reasoning-effort pair. The persisted
 * pair moved from a top-level `defaultModel`/`defaultReasoningEffort` to each
 * agent's own node, so this targets the `agentId` the caller resolved with
 * {@link configuredAgentId} - the provider the app is set up to drive.
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
  agentId: AgentId,
  input: ModelPreferencesInput,
): Result<AppSettings, AgentMutationError> {
  return updateAgentSettings(settings, agentId, {
    model: input.model,
    reasoningEffort: input.model === null ? null : input.reasoningEffort,
  });
}
