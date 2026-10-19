import { z } from 'zod';
import {
  browserSettingsSchema,
  memoSettingsSchema,
  modelIdSchema,
  reasoningEffortSchema,
  type AgentSettings,
  type AppSettings,
  type ProxyConfig,
} from './appSettings';
import { agentIdSchema, projectIdSchema, proxyIdSchema, serverIdSchema } from './ids';
import { originSchema } from './origin';
import { environmentRootTextSchema, type ProjectConfig } from './projectConfig';
import {
  hostProxyIdSchema,
  serverColorSchema,
  serverLabelSchema,
  serverRevisionSchema,
  tlsExceptionSchema,
  type ProxyCredentials,
} from './serverConfig';

/**
 * The renderer-safe projection of {@link AppSettings} (implementation-plan.md
 * step 04: "UI snapshots must not include saved passwords. Accept a new
 * value only from the local Settings window through dedicated IPC.").
 *
 * This is what `settings:get-snapshot` (see `src/main/ipc/settings.ts`)
 * returns, and the only shape of settings the renderer ever sees. Two things
 * are removed relative to {@link AppSettings}, both on purpose:
 *
 *  - The password itself never lived here in the first place - `AppSettings`
 *    only ever carries a `secretRef` pointer (see `serverConfig.ts`'s
 *    {@link ProxyCredentials}), never the plaintext, so there is nothing to
 *    strip out at this layer. {@link proxyCredentialsSnapshotSchema} replaces
 *    it with a `hasPassword` boolean the caller supplies.
 *  - `secretRef` itself is also dropped. The renderer has no legitimate use
 *    for it (mutating which secret a proxy points at is a targeting change,
 *    out of scope for this snapshot - see `serverConfig.ts`'s
 *    `ServerTargetingChanges`), and it is an internal storage pointer, not
 *    user-facing data.
 *
 * Every schema below is `.strict()`, matching the rest of `src/shared/contracts`:
 * an object carrying an unexpected `password`/`secretRef` key is rejected by
 * `.parse`/`.safeParse` rather than silently passed through.
 */

export const proxyCredentialsSnapshotSchema = z
  .object({
    username: z.string().min(1).max(200),
    hasPassword: z.boolean(),
  })
  .strict();

export type ProxyCredentialsSnapshot = Readonly<z.infer<typeof proxyCredentialsSnapshotSchema>>;

/**
 * The renderer-safe projection of one proxy-library entry. It carries the
 * entry's `id` (so the UI can target its password and persist its order), its
 * `label` and its resolved credentials.
 */
export const proxySnapshotSchema = z
  .object({
    id: proxyIdSchema,
    label: serverLabelSchema,
    url: originSchema,
    credentials: proxyCredentialsSnapshotSchema.optional(),
  })
  .strict();

export type ProxySnapshot = Readonly<z.infer<typeof proxySnapshotSchema>>;

/**
 * The renderer-safe projection of one project-library entry. Structurally
 * identical to the persisted {@link ProjectConfig} (a project carries no secret
 * material), but kept a separate schema so the renderer's view can diverge from
 * the persisted shape without silently widening what the document accepts.
 */
export const projectSnapshotSchema = z
  .object({
    id: projectIdSchema,
    label: serverLabelSchema,
    contentRoots: environmentRootTextSchema.optional(),
    componentRoots: environmentRootTextSchema.optional(),
    contentPriorityPaths: environmentRootTextSchema.optional(),
    damRoots: environmentRootTextSchema.optional(),
  })
  .strict();

export type ProjectSnapshot = Readonly<z.infer<typeof projectSnapshotSchema>>;

export const serverSnapshotSchema = z
  .object({
    id: serverIdSchema,
    label: serverLabelSchema,
    origin: originSchema,
    color: serverColorSchema,
    /**
     * The host's proxy selection: a library entry id, `HOST_PROXY_NONE` for
     * "No proxy", or absent for "(Default)" (inherit `browser.proxy`). No
     * credentials live here - they belong to the library entry.
     */
    proxyId: hostProxyIdSchema.optional(),
    tlsException: tlsExceptionSchema.optional(),
    /**
     * The host's project selection: a project-library entry id, or absent for
     * "(Default)" (no project, so the agent is told only the `/content`/`/apps`
     * defaults).
     */
    projectId: projectIdSchema.optional(),
    revision: serverRevisionSchema,
  })
  .strict();

export type ServerSnapshot = Readonly<z.infer<typeof serverSnapshotSchema>>;

/**
 * The renderer-safe projection of the `agents` map's value. Deliberately
 * *not* an alias of the persisted {@link agentSettingsSchema}, because one
 * field differs: the persisted `token` is a `secretRef` pointer that must
 * never reach the renderer, so it is replaced here by the resolved
 * `hasToken` boolean (exactly as `ProxyCredentialsSnapshot` replaces a
 * password `secretRef` with `hasPassword`). Every other field - `active`,
 * `proxy`, `model`, `reasoningEffort` - is carried through unchanged; none of
 * them is secret.
 */
export const agentSettingsSnapshotSchema = z
  .object({
    active: z.boolean(),
    proxy: proxyIdSchema.optional(),
    model: modelIdSchema.optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
    hasToken: z.boolean().default(false),
  })
  .strict();

export type AgentSettingsSnapshot = Readonly<z.infer<typeof agentSettingsSnapshotSchema>>;

export const appSettingsSnapshotSchema = z
  .object({
    hosts: z.array(serverSnapshotSchema),
    /**
     * Defaulted to `[]` like the persisted schema, so a snapshot predating
     * projects (or hand-built in a test) still parses.
     */
    projects: z.array(projectSnapshotSchema).default([]),
    proxies: z.array(proxySnapshotSchema),
    agents: z.record(agentIdSchema, agentSettingsSnapshotSchema),
    /**
     * Structurally identical to the persisted {@link browserSettingsSchema} -
     * the Browser tab's flags carry no secret material - so it is reused
     * rather than duplicated.
     */
    browser: browserSettingsSchema,
    /** The self-learning flag; defaulted so a snapshot built without it still parses. */
    memos: memoSettingsSchema.default({ enabled: true }),
  })
  .strict();

export type AppSettingsSnapshot = Readonly<
  Omit<z.infer<typeof appSettingsSnapshotSchema>, 'hosts' | 'projects'>
> & {
  readonly hosts: readonly ServerSnapshot[];
  readonly projects: readonly ProjectSnapshot[];
};

export function parseAppSettingsSnapshot(candidate: unknown): AppSettingsSnapshot {
  return appSettingsSnapshotSchema.parse(candidate);
}

/**
 * Predicate the mapping below asks the caller for: "is there currently a
 * secret stored under this `secretRef`?". This is deliberately a plain
 * synchronous function rather than `SecretStore.has` (which is async and
 * lives in `src/main/secretStore.ts`, itself out of reach from this
 * Electron-free `src/shared` module): the caller resolves every `secretRef`
 * it cares about ahead of time (e.g. into a `Map`) so this mapping stays
 * pure and synchronous, and therefore trivially unit-testable without a real
 * secret store.
 */
export type HasStoredSecret = (secretRef: string) => boolean;

function credentialsSnapshot(
  credentials: ProxyCredentials | undefined,
  hasStoredSecret: HasStoredSecret,
): ProxyCredentialsSnapshot | undefined {
  if (!credentials) return undefined;
  return {
    username: credentials.username,
    hasPassword: hasStoredSecret(credentials.secretRef),
  };
}

function toProxySnapshot(proxy: ProxyConfig, hasStoredSecret: HasStoredSecret): ProxySnapshot {
  const snapshot: Record<string, unknown> = {
    id: proxy.id,
    label: proxy.label,
    url: proxy.url,
  };
  const credentials = credentialsSnapshot(proxy.credentials, hasStoredSecret);
  if (credentials) snapshot.credentials = credentials;
  return proxySnapshotSchema.parse(snapshot);
}

/**
 * Maps one persisted project entry to its renderer projection. A project
 * carries no secret, so this only drops absent optional fields - it exists so
 * the renderer's view is a named schema rather than an ad-hoc object.
 */
function toProjectSnapshot(project: ProjectConfig): ProjectSnapshot {
  const snapshot: Record<string, unknown> = {
    id: project.id,
    label: project.label,
  };
  if (project.contentRoots !== undefined) snapshot.contentRoots = project.contentRoots;
  if (project.componentRoots !== undefined) snapshot.componentRoots = project.componentRoots;
  if (project.contentPriorityPaths !== undefined) {
    snapshot.contentPriorityPaths = project.contentPriorityPaths;
  }
  if (project.damRoots !== undefined) snapshot.damRoots = project.damRoots;
  return projectSnapshotSchema.parse(snapshot);
}

/**
 * Maps one persisted agent node to its secret-free snapshot: the `token`
 * pointer is dropped and replaced by `hasToken`, resolved through the same
 * `hasStoredSecret` predicate the proxy credentials use.
 */
function toAgentSnapshot(node: AgentSettings, hasStoredSecret: HasStoredSecret): unknown {
  const { token, ...rest } = node;
  return {
    ...rest,
    hasToken: token !== undefined && hasStoredSecret(token.secretRef),
  };
}

/**
 * Maps persisted {@link AppSettings} to the secret-free {@link AppSettingsSnapshot}
 * the renderer is allowed to see. Pure: no Electron, no filesystem, no secret
 * store - `hasStoredSecret` is the one piece of information this function
 * needs that it cannot derive from `settings` alone.
 */
export function toAppSettingsSnapshot(
  settings: AppSettings,
  hasStoredSecret: HasStoredSecret,
): AppSettingsSnapshot {
  const hosts = settings.hosts.map((server) => {
    const snapshot: Record<string, unknown> = {
      id: server.id,
      label: server.label,
      origin: server.origin,
      color: server.color,
      revision: server.revision,
    };
    if (server.proxyId !== undefined) snapshot.proxyId = server.proxyId;
    if (server.tlsException) snapshot.tlsException = server.tlsException;
    if (server.projectId !== undefined) snapshot.projectId = server.projectId;
    return serverSnapshotSchema.parse(snapshot);
  });

  const projects = settings.projects.map((project) => toProjectSnapshot(project));

  const proxies = settings.proxies.map((proxy) => toProxySnapshot(proxy, hasStoredSecret));

  const agents: Record<string, unknown> = {};
  for (const [id, node] of Object.entries(settings.agents)) {
    agents[id] = toAgentSnapshot(node, hasStoredSecret);
  }

  const document: Record<string, unknown> = {
    hosts,
    projects,
    proxies,
    agents,
    browser: settings.browser,
    memos: settings.memos,
  };

  return appSettingsSnapshotSchema.parse(document);
}
