import { type ToolModule } from '../../shared';
import {
  AEM_ENVIRONMENT_FACTS_ALLOWLIST_ENTRY,
  AEM_ENVIRONMENT_FACTS_TOOL_DESCRIPTOR,
  AEM_ENVIRONMENT_FACTS_TOOL_NAME,
  createAemEnvironmentFactsExecutor,
  executeAemEnvironmentFacts,
} from './environmentFacts';

/** The plugin manifest the main-process registry discovers. Delete this folder to remove the tool. */
export const tool: ToolModule = {
  name: AEM_ENVIRONMENT_FACTS_TOOL_NAME,
  descriptor: AEM_ENVIRONMENT_FACTS_TOOL_DESCRIPTOR,
  allowlistEntry: AEM_ENVIRONMENT_FACTS_ALLOWLIST_ENTRY,
  instructions:
    "The 'aem_environment_facts' tool reports the current AEM host and the JCR roots under " +
    'which content and components live. Use it when you need to know where to scope a search ' +
    'on this instance; it takes no arguments and performs no AEM request.',
  createExecutor: (host) =>
    createAemEnvironmentFactsExecutor({
      execute: (envelope, deps) =>
        executeAemEnvironmentFacts(envelope, {
          origin: deps.origin,
          environmentFacts: deps.environmentFacts,
          now: deps.now,
        }),
      runtimeDeps: { environmentFacts: host.environmentFacts, now: host.clock },
      currentContext: host.currentContext,
      clock: host.clock,
      idGenerator: host.idGenerator,
    }),
};
