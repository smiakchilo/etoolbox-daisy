import { type ToolModule } from '../../shared';
import {
  AEM_QUERY_ALLOWLIST_ENTRY,
  AEM_QUERY_TOOL_DESCRIPTOR,
  AEM_QUERY_TOOL_NAME,
  createAemQueryExecutor,
  executeAemQuery,
} from './aemQuery';

/** The plugin manifest the main-process registry discovers. Delete this folder to remove the tool. */
export const tool: ToolModule = {
  name: AEM_QUERY_TOOL_NAME,
  descriptor: AEM_QUERY_TOOL_DESCRIPTOR,
  allowlistEntry: AEM_QUERY_ALLOWLIST_ENTRY,
  instructions:
    "The 'aem_query' tool runs a QueryBuilder search against that same instance. Use 'aem_query' " +
    'when you need to find nodes you cannot name. A query returns one page at a time: to see ' +
    "further results, call 'aem_query' again with a higher 'offset', and never present one page " +
    'as the complete set of matches.',
  createExecutor: (host) =>
    createAemQueryExecutor({
      execute: (envelope, deps) =>
        executeAemQuery(envelope, {
          origin: deps.origin,
          now: deps.now,
          fetchThroughBridge: (url) => host.bridge.request(envelope, url),
        }),
      runtimeDeps: { now: host.clock },
      currentContext: host.currentContext,
      clock: host.clock,
      idGenerator: host.idGenerator,
    }),
};
