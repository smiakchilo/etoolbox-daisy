import { type ModelToolModule } from '../../shared';
import {
  AEM_GET_JSON_ALLOWLIST_ENTRY,
  AEM_GET_JSON_TOOL_DESCRIPTOR,
  AEM_GET_JSON_TOOL_NAME,
  createAemGetJsonExecutor,
  executeAemGetJson,
} from './aemGetJson';

/** The plugin manifest the main-process registry discovers. Delete this folder to remove the tool. */
export const tool: ModelToolModule = {
  name: AEM_GET_JSON_TOOL_NAME,
  descriptor: AEM_GET_JSON_TOOL_DESCRIPTOR,
  allowlistEntry: AEM_GET_JSON_ALLOWLIST_ENTRY,
  instructions:
    "The 'aem_get_json' tool reads JCR/Sling node data from the AEM instance the user currently " +
    "has open. Use 'aem_get_json' when you already know the path.",
  createExecutor: (host) =>
    createAemGetJsonExecutor({
      execute: (envelope, deps) =>
        executeAemGetJson(envelope, {
          origin: deps.origin,
          now: deps.now,
          fetchThroughBridge: (url) => host.bridge.request(envelope, url),
          onClassified: (requestId, kind) => host.recordResponseClassification?.(requestId, kind),
        }),
      runtimeDeps: { now: host.clock },
      currentContext: host.currentContext,
      clock: host.clock,
      idGenerator: host.idGenerator,
    }),
};
