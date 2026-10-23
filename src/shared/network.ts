/**
 * Application-wide limits for outbound requests that are not specific to AEM,
 * the browser pane or any one tool.
 *
 * `DEFAULT_REQUEST_CONCURRENCY` is the **one** default for how many
 * asynchronous requests a pooled workflow keeps in flight:
 *
 * - the private browser bridge's request slots
 *   (`BridgeBrokerDeps.maxConcurrentRequests`, defaulting to this value);
 * - a tool's page-detail reads (the semantic search's pooled `mapPooled`), so a
 *   page is enriched without opening an unbounded number of requests against
 *   the author instance.
 *
 * This is async I/O concurrency, not OS threads. It is deliberately small: it
 * bounds author/AEM load, and requests beyond it wait in FIFO order. Raising a
 * caller's pool above the bridge's slot count only queues more requests; it
 * does not add real concurrency.
 */
export const DEFAULT_REQUEST_CONCURRENCY = 4;
