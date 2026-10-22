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
 *
 * The billet spans several model calls, and they are composed differently
 * (AGENTS.md section 5, agreed with the user):
 *
 *  - a **start** call (`{ terms, context }`) - the collapsed summary is the
 *    terms themselves (with the page once past the first); rows Terms, Context,
 *    Filters (only when filtered), Roots, Page size, then Page, Candidates read, Matches shown and AEM hits
 *    (AEM's own total, not the relevant count) as the result reports them;
 *  - a **continue** call (`{ searchId, matches }`) - the model reporting its
 *    verdict on the candidates the start call returned. It carries no terms of
 *    its own (the search it continues was started by an earlier call), and while
 *    it runs - which includes the read after "Load more" - or when it was
 *    abandoned there is no result to borrow them from, so it is summarised by
 *    what it is doing: `judging N match(es)`, with rows Search ID and Matched
 *    (the candidate numbers). Never a blank label.
 *
 * Neither summary repeats the tool's own name: the billet's header already reads
 * `aem_semantic_search`, so "Semantic search:" in the summary printed "semantic
 * search" twice in one line. The summary carries the distinguishing value, as
 * `aem_query`'s does (`fulltext=greenlake`).
 */

/** A `matches` entry (`4`, or `{ candidate: 4, excerpt: 2 }`) as its number, if it has one. */
function matchCandidate(match: JsonValue): string | undefined {
  if (typeof match === 'number') return String(match);
  return asCount(asRecord(match)?.['candidate']);
}

function describeCall(
  args: Readonly<Record<string, JsonValue>>,
  data?: JsonValue,
): ToolCallDetails {
  const result = asRecord(data);
  const known = result?.['operation'] === 'aem_semantic_search' ? result : undefined;

  // The call's own `terms` - never the result's - decide which kind it is: a
  // continue call's result also echoes the terms, so reading them from there
  // would mislabel it as a start call.
  const terms = asText(args['terms']);
  if (terms === undefined) {
    const matches = Array.isArray(args['matches']) ? args['matches'] : [];
    const numbers = matches
      .map(matchCandidate)
      .filter((number): number is string => number !== undefined);
    return {
      summary: `judging ${String(matches.length)} match${matches.length === 1 ? '' : 'es'}`,
      parameters: parameterRows([
        ['Search ID', asText(args['searchId'])],
        ['Matched', numbers.length > 0 ? numbers.join(', ') : undefined],
      ]),
    };
  }

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
