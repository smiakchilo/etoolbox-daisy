import { z } from 'zod';
import { proxyIdSchema, serverIdSchema } from './ids';
import { originSchema } from './origin';
import {
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
 * This is read back from disk on every launch, written by possibly older
 * versions of the application, and never trusted blindly: every schema in
 * this module is `.strict()` so an unrecognised key - typically a sign of a
 * newer schema version, or of a file that was hand-edited or tampered with -
 * is rejected rather than silently ignored.
 */

/**
 * Bumped whenever the persisted shape changes in a way that is not purely
 * additive-and-optional. `parseAppSettings` rejects any other value outright;
 * migrating between versions is a step-04 concern (explicit migrations), not
 * something this module attempts implicitly.
 */
export const APP_SETTINGS_SCHEMA_VERSION = 2 as const;

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
 * One configured proxy entry in the proxies library. Distinct from a
 * per-server `AemProxyConfig` (requirements-decisions.md section 4 is explicit
 * that the two must not be merged or implicitly inherited from one another)
 * even though both accept the same credential-reference shape. It has no
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

export const appSettingsSchema = z
  .object({
    schemaVersion: z.literal(APP_SETTINGS_SCHEMA_VERSION),
    hosts: z.array(serverConfigSchema),
    activeHostId: serverIdSchema.nullable(),
    proxies: z.array(proxyConfigSchema),
    defaultModel: modelIdSchema.nullable(),
    defaultReasoningEffort: reasoningEffortSchema.nullable(),
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
    if (settings.activeHostId !== null && !seenIds.has(settings.activeHostId)) {
      ctx.addIssue({
        code: 'custom',
        message: 'activeHostId does not refer to a configured host',
        path: ['activeHostId'],
      });
    }
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
    // (see `removeProxy` in `settingsStore.ts`).
    settings.hosts.forEach((host, index) => {
      if (host.proxyId !== undefined && !seenProxyIds.has(host.proxyId)) {
        ctx.addIssue({
          code: 'custom',
          message: `proxyId "${host.proxyId}" does not refer to a configured proxy`,
          path: ['hosts', index, 'proxyId'],
        });
      }
    });
  });

export type AppSettings = Readonly<Omit<z.infer<typeof appSettingsSchema>, 'hosts' | 'proxies'>> & {
  readonly hosts: readonly ServerConfig[];
  readonly proxies: readonly ProxyConfig[];
};

/** A valid, empty settings document: no hosts, no active host, no proxies, direct mode. */
export function defaultAppSettings(): AppSettings {
  return appSettingsSchema.parse({
    schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
    hosts: [],
    activeHostId: null,
    proxies: [],
    defaultModel: null,
    defaultReasoningEffort: null,
  });
}

export interface AppSettingsParseIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Parses a settings file written by a (possibly older, possibly damaged)
 * version of this application. Returns a `Result` instead of throwing:
 * requirements-decisions.md section 4 requires an explicit migration path and
 * forbids silently replacing a damaged file with empty settings, both of
 * which need the caller to see *why* parsing failed rather than catching an
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
