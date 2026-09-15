import { z } from 'zod';
import {
  APP_SETTINGS_SCHEMA_VERSION,
  modelIdSchema,
  reasoningEffortSchema,
  type AppSettings,
  type CopilotProxyConfig,
} from './appSettings';
import { serverIdSchema } from './ids';
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

/** Shared shape for both the per-server AEM proxy and the global Copilot proxy snapshots. */
const proxySnapshotSchema = z
  .object({
    url: originSchema,
    credentials: proxyCredentialsSnapshotSchema.optional(),
  })
  .strict();

export const aemProxySnapshotSchema = proxySnapshotSchema;
export type AemProxySnapshot = Readonly<z.infer<typeof aemProxySnapshotSchema>>;

export const copilotProxySnapshotSchema = proxySnapshotSchema;
export type CopilotProxySnapshot = Readonly<z.infer<typeof copilotProxySnapshotSchema>>;

export const serverSnapshotSchema = z
  .object({
    id: serverIdSchema,
    label: serverLabelSchema,
    origin: originSchema,
    color: serverColorSchema,
    proxy: aemProxySnapshotSchema.optional(),
    tlsException: tlsExceptionSchema.optional(),
    revision: serverRevisionSchema,
  })
  .strict();

export type ServerSnapshot = Readonly<z.infer<typeof serverSnapshotSchema>>;

export const appSettingsSnapshotSchema = z
  .object({
    schemaVersion: z.literal(APP_SETTINGS_SCHEMA_VERSION),
    servers: z.array(serverSnapshotSchema),
    activeServerId: serverIdSchema.nullable(),
    copilotProxy: copilotProxySnapshotSchema.optional(),
    defaultModel: modelIdSchema.nullable(),
    defaultReasoningEffort: reasoningEffortSchema.nullable(),
  })
  .strict();

export type AppSettingsSnapshot = Readonly<
  Omit<z.infer<typeof appSettingsSnapshotSchema>, 'servers'>
> & {
  readonly servers: readonly ServerSnapshot[];
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

function toProxySnapshot(
  proxy: AemProxyConfig | CopilotProxyConfig | undefined,
  hasStoredSecret: HasStoredSecret,
): AemProxySnapshot | undefined {
  if (!proxy) return undefined;
  const snapshot: Record<string, unknown> = { url: proxy.url };
  if (proxy.credentials) {
    const credentials: ProxyCredentials = proxy.credentials;
    snapshot.credentials = {
      username: credentials.username,
      hasPassword: hasStoredSecret(credentials.secretRef),
    };
  }
  return proxySnapshotSchema.parse(snapshot);
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
  const servers = settings.servers.map((server) => {
    const snapshot: Record<string, unknown> = {
      id: server.id,
      label: server.label,
      origin: server.origin,
      color: server.color,
      revision: server.revision,
    };
    const proxySnapshot = toProxySnapshot(server.proxy, hasStoredSecret);
    if (proxySnapshot) snapshot.proxy = proxySnapshot;
    if (server.tlsException) snapshot.tlsException = server.tlsException;
    return serverSnapshotSchema.parse(snapshot);
  });

  const document: Record<string, unknown> = {
    schemaVersion: settings.schemaVersion,
    servers,
    activeServerId: settings.activeServerId,
    defaultModel: settings.defaultModel,
    defaultReasoningEffort: settings.defaultReasoningEffort,
  };
  const copilotProxySnapshot = toProxySnapshot(settings.copilotProxy, hasStoredSecret);
  if (copilotProxySnapshot) document.copilotProxy = copilotProxySnapshot;

  return appSettingsSnapshotSchema.parse(document);
}
