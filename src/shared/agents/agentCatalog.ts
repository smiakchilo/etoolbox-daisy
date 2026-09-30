import type { AgentMeta } from './agentModule';

/**
 * Builds the agent definition list from the `meta` exports of every
 * `src/agents/<name>/meta.ts`. Both processes call this with their own eager
 * glob, so the renderer and the main process derive the identical list from
 * the identical source. A malformed, duplicate or `disabled` meta is skipped;
 * nothing here names an agent.
 */
export interface AgentCatalogResult {
  /** Enabled agents' metas in a deterministic (path-sorted) order. */
  readonly definitions: readonly AgentMeta[];
  readonly disabledIds: readonly string[];
  /** The `meta.ts` paths of the disabled agents, so the registry can skip their `agent.ts`. */
  readonly disabledSources: readonly string[];
  /** One message per meta that could not be used. */
  readonly failures: readonly { readonly source: string; readonly reason: string }[];
}

export function isAgentMeta(value: unknown): value is AgentMeta {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    v['id'].length > 0 &&
    typeof v['label'] === 'string' &&
    typeof v['requiresAuth'] === 'boolean' &&
    (v['disabled'] === undefined || typeof v['disabled'] === 'boolean')
  );
}

export function buildAgentCatalog(modules: Readonly<Record<string, unknown>>): AgentCatalogResult {
  const definitions: AgentMeta[] = [];
  const disabledIds: string[] = [];
  const disabledSources: string[] = [];
  const failures: { source: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const source of Object.keys(modules).sort()) {
    const meta = (modules[source] as { meta?: unknown } | null | undefined)?.meta;
    if (!isAgentMeta(meta)) {
      failures.push({ source, reason: 'Does not export a valid `meta` (AgentMeta).' });
      continue;
    }
    if (seen.has(meta.id)) {
      failures.push({ source, reason: `Duplicate agent id '${meta.id}'.` });
      continue;
    }
    seen.add(meta.id);
    if (meta.disabled === true) {
      disabledIds.push(meta.id);
      disabledSources.push(source);
      continue;
    }
    definitions.push(meta);
  }
  return { definitions, disabledIds, disabledSources, failures };
}
/** The `<name>` of a `.../agents/<name>/<file>.ts` path, used to pair a folder's two entry points. */
export function agentFolderOf(source: string): string {
  const segments = source.split('/');
  return segments[segments.length - 2] ?? source;
}
