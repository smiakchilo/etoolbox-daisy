import {
  type JsonValue,
  type ToolCallDetails,
  type ToolRendererModule,
  asStringArray,
  parameterRows,
} from '../../../shared';
import { describeSearchTotal } from '../aemQueryFormatAsk';

/**
 * `aem_query_format_ask` renders as an ordinary billet; the table and the
 * "Load more" button come from the nested `format_table` and `ask_user` calls,
 * which the transcript shows on their own. Composed with the user (AGENTS.md
 * section 5): the collapsed summary is `Search: <terms>`; the rows are Terms,
 * Roots, Page size, then - once the search finished - Pages, Rows and Total.
 */
function asRecord(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, JsonValue>>;
}

function asCount(value: JsonValue | undefined): string | undefined {
  return typeof value === 'number' ? String(value) : undefined;
}

function describeCall(
  args: Readonly<Record<string, JsonValue>>,
  data?: JsonValue,
): ToolCallDetails {
  const terms = typeof args['terms'] === 'string' ? args['terms'] : '';
  const result = asRecord(data);
  const finished = result?.['operation'] === 'aem_query_format_ask' ? result : undefined;

  const roots = asStringArray(finished?.['roots']) ?? asStringArray(args['roots']);
  const pageSize = asCount(finished?.['pageSize']) ?? asCount(args['limit']);

  return {
    summary: `Search: ${terms}`,
    parameters: parameterRows([
      ['Terms', terms],
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
