/**
 * The search batch size: how many AEM hits a search composite
 * (`aem_query_format_ask`, `aem_semantic_search`) queries per page - and so per
 * "Load more" click - when the call does not set `limit`. The one place to
 * change it; descriptors and instructions are built from it.
 */
export const SEARCH_PAGE_SIZE = 20;

/**
 * The value every `aem_query` page request sends as `p.guessTotal`.
 *
 * QueryBuilder is asked to keep counting only up to this cap. Below it the
 * reported `total` is exact ("Total: 43 results"); at or above it the total is
 * a lower bound and the server sets `more: true`, so the table reads "100+
 * results". A numeric cap is what lets the application show a usable total on
 * the first page *and* keep "Load more" (which a bare `p.guessTotal=true`
 * cannot - see docs/compatibility.md's QueryBuilder facts).
 */
export const TOTAL_GUESS_CAP = 100;
