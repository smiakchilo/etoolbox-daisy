import { z } from 'zod';
import {
  browserSettingsSchema,
  modelIdSchema,
  reasoningEffortSchema,
  type AgentSettings,
  type AppSettings,
  type ProxyConfig,
} from './appSettings';
import { agentIdSchema, proxyIdSchema, serverIdSchema } from './ids';
import { originSchema } from './origin';
import {
  serverColorSchema,
  serverLabelSchema,
  serverRevisionSchema,
  tlsExceptionSchema,
  type AemProxyConfig,
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

/** Shared shape for the per-server AEM proxy snapshot. */
const aemProxySnapshotShape = z
  .object({
    url: originSchema,
    credentials: proxyCredentialsSnapshotSchema.optional(),
  })
  .strict();

export const aemProxySnapshotSchema = aemProxySnapshotShape;
export type AemProxySnapshot = Readonly<z.infer<typeof aemProxySnapshotSchema>>;

/**
 * The renderer-safe projection of one proxy-library entry. Unlike the AEM
 * proxy snapshot it also carries the entry's `id` (so the UI can target its
 * password and persist its order) and its `label`.
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

export const serverSnapshotSchema = z
  .object({
    id: serverIdSchema,
    label: serverLabelSchema,
    origin: originSchema,
    color: serverColorSchema,
    proxy: aemProxySnapshotSchema.optional(),
    /** Which proxy-library entry this host uses, by id; absent means "none". */
    proxyId: proxyIdSchema.optional(),
    tlsException: tlsExceptionSchema.optional(),
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
    proxies: z.array(proxySnapshotSchema),
    agents: z.record(agentIdSchema, agentSettingsSnapshotSchema),
    /**
     * Structurally identical to the persisted {@link browserSettingsSchema} -
     * the Browser tab's flags carry no secret material - so it is reused
     * rather than duplicated.
     */
    browser: browserSettingsSchema,
  })
  .strict();

export type AppSettingsSnapshot = Readonly<
  Omit<z.infer<typeof appSettingsSnapshotSchema>, 'hosts'>
> & {
  readonly hosts: readonly ServerSnapshot[];
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

function toAemProxySnapshot(
  proxy: AemProxyConfig | undefined,
  hasStoredSecret: HasStoredSecret,
): AemProxySnapshot | undefined {
  if (!proxy) return undefined;
  const snapshot: Record<string, unknown> = { url: proxy.url };
  const credentials = credentialsSnapshot(proxy.credentials, hasStoredSecret);
  if (credentials) snapshot.credentials = credentials;
  return aemProxySnapshotSchema.parse(snapshot);
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
    const proxySnapshot = toAemProxySnapshot(server.proxy, hasStoredSecret);
    if (proxySnapshot) snapshot.proxy = proxySnapshot;
    if (server.proxyId !== undefined) snapshot.proxyId = server.proxyId;
    if (server.tlsException) snapshot.tlsException = server.tlsException;
    return serverSnapshotSchema.parse(snapshot);
  });

  const proxies = settings.proxies.map((proxy) => toProxySnapshot(proxy, hasStoredSecret));

  const agents: Record<string, unknown> = {};
  for (const [id, node] of Object.entries(settings.agents)) {
    agents[id] = toAgentSnapshot(node, hasStoredSecret);
  }

  const document: Record<string, unknown> = {
    hosts,
    proxies,
    agents,
    browser: settings.browser,
  };

  return appSettingsSnapshotSchema.parse(document);
}
