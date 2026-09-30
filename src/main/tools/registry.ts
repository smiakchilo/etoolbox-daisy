/// <reference types="vite/client" />
import type { AemToolExecutor, ToolDescriptor, ToolHost, ToolModule } from '../../shared';
import { composeAssistantInstructions } from '../../shared';

/**
 * The one place that knows how tools are discovered. Every folder
 * `src/tools/<name>/` that contains a `tool.ts` exporting a `ToolModule`
 * named `tool` is a tool; nothing else in the application names one.
 *
 * Loading is lazy and per-tool on purpose: a tool whose module throws while
 * loading, whose manifest is malformed, or whose `createExecutor` throws is
 * reported through `onFailure` and left out. The application starts without
 * it. (A *type* error is different: it fails `tsc`/the build for everyone,
 * `disabled` or not; only deleting the folder avoids that.)
 */

export type ToolModuleLoaders = Readonly<Record<string, () => Promise<unknown>>>;

export interface ToolLoadFailure {
  /** The manifest path (or a synthetic one in tests) that failed. */
  readonly source: string;
  readonly reason: string;
}

export interface ToolRegistry {
  /** Enabled tools' executors, keyed by tool name. */
  readonly toolHandlers: Readonly<Record<string, AemToolExecutor>>;
  readonly descriptors: readonly ToolDescriptor[];
  readonly allowlistEntries: readonly string[];
  /** The composed session instructions for exactly the enabled tools. */
  readonly instructions: string;
  readonly enabledNames: readonly string[];
  readonly disabledNames: readonly string[];
  readonly failures: readonly ToolLoadFailure[];
}

export function discoverToolLoaders(): ToolModuleLoaders {
  return import.meta.glob('../../tools/*/tool.ts');
}

function isToolModule(value: unknown): value is ToolModule {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const descriptor = v['descriptor'] as { name?: unknown } | undefined;
  const name = v['name'];
  return (
    typeof name === 'string' &&
    typeof v['allowlistEntry'] === 'string' &&
    typeof v['instructions'] === 'string' &&
    typeof v['createExecutor'] === 'function' &&
    typeof descriptor === 'object' &&
    descriptor !== null &&
    descriptor.name === name &&
    v['allowlistEntry'] === `custom:${name}`
  );
}

function describe(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export async function buildToolRegistry(params: {
  readonly loaders: ToolModuleLoaders;
  readonly host: ToolHost;
  readonly onFailure?: (failure: ToolLoadFailure) => void;
}): Promise<ToolRegistry> {
  const failures: ToolLoadFailure[] = [];
  const fail = (source: string, reason: string): void => {
    const failure = { source, reason };
    failures.push(failure);
    params.onFailure?.(failure);
  };

  const handlers: Record<string, AemToolExecutor> = {};
  const descriptors: ToolDescriptor[] = [];
  const allowlistEntries: string[] = [];
  const instructions: string[] = [];
  const disabledNames: string[] = [];

  // Sorted so the instruction text and allowlist are deterministic.
  for (const source of Object.keys(params.loaders).sort()) {
    const loader = params.loaders[source];
    if (loader === undefined) continue;
    let mod: unknown;
    try {
      mod = await loader();
    } catch (caught) {
      fail(source, `Failed to load: ${describe(caught)}`);
      continue;
    }
    const tool = (mod as { tool?: unknown } | null)?.tool;
    if (!isToolModule(tool)) {
      fail(source, 'Does not export a valid `tool` (ToolModule).');
      continue;
    }
    if (tool.disabled === true) {
      disabledNames.push(tool.name);
      continue;
    }
    if (handlers[tool.name] !== undefined) {
      fail(source, `Duplicate tool name '${tool.name}'.`);
      continue;
    }
    try {
      handlers[tool.name] = tool.createExecutor(params.host);
    } catch (caught) {
      fail(source, `createExecutor threw: ${describe(caught)}`);
      continue;
    }
    descriptors.push(tool.descriptor);
    allowlistEntries.push(tool.allowlistEntry);
    instructions.push(tool.instructions);
  }

  return {
    toolHandlers: handlers,
    descriptors,
    allowlistEntries,
    instructions: composeAssistantInstructions(instructions),
    enabledNames: Object.keys(handlers),
    disabledNames,
    failures,
  };
}
