/**
 * The tool kit: everything a tool folder under src/tools/ may share, and
 * nothing that names a tool. This barrel must never import or re-export a
 * concrete tool, the registry, or a closed union over tools - that coupling is
 * exactly what makes deleting a tool folder safe.
 *
 * Adding a tool means creating src/tools/<name>/ with a `tool.ts` that
 * exports a ToolModule (see ./core/toolModule); the main-process registry
 * (src/main/tools/registry.ts) discovers it by glob. Registration is not the
 * whole job: every tool must also have a deliberate transcript getDetails()
 * composition - src/tools/<name>/renderer/index.ts, dispatched by
 * src/renderer/src/chat/toolCallDetails.ts - and an agent adding a tool must
 * ask the user what to expose there (AGENTS.md section 5).
 */

export * from './core/envelope';
export * from './core/brokerOutcome';
export * from './core/resultCommon';
export * from './core/responseValidation';
export * from './core/authIncident';
export * from './core/environment';
export * from './core/navigation';
export * from './core/currentPage';
export * from './core/types';
export * from './core/jcrPath';
export * from './core/search';
export * from './core/queryBuilder';
export * from './core/toolModule';
export * from './core/toolRenderer';
export * from './core/scope';
export * from './core/searchFilters';
export * from './core/turnCompletion';
