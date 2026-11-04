import { z } from 'zod';
import {
  type AppSettings,
  modelIdSchema,
  reasoningEffortSchema,
  updateSourceSchema,
} from './appSettings';
import { agentIdSchema, projectIdSchema, proxyIdSchema, serverIdSchema } from './ids';
import { originSchema } from './origin';
import { environmentRootTextSchema, pathTransformTextSchema } from './projectConfig';
import {
  hostProxyIdSchema,
  hostTypeSchema,
  serverColorSchema,
  serverLabelSchema,
  tlsExceptionSchema,
} from './serverConfig';
import { err, ok, type Result } from '../result';

/**
 * The portable settings document (the Settings import/export file).
 *
 * It is the persisted settings document (`appSettingsSchema`) with exactly the
 * machine-local identity and secret material removed, so it can be handed to
 * another machine or hand-edited:
 *
 *  - each host's `revision` is dropped (an imported host starts at revision 0;
 *    an existing host merged by origin keeps its own revision);
 *  - each proxy's `credentials` object is dropped entirely (the password lives
 *    in the OS secret store, never in `settings.json`, and the `secretRef`
 *    pointer is meaningless off-machine);
 *  - each agent's `token` pointer is dropped for the same reason.
 *
 * The generated `id` fields are **kept** (owner decision): they are what keep a
 * host's `proxyId`/`projectId` reference resolvable *within* the same file. On
 * import those ids are remapped — an imported entry merged onto an existing one
 * takes the existing id, a genuinely new entry is minted a fresh id, and every
 * reference is rewired through that remap. A reference to an id the file does
 * not contain is dropped (the target reverts to its default).
 *
 * Every section is optional so the file can be partial: a hand-editor may
 * delete a whole section, or whole entries, and the import only touches what
 * remains. Like the other contracts this schema is `.strict()`, so an
 * unrecognised key is rejected rather than silently ignored.
 */

/**
 * The merge key per entry kind — the one "required" field that identifies an
 * entry, so an imported entry merges into the existing entry that shares it.
 * This is the single source of truth for those keys; both the export
 * serializer and the import merger read it, so the two can never disagree on
 * which field identifies an entry.
 */
export const IMPORT_MERGE_KEYS = {
  host: 'origin',
  proxy: 'url',
  project: 'label',
} as const;

export type ImportMergeKeyKind = keyof typeof IMPORT_MERGE_KEYS;

/**
 * One host entry in a portable document. `id`/`origin` are the identity (the
 * reference handle and the merge key); `label`/`color` are optional so a
 * hand-edited entry still imports (they default from the origin / to blue),
 * mirroring `normalizeSettingsDocument`'s forgiving reader. There is no
 * `revision`.
 */
export const portableServerSchema = z
  .object({
    id: serverIdSchema,
    origin: originSchema,
    label: serverLabelSchema.optional(),
    color: serverColorSchema.optional(),
    type: hostTypeSchema.optional(),
    proxyId: hostProxyIdSchema.optional(),
    tlsException: tlsExceptionSchema.optional(),
    projectId: projectIdSchema.optional(),
  })
  .strict();

export type PortableServer = Readonly<z.infer<typeof portableServerSchema>>;

/** One proxy entry. No `credentials` object (the password and its pointer never round-trip). */
export const portableProxySchema = z
  .object({
    id: proxyIdSchema,
    url: originSchema,
    label: serverLabelSchema.optional(),
  })
  .strict();

export type PortableProxy = Readonly<z.infer<typeof portableProxySchema>>;

/** One project entry. `label` is the merge key and stays required (no address to derive one from). */
export const portableProjectSchema = z
  .object({
    id: projectIdSchema,
    label: serverLabelSchema,
    contentRoots: environmentRootTextSchema.optional(),
    componentRoots: environmentRootTextSchema.optional(),
    contentPriorityPaths: environmentRootTextSchema.optional(),
    damRoots: environmentRootTextSchema.optional(),
    authorTransform: pathTransformTextSchema.optional(),
    publishTransform: pathTransformTextSchema.optional(),
  })
  .strict();

export type PortableProject = Readonly<z.infer<typeof portableProjectSchema>>;

/** One provider's node. No `token` pointer (see the module doc). */
export const portableAgentSettingsSchema = z
  .object({
    active: z.boolean().optional(),
    proxy: proxyIdSchema.optional(),
    model: modelIdSchema.optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
  })
  .strict();

export type PortableAgentSettings = Readonly<z.infer<typeof portableAgentSettingsSchema>>;

export const portableBrowserSettingsSchema = z
  .object({
    disableNativeWebAuthn: z.boolean().optional(),
    proxy: proxyIdSchema.optional(),
  })
  .strict();

export const portableMemoSettingsSchema = z.object({ enabled: z.boolean().optional() }).strict();

export const portableUpdateSettingsSchema = z
  .object({
    source: updateSourceSchema.optional(),
    checkOnStartup: z.boolean().optional(),
  })
  .strict();

/** The whole portable document. Every section is optional (the file may be partial). */
export const portableSettingsDocumentSchema = z
  .object({
    hosts: z.array(portableServerSchema).optional(),
    projects: z.array(portableProjectSchema).optional(),
    proxies: z.array(portableProxySchema).optional(),
    agents: z.record(agentIdSchema, portableAgentSettingsSchema).optional(),
    browser: portableBrowserSettingsSchema.optional(),
    memos: portableMemoSettingsSchema.optional(),
    updates: portableUpdateSettingsSchema.optional(),
  })
  .strict();

export type PortableSettingsDocument = z.infer<typeof portableSettingsDocumentSchema>;

export interface PortableSettingsIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Parses a portable settings document, returning a `Result` so the caller can
 * report *why* a file was rejected rather than catching an exception. Unlike
 * {@link import("../../main/settingsStore").normalizeSettingsDocument} this is
 * deliberately strict: an import is an explicit user action against a file they
 * picked, so a document that does not prove valid is refused whole rather than
 * silently repaired.
 */
export function parsePortableSettingsDocument(
  raw: unknown,
): Result<PortableSettingsDocument, readonly PortableSettingsIssue[]> {
  const parsed = portableSettingsDocumentSchema.safeParse(raw);
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

/**
 * Projects a persisted {@link AppSettings} into its portable form: the same
 * document minus `revision`, `credentials` and `token`, with every `id` kept so
 * references stay resolvable within the file. Pure (no I/O); the result is
 * what `settings:export` serializes.
 */
export function toSettingsExportDocument(settings: AppSettings): PortableSettingsDocument {
  const hosts: Record<string, unknown>[] = settings.hosts.map((server) => ({
    id: server.id,
    label: server.label,
    origin: server.origin,
    color: server.color,
    ...(server.type !== undefined ? { type: server.type } : {}),
    ...(server.proxyId !== undefined ? { proxyId: server.proxyId } : {}),
    ...(server.tlsException !== undefined ? { tlsException: server.tlsException } : {}),
    ...(server.projectId !== undefined ? { projectId: server.projectId } : {}),
  }));

  const projects: Record<string, unknown>[] = settings.projects.map((project) => ({
    id: project.id,
    label: project.label,
    ...(project.contentRoots !== undefined ? { contentRoots: project.contentRoots } : {}),
    ...(project.componentRoots !== undefined ? { componentRoots: project.componentRoots } : {}),
    ...(project.contentPriorityPaths !== undefined
      ? { contentPriorityPaths: project.contentPriorityPaths }
      : {}),
    ...(project.damRoots !== undefined ? { damRoots: project.damRoots } : {}),
    ...(project.authorTransform !== undefined ? { authorTransform: project.authorTransform } : {}),
    ...(project.publishTransform !== undefined
      ? { publishTransform: project.publishTransform }
      : {}),
  }));

  const proxies: Record<string, unknown>[] = settings.proxies.map((proxy) => ({
    id: proxy.id,
    label: proxy.label,
    url: proxy.url,
  }));

  const agents: Record<string, unknown> = {};
  for (const [agentId, node] of Object.entries(settings.agents)) {
    agents[agentId] = {
      active: node.active,
      ...(node.proxy !== undefined ? { proxy: node.proxy } : {}),
      ...(node.model !== undefined ? { model: node.model } : {}),
      ...(node.reasoningEffort !== undefined ? { reasoningEffort: node.reasoningEffort } : {}),
    };
  }

  // The input is a validated `AppSettings`, so this parse can only fail on a
  // programming error in this function (it throws rather than returning a
  // `Result`, exactly as `toAppSettingsSnapshot` does for the same reason).
  return portableSettingsDocumentSchema.parse({
    hosts,
    projects,
    proxies,
    agents,
    browser: settings.browser,
    memos: settings.memos,
    updates: settings.updates,
  });
}
