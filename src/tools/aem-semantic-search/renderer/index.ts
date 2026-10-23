import {
  type JsonValue,
  type ToolCallDetails,
  type ToolRendererModule,
  asCount,
  asRecord,
  asStringArray,
  asText,
  describeFiltersValue,
  parameterRows,
} from '../../../shared';
import { describeSemanticTotal } from '../aemSemanticSearch';

/**
 * `aem_semantic_search` renders as an ordinary billet; the table and the
 * "Load more" button come from the nested `format_table` and `ask_user` calls.
 * There is exactly one model-facing call per search now - it starts the whole
 * run - so the collapsed summary is the terms themselves (with the page once
 * past the first), and the expanded rows are the search's own facts.
 *
 * The summary never repeats the tool's own name: the billet's header already
 * reads `aem_semantic_search`, so a "Semantic search:" prefix would print the
 * words twice on one line (as `aem_query` shows `fulltext=...`, never
 * "Query: ...").
 */

function describeCall(
  args: Readonly<Record<string, JsonValue>>,
  data?: JsonValue,
): ToolCallDetails {
  const result = asRecord(data);
  const known = result?.['operation'] === 'aem_semantic_search' ? result : undefined;
  const terms = asText(args['terms']) ?? '';
  const page = typeof known?.['page'] === 'number' ? known['page'] : undefined;
  const roots = asStringArray(known?.['roots']) ?? asStringArray(args['roots']);

  return {
    summary: `${terms}${page !== undefined && page > 1 ? ` (page ${String(page)})` : ''}`,
    parameters: parameterRows([
      ['Terms', terms],
      ['Context', asText(known?.['context']) ?? asText(args['context'])],
      ['Filters', describeFiltersValue(known?.['filters'] ?? args['filters'])],
      ['Roots', roots?.join(', ')],
      ['Page size', asCount(known?.['pageSize']) ?? asCount(args['limit'])],
      ['Page', asCount(known?.['page'])],
      ['Candidates read', asCount(known?.['candidatesRead'])],
      ['Matches shown', asCount(known?.['matchesShown'])],
      [
        'AEM hits',
        known === undefined ? undefined : describeSemanticTotal(known['total'], known['hasMore']),
      ],
    ]),
  };
}

export const renderer: ToolRendererModule = {
  toolName: 'aem_semantic_search',
  describeCall,
};
