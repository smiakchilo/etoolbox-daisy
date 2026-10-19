/**
 * The page size of every search - how many AEM hits a plain `aem_query` returns,
 * and how many rows a search composite (`aem_query_format_ask`,
 * `aem_semantic_search`) queries per page, and so per "Load more" click.
 *
 * This is the **only** page-size definition in the application. Every tool's
 * default, descriptor and instruction is built from it, and a bundled skill
 * never sets a `limit` of its own. Change it here and the whole application
 * follows.
 */
export const SEARCH_PAGE_SIZE = 20;

/**
 * The page size a call uses: the caller's explicit `limit` when one was given,
 * otherwise the one application page size. The model-facing schemas apply the
 * same default themselves; this is for executors that resolve an optional
 * argument after parsing.
 */
export function resolveSearchPageSize(limit: number | undefined): number {
  return limit ?? SEARCH_PAGE_SIZE;
}

/** The smallest `limit` any search tool accepts. */
export const MIN_QUERY_LIMIT = 1;

/**
 * The most `limit` the model may ask for in one call to any search tool
 * (`aem_query`, `aem_query_format_ask`, `aem_semantic_search`). `p.limit=-1` stays
 * inexpressible; only a nested "Load all" call may exceed this, up to
 * {@link LOAD_ALL_ROW_LIMIT}.
 */
export const MAX_QUERY_LIMIT = 200;

/**
 * The value every `aem_query` page request sends as `p.guessTotal`.
 *
 * QueryBuilder is asked to keep counting only up to this cap. Below it the
 * reported `total` is exact ("Total: 43"); at or above it the total is
 * a lower bound and the server sets `more: true`, so the table reads "100+". A
 * numeric cap is what lets the application show a usable total on
 * the first page *and* keep "Load more" (which a bare `p.guessTotal=true`
 * cannot - see docs/compatibility.md's QueryBuilder facts).
 */
export const TOTAL_GUESS_CAP = 100;

/**
 * The most roots one search call may name or fan out over: each root is a
 * separate AEM request through the concurrency-1 bridge, so this bounds a single
 * tool call's cost. A tuning value, not a protocol limit. A host whose default
 * (content, then DAM) roots exceed it is simply searched through the first
 * ones - see `docs/backlog.md` "Default root fan-out is silently capped".
 */
export const MAX_SEARCH_ROOTS = 10;

/**
 * The most rows one "Load all" click may fetch, in a single request. The
 * `aem_query_format_ask` composite only offers "Load all" when an exact total
 * proves the remaining matches fit within this many rows, so the one request it
 * then makes is bounded by a proven number - there is no unbounded `p.limit`.
 * It is also the most `limit` a *nested* `aem_query` call accepts (the model's
 * own cap stays 200).
 */
export const LOAD_ALL_ROW_LIMIT = 2000;
