import {
  type ContributedTool,
  type ModelToolModule,
  type ToolDescriptor,
  type ToolExecutor,
  type ToolHost,
  createToolError,
  err,
  newRequestId,
} from '../../shared';
import type { AddonLoadFailureKind, AddonLoader } from '../addons';

/**
 * The application's proxy for a tool an add-on contributes.
 *
 * The tool is **advertised before the add-on is loaded**: its name, descriptor,
 * allowlist entry and instructions are data in the add-on's built manifest, so
 * the model can see it (and the session instructions can describe it) from the
 * first launch. Nothing is imported until a call actually needs it, and every
 * tool that add-on contributes shares one load.
 *
 * The proxy is generic: it names no add-on and knows nothing about what the tool
 * does. It forwards the model's arguments **unchanged** - the add-on's own
 * schema validates them, exactly as the descriptor's schema says it will.
 */

export interface ContributedToolSource {
  readonly addonId: string;
  readonly tool: ContributedTool;
}

export interface ContributedToolModulesOptions {
  readonly tools: readonly ContributedToolSource[];
  readonly loader: AddonLoader;
}

/** How a failed load reads to the model: always retryable. */
function loadFailure(
  addonId: string,
  kind: AddonLoadFailureKind,
  message: string,
  requestId: ReturnType<typeof newRequestId>,
) {
  return err(
    createToolError(
      'STORAGE_ERROR',
      `${message} (add-on: ${addonId}, reason: ${kind})`.slice(0, 500),
      requestId,
      { retryable: true },
    ),
  );
}

function createProxyExecutor(
  source: ContributedToolSource,
  loader: AddonLoader,
  host: ToolHost,
): ToolExecutor {
  // Built once, on the first call that actually needs the add-on.
  let executor: ToolExecutor | undefined;
  const descriptor: ToolDescriptor = source.tool.descriptor;

  return async (args, context) => {
    if (executor === undefined) {
      host.reportToolProgress?.(context.toolCallId, 'Loading tools');
      const loaded = await loader.load(source.addonId, () =>
        host.reportToolProgress?.(context.toolCallId, 'Installing tools'),
      );
      if (!loaded.ok) {
        return loadFailure(
          source.addonId,
          loaded.error.kind,
          loaded.error.message,
          newRequestId(host.idGenerator),
        );
      }
      const factory = loaded.value.activation.tools[source.tool.name];
      if (factory === undefined) {
        return loadFailure(
          source.addonId,
          'unavailable',
          `The "${source.addonId}" add-on does not provide its "${source.tool.name}" tool`,
          newRequestId(host.idGenerator),
        );
      }
      try {
        executor = factory(host, descriptor);
      } catch (caught) {
        return loadFailure(
          source.addonId,
          'unavailable',
          caught instanceof Error
            ? caught.message.slice(0, 300)
            : `The "${source.addonId}" add-on could not start its tool`,
          newRequestId(host.idGenerator),
        );
      }
    }
    return executor(args, context);
  };
}

/** One `ModelToolModule` per contributed tool, ready for the tool registry. */
export function createContributedToolModules(
  options: ContributedToolModulesOptions,
): readonly ModelToolModule[] {
  return options.tools.map((source) => ({
    name: source.tool.name,
    descriptor: source.tool.descriptor,
    allowlistEntry: source.tool.allowlistEntry,
    instructions: source.tool.instructions,
    createExecutor: (host: ToolHost) => createProxyExecutor(source, options.loader, host),
  }));
}
