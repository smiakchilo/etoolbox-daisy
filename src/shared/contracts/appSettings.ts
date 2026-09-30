import { z } from 'zod';
import { agentIdSchema, proxyIdSchema } from './ids';
import { originSchema } from './origin';
import {
  HOST_PROXY_NONE,
  proxyCredentialsSchema,
  serverConfigSchema,
  serverLabelSchema,
  type ServerConfig,
} from './serverConfig';
import { err, ok, type Result } from '../result';

/**
 * The whole persisted settings document (implementation-plan.md step 03,
 * requirements-decisions.md sections 4, 7 and 8).
 *
 * This is read back from disk on every launch and never trusted blindly: every
 * schema in this module is `.strict()` so an unrecognised key - typically a
 * sign of a file that was hand-edited or tampered with - is rejected rather
 * than silently ignored. (The reader is deliberately forgiving about *missing*
 * fields and unrecognised keys before this validation runs - see
 * `normalizeSettingsDocument` in `src/main/settingsStore.ts` - but the contract
 * itself stays strict.)
 *
 * There is deliberately no schema-version field: this application has no
 * deployed users and no backward-compatibility obligation, so the document
 * shape is free to change and there is nothing to migrate between. A leftover
 * `schemaVersion` key in a hand-edited file is simply stripped by the reader.
 */

const MODEL_ID_MAX_LENGTH = 200;

/**
 * Deliberately not a closed enum: requirements-decisions.md section 7 requires
 * available models to come from the SDK at runtime, not a hard-coded list
 * baked into this module. A stale enum here would reject a real model the SDK
 * added after this code was written.
 */
export const modelIdSchema = z.string().min(1).max(MODEL_ID_MAX_LENGTH);

const REASONING_EFFORT_MAX_LENGTH = 50;

/**
 * Same reasoning as {@link modelIdSchema}: requirements-decisions.md section 7
 * says reasoning levels, like models, come from the SDK rather than a
 * hard-coded list, so this stays a bounded string rather than a closed enum.
 */
export const reasoningEffortSchema = z.string().min(1).max(REASONING_EFFORT_MAX_LENGTH);

/**
 * One configured proxy entry in the proxies library. Hosts, the active agent
 * and the browser default all select an entry from this one library by id
 * (requirements-decisions.md section 4: a proxy is never implicitly inherited
 * between the AEM side and the Copilot side), and each selection accepts the
 * same credential-reference shape. It has no
 * `tlsException` field: unlike an AEM server, proxy TLS only ever accepts
 * correctly trusted certificates, so there is nothing here for an exception
 * to apply to.
 *
 * The library replaces the former single global Copilot proxy. It carries an
 * `id` (so a password can target one entry, and so reordering can be
 * persisted) and a `label` (defaulted from the address by the UI, exactly as
 * a host label is). Which entry the Copilot runtime actually uses is a
 * selection concern deliberately deferred, so no entry is "active" yet.
 */
export const proxyConfigSchema = z
  .object({
    id: proxyIdSchema,
    label: serverLabelSchema,
    url: originSchema,
    credentials: proxyCredentialsSchema.optional(),
  })
  .strict();

export type ProxyConfig = Readonly<z.infer<typeof proxyConfigSchema>>;

/**
 * A provider's stored personal-access-token *reference*. Like a proxy's
 * {@link proxyCredentialsSchema} this is a pointer, never the token itself:
 * the plaintext lives in the OS-backed secret store (see
 * `src/main/secretStore.ts`), and `settings.json` records only the `secretRef`
 * it is filed under. `.strict()` plus the absence of any `token` string field
 * means a hand-written plaintext token is rejected by the document schema
 * rather than silently persisted.
 *
 * The presence of this object does not mean a token is actually stored - the
 * secret may have been cleared underneath it - so the renderer is told a
 * resolved `hasToken` boolean (see `settingsSnapshot.ts`), never this pointer.
 */
export const agentTokenSchema = z
  .object({
    secretRef: z.string().min(1).max(200),
  })
  .strict();

export type AgentToken = Readonly<z.infer<typeof agentTokenSchema>>;

/**
 * The per-provider half of the Agents settings surface, stored under the
 * provider's own id in the `agents` map below.
 *
 * `active` defaults to `false` when absent. A hand-written node that sets only
 * `proxy`/`model`/`reasoningEffort` is a natural thing to write, and the whole
 * document failing to load over one missing flag is a needlessly harsh failure
 * for a value whose only job is to answer "which provider?" - and that question
 * already has a well-defined fallback (`resolveConfiguredAgentId` treats
 * "none active" as the first discovered agent). The field is therefore required
 * in the parsed
 * output but optional on disk. `proxy`, `model` and `reasoningEffort` are all
 * optional so a node carrying only `active` is still a valid document, and
 * absent means "let the provider choose" (rendered as the `(Auto)` option) -
 * never a stored sentinel that could leak into a prompt.
 *
 * `proxy` deliberately holds a *proxies-library entry id*, matching every
 * other place a proxy is selected in this document (`ServerConfig.proxyId`).
 * The key is `proxy`, not `proxyId`, because that is the shape the settings
 * document is specified to use; the two names denote the same reference.
 *
 * `token` is the provider's optional personal-access-token reference (see
 * {@link agentTokenSchema}). It too is optional: a provider authenticated
 * interactively has no token, and the token's plaintext never appears here.
 */
export const agentSettingsSchema = z
  .object({
    active: z.boolean().default(false),
    proxy: proxyIdSchema.optional(),
    model: modelIdSchema.optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
    token: agentTokenSchema.optional(),
  })
  .strict();

export type AgentSettings = Readonly<z.infer<typeof agentSettingsSchema>>;

/**
 * Browser-pane settings (the Settings "Browser" tab).
 *
 * `disableNativeWebAuthn` defaults to `true` and asks Chromium to handle
 * WebAuthn itself instead of forwarding to the native Windows WebAuthn API -
 * the API that raises the "Windows Security / Insert your security key" dialog
 * on IdP login pages such as Adobe's IMS. See `mergeDisabledFeatures` and its
 * call site in `src/main/index.ts`. It is read *before* Electron is ready
 * (Chromium reads its feature switches once), so a change takes effect on the
 * next launch.
 *
 * `proxy` is the **default proxy** - the entry of the `proxies` library the
 * AEM pane uses for any origin that is not one of the configured hosts (for
 * example Adobe's IMS login origin during an SSO redirect). It is a library
 * entry id; absent means "no default proxy" (direct). A host can override it
 * per-origin with its own `proxyId` (see `serverConfig.ts`): a host with an
 * explicit entry or {@link HOST_PROXY_NONE} does not inherit this default.
 */
export const browserSettingsSchema = z
  .object({
    disableNativeWebAuthn: z.boolean().default(true),
    proxy: proxyIdSchema.optional(),
  })
  .strict();

export type BrowserSettings = Readonly<z.infer<typeof browserSettingsSchema>>;

export const appSettingsSchema = z
  .object({
    hosts: z.array(serverConfigSchema),
    proxies: z.array(proxyConfigSchema),
    agents: z.record(agentIdSchema, agentSettingsSchema),
    browser: browserSettingsSchema.default({ disableNativeWebAuthn: true }),
  })
  .strict()
  .superRefine((settings, ctx) => {
    const seenIds = new Set<string>();
    const seenOrigins = new Set<string>();
    settings.hosts.forEach((server, index) => {
      if (seenIds.has(server.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate server id: ${server.id}`,
          path: ['hosts', index, 'id'],
        });
      } else {
        seenIds.add(server.id);
      }
      if (seenOrigins.has(server.origin)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate server origin: ${server.origin}`,
          path: ['hosts', index, 'origin'],
        });
      } else {
        seenOrigins.add(server.origin);
      }
    });
    const seenProxyIds = new Set<string>();
    settings.proxies.forEach((proxy, index) => {
      if (seenProxyIds.has(proxy.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate proxy id: ${proxy.id}`,
          path: ['proxies', index, 'id'],
        });
      } else {
        seenProxyIds.add(proxy.id);
      }
    });
    // A host may only name a proxy that exists: a dangling reference would
    // silently stop proxying (or, worse, resolve to the wrong entry later).
    // Removing a proxy is expected to clear it from every host that named it
    // (see `removeProxy` in `settingsStore.ts`). `HOST_PROXY_NONE` is the
    // sentinel for "No proxy", not a reference, so it is always valid.
    settings.hosts.forEach((host, index) => {
      if (
        host.proxyId !== undefined &&
        host.proxyId !== HOST_PROXY_NONE &&
        !seenProxyIds.has(host.proxyId)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `proxyId "${host.proxyId}" does not refer to a configured proxy`,
          path: ['hosts', index, 'proxyId'],
        });
      }
    });
    // The browser default proxy must resolve for the same reason a host's
    // reference must: it is applied to every origin that is not a configured
    // host, so a dangling reference would silently stop proxying them.
    if (settings.browser.proxy !== undefined && !seenProxyIds.has(settings.browser.proxy)) {
      ctx.addIssue({
        code: 'custom',
        message: `proxy "${settings.browser.proxy}" does not refer to a configured proxy`,
        path: ['browser', 'proxy'],
      });
    }
    // Exactly one provider may be active: the Agents surface is a single-choice
    // control, and two active nodes would make "which provider does a prompt
    // go to?" an ordering accident rather than a stored fact.
    const activeAgentIds = Object.entries(settings.agents)
      .filter(([, node]) => node.active)
      .map(([id]) => id);
    if (activeAgentIds.length > 1) {
      ctx.addIssue({
        code: 'custom',
        message: `at most one agent may be active, but ${activeAgentIds.length} are (${activeAgentIds.join(', ')})`,
        path: ['agents'],
      });
    }
    // An agent's proxy reference has to resolve, for the same reason a host's
    // does: a dangling reference would silently stop proxying the runtime.
    for (const [agentId, node] of Object.entries(settings.agents)) {
      if (node.proxy !== undefined && !seenProxyIds.has(node.proxy)) {
        ctx.addIssue({
          code: 'custom',
          message: `proxy "${node.proxy}" does not refer to a configured proxy`,
          path: ['agents', agentId, 'proxy'],
        });
      }
      // A reasoning effort is only meaningful for a chosen model: storing one
      // without a model would leave a level that silently takes effect the
      // moment a model is later picked, which is not what the user configured.
      if (node.reasoningEffort !== undefined && node.model === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'reasoningEffort requires a model to be selected for the same agent',
          path: ['agents', agentId, 'reasoningEffort'],
        });
      }
    }
  });

export type AppSettings = Readonly<Omit<z.infer<typeof appSettingsSchema>, 'hosts' | 'proxies'>> & {
  readonly hosts: readonly ServerConfig[];
  readonly proxies: readonly ProxyConfig[];
};

/**
 * A valid, empty settings document: no hosts, no proxies, no agent nodes (the
 * agent catalogue is discovered, not seeded here), and the browser defaults (`browser.disableNativeWebAuthn: true`).
 */
export function defaultAppSettings(): AppSettings {
  return appSettingsSchema.parse({
    hosts: [],
    proxies: [],
    agents: {},
    browser: {},
  });
}

export interface AppSettingsParseIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Parses a persisted settings document. Returns a `Result` instead of throwing
 * so the caller sees *why* a document was rejected rather than catching an
 * exception.
 */
export function parseAppSettings(
  raw: unknown,
): Result<AppSettings, readonly AppSettingsParseIssue[]> {
  const parsed = appSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    return err(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return ok(parsed.data);
}
