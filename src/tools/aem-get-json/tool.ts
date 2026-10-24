import { type ModelToolModule } from '../../shared';
import {
  AEM_GET_JSON_ALLOWLIST_ENTRY,
  AEM_GET_JSON_TOOL_DESCRIPTOR,
  AEM_GET_JSON_TOOL_NAME,
  createAemGetJsonExecutor,
  executeAemGetJson,
  readHttpFetchOutcome,
} from './aemGetJson';

/**
 * The plugin manifest the main-process registry discovers. Delete this folder
 * to remove the tool. It is a composite over `http_fetch`: the read itself is
 * that tool's, and only the AEM path, classification and projection live here.
 */
export const tool: ModelToolModule = {
  name: AEM_GET_JSON_TOOL_NAME,
  descriptor: AEM_GET_JSON_TOOL_DESCRIPTOR,
  allowlistEntry: AEM_GET_JSON_ALLOWLIST_ENTRY,
  uses: ['http_fetch'],
  transparent: true,
  instructions:
    "The 'aem_get_json' tool reads JCR/Sling node data from the AEM instance the user currently " +
    "has open. Use 'aem_get_json' when you already know the path.",
  createExecutor: (host) =>
    createAemGetJsonExecutor({
      execute: (envelope, deps, context) =>
        executeAemGetJson(envelope, {
          origin: deps.origin,
          now: deps.now,
          fetchJson: async (url) =>
            readHttpFetchOutcome(
              await host.invokeTool('http_fetch', { url, accept: 'application/json' }, context),
              envelope.requestId,
            ),
          onClassified: (requestId, kind) => host.recordResponseClassification?.(requestId, kind),
        }),
      runtimeDeps: { now: host.clock },
      currentContext: host.currentContext,
      clock: host.clock,
      idGenerator: host.idGenerator,
    }),
};
