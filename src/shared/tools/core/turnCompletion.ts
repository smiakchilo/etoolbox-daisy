import type { JsonValue } from '../../contracts';

/**
 * The marker a tool sets on its success payload when the model's turn must end
 * as soon as that call settles.
 *
 * Why it exists: a composite search (`aem_query_format_ask`, the terminal call
 * of `aem_semantic_search`) runs its whole query/table/ask-user loop *inside*
 * one tool call, and its rendered table is the entire answer. The SDK's normal
 * contract is "tool result in, model turn out", so the model is otherwise
 * resumed for one more completion whose only content is a generic "search is
 * finished" - a whole round trip (time, tokens) that adds nothing. A tool that
 * sets this marker tells every agent adapter to end the turn at that result
 * instead of resuming the model.
 *
 * Deliberately a marker on the *result*, not a `turnEnds` flag on the tool
 * manifest: `aem_semantic_search` runs one long call and paints its table
 * before it returns, so only its final result carries the marker. A per-tool
 * flag would end the turn at the first result regardless.
 *
 * The key is part of the tool-result convention, so it lives in `src/shared`
 * where each tool folder and every agent adapter can agree on it without
 * depending on one another.
 */
export const TURN_COMPLETE_RESULT_KEY = 'turnComplete';

/** Whether a tool result's data carries the turn-complete marker. */
export function isTurnCompleteResult(data: JsonValue | undefined): boolean {
  if (typeof data !== 'object' || data === null) return false;
  // An array is an object too; indexing it by the marker key yields
  // `undefined`, so an array result simply never carries the marker.
  return (data as Readonly<Record<string, JsonValue>>)[TURN_COMPLETE_RESULT_KEY] === true;
}
