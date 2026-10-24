import { type ModelToolModule } from '../../shared';
import {
  AEM_QUERY_ALLOWLIST_ENTRY,
  AEM_QUERY_TOOL_DESCRIPTOR,
  AEM_QUERY_TOOL_NAME,
  createAemQueryExecutor,
  executeAemQuery,
} from './aemQuery';

/** The plugin manifest the main-process registry discovers. Delete this folder to remove the tool. */
export const tool: ModelToolModule = {
  name: AEM_QUERY_TOOL_NAME,
  descriptor: AEM_QUERY_TOOL_DESCRIPTOR,
  allowlistEntry: AEM_QUERY_ALLOWLIST_ENTRY,
  instructions:
    "The 'aem_query' tool runs a QueryBuilder search against that same instance. Use 'aem_query' " +
    'when you need to find nodes you cannot name. A query returns one page at a time: to see ' +
    "further results, call 'aem_query' again with a higher 'offset', and never present one page " +
    'as the complete set of matches. This tool returns data only and draws no table: to show ' +
    "search results to the user, call 'aem_query_format_ask' with the same `predicates` " +
    'instead. Prefer the indexed predicates: use "fulltext" for text and ' +
    'add a "type" when you know the node type. A "property" or "nodename" predicate is only ' +
    'served by an index; on a property the instance does not index, AEM traverses the whole ' +
    'subtree and stops without returning data - narrow the path/roots or add a "type" instead. ' +
    'To open a page the user names, resolve it here first: browser_navigate accepts only a path ' +
    'this search returned, or a path the user typed - never one built from a name. When the ' +
    'host configures priority paths, the application orders the rows by them (the priority paths ' +
    "first, in order, then the rest of the scope) and 'offset' keeps addressing the one ordered " +
    'list, so keep paging with a higher offset.',
  createExecutor: (host) =>
    createAemQueryExecutor({
      execute: (envelope, deps) =>
        executeAemQuery(envelope, {
          origin: deps.origin,
          now: deps.now,
          fetchThroughBridge: (url) =>
            // The application's own AEM JSON read, so its outcome is evidence
            // about the sign-in state (never a model-chosen `Accept`).
            host.bridge.request(envelope, url, { authEvidence: true }),
          onClassified: (requestId, kind) => host.recordResponseClassification?.(requestId, kind),
          priorityPaths: host.environmentFacts()?.contentPriorityPaths,
        }),
      runtimeDeps: { now: host.clock },
      currentContext: host.currentContext,
      clock: host.clock,
      idGenerator: host.idGenerator,
    }),
};
