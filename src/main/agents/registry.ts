/// <reference types="vite/client" />
import { agentFolderOf, type AgentDefinition, type AgentModule } from '../../shared';

/**
 * The one place that knows how agent runtimes are discovered. Every folder
 * `src/agents/<name>/` whose `agent.ts` exports an `AgentModule` named `agent`
 * is a candidate; nothing else in the application names one.
 *
 * Loading is lazy and per-agent on purpose: an agent whose module throws while
 * loading (a missing SDK, say), whose manifest is malformed, or whose id has
 * no matching `meta.ts` is reported through `onFailure` and left without a
 * runtime. The application starts without it. A `disabled` agent's `agent.ts`
 * is never loaded at all. (A *type* error is different: it fails `tsc`/the
 * build for everyone, `disabled` or not; only deleting the folder avoids it.)
 */

export type AgentModuleLoaders = Readonly<Record<string, () => Promise<unknown>>>;

export interface AgentLoadFailure {
  /** The `agent.ts` path (or a synthetic one in tests) that failed. */
  readonly source: string;
  readonly reason: string;
}

export interface AgentRegistry {
  /** Loaded, validated modules for the enabled agents. */
  readonly modules: readonly AgentModule[];
  readonly failures: readonly AgentLoadFailure[];
}

export function discoverAgentLoaders(): AgentModuleLoaders {
  return import.meta.glob('../../agents/*/agent.ts');
}

function isAgentModule(value: unknown): value is AgentModule {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' && v['id'].length > 0 && typeof v['createRuntime'] === 'function'
  );
}

function describe(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export async function buildAgentRegistry(params: {
  readonly loaders: AgentModuleLoaders;
  /** The enabled agents, from the meta catalogue; a module must match one by id. */
  readonly definitions: readonly AgentDefinition[];
  /** `meta.ts` paths of disabled agents; the `agent.ts` beside each is skipped. */
  readonly disabledSources: readonly string[];
  readonly onFailure?: (failure: AgentLoadFailure) => void;
}): Promise<AgentRegistry> {
  const failures: AgentLoadFailure[] = [];
  const fail = (source: string, reason: string): void => {
    const failure = { source, reason };
    failures.push(failure);
    params.onFailure?.(failure);
  };

  const disabledFolders = new Set(params.disabledSources.map(agentFolderOf));
  const knownIds = new Set(params.definitions.map((definition) => definition.id as string));
  const modules: AgentModule[] = [];

  // Sorted so the result is deterministic.
  for (const source of Object.keys(params.loaders).sort()) {
    const loader = params.loaders[source];
    if (loader === undefined) continue;
    if (disabledFolders.has(agentFolderOf(source))) continue;
    let mod: unknown;
    try {
      mod = await loader();
    } catch (caught) {
      fail(source, `Failed to load: ${describe(caught)}`);
      continue;
    }
    const agent = (mod as { agent?: unknown } | null)?.agent;
    if (!isAgentModule(agent)) {
      fail(source, 'Does not export a valid `agent` (AgentModule).');
      continue;
    }
    if (!knownIds.has(agent.id)) {
      fail(source, `No enabled meta.ts declares agent id '${agent.id}'.`);
      continue;
    }
    if (modules.some((existing) => existing.id === agent.id)) {
      fail(source, `Duplicate agent id '${agent.id}'.`);
      continue;
    }
    modules.push(agent);
  }

  return { modules, failures };
}
