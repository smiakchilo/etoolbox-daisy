/**
 * The search batch size: how many AEM hits a search composite
 * (`aem_query_format_ask`, `aem_semantic_search`) queries per page - and so per
 * "Load more" click - when the call does not set `limit`. The one place to
 * change it; descriptors and instructions are built from it.
 */
export const SEARCH_PAGE_SIZE = 20;
