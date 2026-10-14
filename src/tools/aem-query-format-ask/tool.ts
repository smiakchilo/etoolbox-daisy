import { type ModelToolModule } from '../../shared';
import {
  AEM_QUERY_FORMAT_ASK_ALLOWLIST_ENTRY,
  AEM_QUERY_FORMAT_ASK_TOOL_DESCRIPTOR,
  AEM_QUERY_FORMAT_ASK_TOOL_NAME,
  AEM_QUERY_FORMAT_ASK_USES,
  createAemQueryFormatAskExecutor,
} from './aemQueryFormatAsk';

/** The plugin manifest the main-process registry discovers. Delete this folder to remove the tool. */
export const tool: ModelToolModule = {
  name: AEM_QUERY_FORMAT_ASK_TOOL_NAME,
  descriptor: AEM_QUERY_FORMAT_ASK_TOOL_DESCRIPTOR,
  allowlistEntry: AEM_QUERY_FORMAT_ASK_ALLOWLIST_ENTRY,
  uses: AEM_QUERY_FORMAT_ASK_USES,
  instructions:
    "The 'aem_query_format_ask' tool is the complete AEM search the user sees: one call " +
    "queries, shows the table, and offers 'Load more' until the user is done. Use it for every " +
    'search whose results the user should see - `terms` for a plain full-text search such as ' +
    '`/search <terms>`, `predicates` for a hand-built QueryBuilder search (a type, a property, ' +
    "a date range, an ordering). Never chain 'aem_query' and 'ask_user' yourself to show results. " +
    'The table this tool puts on screen is the whole answer, and the application hides your own ' +
    'text for the turn: write no summary, explanation or list of results around it.',
  createExecutor: (host) => createAemQueryFormatAskExecutor(host),
};
