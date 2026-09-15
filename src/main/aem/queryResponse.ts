import type { JsonValue } from '../../shared/contracts/agentEvents';
import type { HasMore, TotalMatches } from '../../shared/contracts/toolResult';
import type { JsonObject } from './responseValidation';

/**
 * Interprets a QueryBuilder response envelope (implementation-plan.md step
 * 08: "Check QueryBuilder `success:false` even with HTTP 200. Do not turn it
 * into an empty successful search").
 *
 * This module exists because QueryBuilder does not use HTTP to report query
 * failures. A rejected predicate - a typo, an evaluator the instance does not
 * have installed, a malformed date bound - comes back as **HTTP 200,
 * `Content-Type: application/json`, a perfectly well-formed body** whose
 * `success` field is `false` and whose `hits` array is absent or empty.
 *
 * Every layer before this one is therefore satisfied: the status is fine, the
 * content type is fine, it parses, and it is an object. `classifyAemResponse`
 * correctly returns `ok`. If nothing then reads `success`, the natural
 * reading of that body is "the query ran and matched nothing" - which is the
 * exact inversion the plan forbids, produced without a single bug in any
 * individual step.
 */

export type QueryEnvelopeOutcome =
  | { readonly kind: 'ok'; readonly value: QueryEnvelope }
  /** `success: false`, or a body with no usable `success` flag at all. */
  | { readonly kind: 'query_rejected' }
  /** `success: true` but `hits` is missing or is not an array. */
  | { readonly kind: 'malformed_envelope' };

export interface QueryEnvelope {
  readonly hits: readonly JsonValue[];
  /**
   * QueryBuilder's own `more` flag when it sent one, otherwise `"unknown"`.
   * Never defaulted to `false`: "the server did not tell us" and "there is
   * nothing further" are different facts, and collapsing them is how a
   * truncated page starts looking like a complete answer.
   */
  readonly hasMore: HasMore;
  readonly total: TotalMatches;
}

function readNonNegativeInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Decides how much the reported total can be trusted.
 *
 * The application always sends `p.guessTotal=true`, which explicitly permits
 * QueryBuilder to stop counting early, so `"estimated"` is the honest default
 * rather than a degraded one.
 *
 * The single exception is provable rather than assumed: when the server says
 * there are no further results (`more: false`) and the rows on this page
 * account for the whole reported total, the count has been enumerated end to
 * end and cannot be a guess. Any other combination - including `more` absent
 * entirely - stays `"estimated"`.
 */
function classifyTotal(
  reportedTotal: number | undefined,
  hasMore: HasMore,
  offset: number,
  returned: number,
): TotalMatches {
  if (reportedTotal === undefined) {
    return { accuracy: 'unknown' };
  }
  if (hasMore === false && offset + returned === reportedTotal) {
    return { accuracy: 'exact', value: reportedTotal };
  }
  return { accuracy: 'estimated', value: reportedTotal };
}

export interface ReadQueryEnvelopeInput {
  /** The already-classified `{ kind: "ok" }` body from `classifyAemResponse`. */
  readonly body: JsonObject;
  /** The offset the application actually requested, used to judge total accuracy. */
  readonly offset: number;
}

/**
 * Reads a QueryBuilder body into a {@link QueryEnvelope}, or names why it is
 * not usable.
 *
 * `success` is required to be the literal boolean `true`. A missing flag is
 * treated as a rejection, not as an optimistic success: the only bodies this
 * application ever asks for come from QueryBuilder, which always sets it, so
 * a body without one is not a QueryBuilder result and there is nothing to be
 * gained by guessing that it worked.
 */
export function readQueryEnvelope(input: ReadQueryEnvelopeInput): QueryEnvelopeOutcome {
  const { body } = input;

  if (body['success'] !== true) {
    return { kind: 'query_rejected' };
  }

  const hits = body['hits'];
  if (!Array.isArray(hits)) {
    return { kind: 'malformed_envelope' };
  }

  const more = body['more'];
  const hasMore: HasMore = typeof more === 'boolean' ? more : 'unknown';
  const total = classifyTotal(
    readNonNegativeInteger(body['total']),
    hasMore,
    input.offset,
    hits.length,
  );

  return { kind: 'ok', value: { hits, hasMore, total } };
}
