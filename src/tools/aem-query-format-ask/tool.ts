import { type ToolModule } from '../../shared';
import {
  AEM_QUERY_FORMAT_ASK_ALLOWLIST_ENTRY,
  AEM_QUERY_FORMAT_ASK_TOOL_DESCRIPTOR,
  AEM_QUERY_FORMAT_ASK_TOOL_NAME,
  AEM_QUERY_FORMAT_ASK_USES,
  createAemQueryFormatAskExecutor,
} from './aemQueryFormatAsk';

/** The plugin manifest the main-process registry discovers. Delete this folder to remove the tool. */
export const tool: ToolModule = {
  name: AEM_QUERY_FORMAT_ASK_TOOL_NAME,
  descriptor: AEM_QUERY_FORMAT_ASK_TOOL_DESCRIPTOR,
  allowlistEntry: AEM_QUERY_FORMAT_ASK_ALLOWLIST_ENTRY,
  uses: AEM_QUERY_FORMAT_ASK_USES,
  instructions:
    "The 'aem_query_format_ask' tool is the complete full-text search: one call queries, shows " +
    "the table, and offers 'Load more' until the user is done. Use it for a plain full-text " +
    "search such as `/search <terms>`, instead of chaining 'aem_query', 'format_table' and " +
    "'ask_user' yourself. Chain those yourself only when the search needs predicates beyond " +
    'full text (a type, a property, a date range, an ordering).',
  createExecutor: (host) => createAemQueryFormatAskExecutor(host),
};
