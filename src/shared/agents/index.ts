/**
 * The agent kit: everything an agent folder under src/agents/ may share, and
 * nothing that names an agent. This barrel must never import or re-export a
 * concrete agent or the registry - that is what makes deleting an agent folder
 * safe. See docs/agent-plugin-architecture.md.
 */

export * from './agentService';
export * from './agentModule';
export * from './agentCatalog';
export * from './modelObserver';
