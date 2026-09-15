import type { AemQueryArgs } from '../../shared/contracts/toolContracts';
import type {
  AemQuerySuccess,
  PaginationMetadata,
  PropertySelection,
} from '../../shared/contracts/toolResult';
import type { RequestId } from '../../shared/contracts/ids';
import type { QueryEnvelope } from './queryResponse';

/**
 * Projects a validated QueryBuilder envelope into the `aem_query` success
 * result (implementation-plan.md step 08).
 *
 * The rows are passed through as QueryBuilder returned them. There is no
 * filtering pass here, deliberately: the projection was already applied at
 * the request, by `p.hits=selective` + `p.properties`, so the server sent
 * only the requested fields and re-filtering would be a second, divergent
 * definition of the same selection. It would also be actively harmful - a
 * field the server chose to include and this module dropped would vanish
 * with no record that it ever existed.
 *
 * This function is pure and total, and it never fetches. In particular it
 * never follows `hasMore` to assemble a fuller answer: step 08 requires that
 * later pages come from separate tool calls, so the only thing this module
 * does about more data is *report* it.
 */

export interface ProjectQueryResultInput {
  readonly envelope: QueryEnvelope;
  readonly args: AemQueryArgs;
  /** The property list actually sent as `p.properties`, from `buildQueryUrl`. */
  readonly projectedProperties: readonly string[];
  readonly requestId: RequestId;
  readonly sourceOrigin: string;
  readonly serverRevision: number;
  readonly fetchedAt: number;
}

export function projectQueryResult(input: ProjectQueryResultInput): AemQuerySuccess {
  const rows = [...input.envelope.hits];

  // Always `"selected"`, never `"all"`: this tool cannot return every
  // property of a hit, because the request pinned `p.hits=selective` and
  // `p.nodedepth=0`. Reporting `{ kind: "all" }` would tell the agent the
  // absence of a property means the node does not have it, when it only
  // means the property was not asked for.
  const selection: PropertySelection = {
    kind: 'selected',
    properties: [...input.projectedProperties],
  };

  const pagination: PaginationMetadata = {
    offset: input.args.offset,
    limit: input.args.limit,
    returned: rows.length,
    hasMore: input.envelope.hasMore,
    total: input.envelope.total,
  };

  return {
    ok: true,
    operation: 'aem_query',
    requestId: input.requestId,
    sourceOrigin: input.sourceOrigin,
    serverRevision: input.serverRevision,
    predicates: { ...input.args.predicates },
    fetchedAt: input.fetchedAt,
    rows,
    selection,
    pagination,
  };
}
