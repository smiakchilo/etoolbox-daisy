import {
  type JsonValue,
  type ToolCallDetails,
  type ToolRendererModule,
  asCount,
  asRecord,
  asStringArray,
  describePublication,
  parameterRows,
} from '../../../shared';
import { describePredicates, describeSearchTotal } from '../aemQueryFormatAsk';

/**
 * `aem_query_format_ask` renders as an ordinary billet; the table and the
 * "Load more" button come from the nested `format_table` and `ask_user` calls,
 * which the transcript shows on their own. Composed with the user (AGENTS.md
 * section 5): the collapsed summary is `Search: <terms>` (or the predicates as
 * `key=value; ...` for a hand-built search); the rows are Terms or Predicates,
 * Publication (only when filtered), Roots, Page size, then - once the search finished - Pages, Rows and Total.
 */
function describeCall(
  args: Readonly<Record<string, JsonValue>>,
  data?: JsonValue,
): ToolCallDetails {
  const terms = typeof args['terms'] === 'string' ? args['terms'] : undefined;
  const predicateMap = asRecord(args['predicates']);
  const predicates = predicateMap === undefined ? undefined : describePredicates(predicateMap);
  const result = asRecord(data);
  const finished = result?.['operation'] === 'aem_query_format_ask' ? result : undefined;

  const roots = asStringArray(finished?.['roots']) ?? asStringArray(args['roots']);
  const pageSize = asCount(finished?.['pageSize']) ?? asCount(args['limit']);

  return {
    summary: `Search: ${terms ?? predicates ?? ''}`,
    parameters: parameterRows([
      ['Terms', terms],
      ['Predicates', predicates],
      ['Publication', describePublication(args['publication'])],
      ['Roots', roots?.join(', ')],
      ['Page size', pageSize],
      ['Pages', asCount(finished?.['pages'])],
      ['Rows', asCount(finished?.['rows'])],
      [
        'Total',
        finished === undefined
          ? undefined
          : describeSearchTotal(finished['total'], finished['hasMore']),
      ],
    ]),
  };
}

export const renderer: ToolRendererModule = {
  toolName: 'aem_query_format_ask',
  describeCall,
};
