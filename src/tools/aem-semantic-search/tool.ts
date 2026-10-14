import { type ModelToolModule } from '../../shared';
import {
  AEM_SEMANTIC_SEARCH_ALLOWLIST_ENTRY,
  AEM_SEMANTIC_SEARCH_TOOL_DESCRIPTOR,
  AEM_SEMANTIC_SEARCH_TOOL_NAME,
  AEM_SEMANTIC_SEARCH_USES,
  createAemSemanticSearchExecutor,
} from './aemSemanticSearch';

/** The plugin manifest the main-process registry discovers. Delete this folder to remove the tool. */
export const tool: ModelToolModule = {
  name: AEM_SEMANTIC_SEARCH_TOOL_NAME,
  descriptor: AEM_SEMANTIC_SEARCH_TOOL_DESCRIPTOR,
  allowlistEntry: AEM_SEMANTIC_SEARCH_ALLOWLIST_ENTRY,
  uses: AEM_SEMANTIC_SEARCH_USES,
  instructions:
    "The 'aem_semantic_search' tool is the complete semantic search, such as " +
    '`/semantic-search <text>`: the application queries, reads the content of every hit, shows ' +
    "the table and offers 'Load more'; your only job is to judge relevance. Start it with " +
    '`{ terms, context }`. Every time it returns candidates, judge EVERY one of them against the ' +
    'context and call it again with `{ searchId, matches }` - nothing else in between. Keep doing ' +
    'that until the result says the search is finished, then end your turn without writing text. ' +
    "Never call 'aem_query', 'aem_get_json' or 'ask_user' yourself for such a search. " +
    'The table this tool puts on screen is the whole answer, and the application hides your own ' +
    'text for the turn: write no summary, explanation or list of results around it.',
  createExecutor: (host) => createAemSemanticSearchExecutor(host),
};
