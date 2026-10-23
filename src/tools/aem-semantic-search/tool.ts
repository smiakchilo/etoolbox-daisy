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
    '`/semantic-search <text>`: you supply only `{ terms, context }` (and `roots` by subject). ' +
    'The application queries the hits, reads every hit, asks the active model whether each hit ' +
    "matches the meaning, shows the table and offers 'Load more' itself. You never see the " +
    'candidates or decide which match, and you never call it back with verdicts. A single call ' +
    'runs the whole search; when it returns, the search is finished, so end your turn without ' +
    'writing text. ' +
    "Choose `roots` by what is searched: the host's content roots for pages and components, its " +
    'DAM roots for files and assets, both when both are asked for. ' +
    "Never call 'aem_query', 'aem_get_json' or 'ask_user' yourself for such a search. " +
    'The table this tool puts on screen is the whole answer, and the application hides your own ' +
    'text for the turn: write no summary, explanation or list of results around it.',
  createExecutor: (host) => createAemSemanticSearchExecutor(host),
};
