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
    'as the complete set of matches. This tool returns data only and draws no table: after each ' +
    "page, call 'format_table' with this result's JSON as `data` (mode 'new' on the first page, " +
    '\'append\' after) to present it. Prefer the indexed predicates: use "fulltext" for text and ' +
    'add a "type" when you know the node type. A "property" or "nodename" predicate is only ' +
    'served by an index; on a property the instance does not index, AEM traverses the whole ' +
    'subtree and stops without returning data - narrow the path/roots or add a "type" instead.',
  createExecutor: (host) =>
    createAemQueryExecutor({
      execute: (envelope, deps) =>
        executeAemQuery(envelope, {
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
