import type { ToolError } from '../../contracts';
import { ok, type Result } from '../../result';

/**
 * A reusable **query-with-callback** fill routine, as a state machine: query a
 * page of a paged source, process that page into accepted items, and keep
 * querying while fewer than a display page has been accepted and the source may
 * have more. Only then is a display page handed out.
 *
 * A search that post-filters a paged source needs this. The semantic search is
 * the worked example: AEM is queried a page of hits at a time, and every hit is
 * answered, so a source page can yield no displayable rows at all. Showing its
 * first page whatever its verdicts left would offer "Load more" under "no
 * results" - the confusing state this routine removes.
 *
 * The processing step is deliberately **not** called by this module:
 *
 * - for a search whose filter runs in code, `accept` is called with that page's
 *   survivors straight away, inside one tool call;
 * - for the semantic search the "callback" is the **model's verdict**, which
 *   arrives in a later tool call. The loop therefore spans calls: the executor
 *   queries, hands the candidates to the model, and the next call's `accept`
 *   records the verdict. The queue carries the state across them.
 *
 * Surplus items are kept. `takePage` removes exactly one display page, so an
 * item accepted on the page that filled a display page is first in line for the
 * next one - no re-query and no re-processing (no re-answering by the model).
 *
 * The loop's decision is `needsPage()`: true while the buffer is short of a
 * display page and the source is not exhausted. A caller drives it as
 *
 * ```
 * for (;;) {
 *   if (queue.needsPage()) {
 *     const page = await fetchNextPage();
 *     if (page has items to process) return them;   // deferred: process later
 *     if (!page.hasMore) queue.exhaust();
 *     continue;                                     // try the next page
 *   }
 *   const rows = queue.takePage();                  // a display page is ready
 *   show(rows);
 *   if (!queue.hasMore) break;
 *   if (!userWantsMore()) break;
 * }
 * ```
 */
export interface PageFillQueue<T> {
  /** Items per display page. */
  readonly pageSize: number;
  /** Accepted items not yet handed out, oldest first. */
  readonly buffered: readonly T[];
  /** True once the caller has declared that the source has no further pages. */
  readonly sourceExhausted: boolean;
  /**
   * Whether anything may still be displayed: a buffered item, or a source page
   * that has not been fetched yet. After `takePage` this is the honest "so far"
   * of a total line.
   */
  readonly hasMore: boolean;
  /**
   * Whether another source page must be fetched and processed before a display
   * page can be handed out.
   */
  needsPage(): boolean;
  /** Records that the source cannot supply a further page. Idempotent. */
  exhaust(): void;
  /** Adds one processed page's accepted items, keeping their order. */
  accept(items: readonly T[]): void;
  /**
   * Removes and returns the next display page: up to `pageSize` buffered items.
   * Call it once `needsPage()` is false (the buffer is full, or the source is
   * exhausted); it still returns what is buffered, so a short final page comes
   * out whole.
   */
  takePage(): readonly T[];
}

/** Creates the queue for one display page size. */
export function createPageFillQueue<T>(pageSize: number): PageFillQueue<T> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError(
      `A page fill queue needs a positive integer page size, got ${String(pageSize)}`,
    );
  }
  const items: T[] = [];
  let exhausted = false;
  return {
    pageSize,
    get buffered() {
      return items;
    },
    get sourceExhausted() {
      return exhausted;
    },
    get hasMore() {
      return items.length > 0 || !exhausted;
    },
    needsPage() {
      return items.length < pageSize && !exhausted;
    },
    exhaust() {
      exhausted = true;
    },
    accept(accepted) {
      items.push(...accepted);
    },
    takePage() {
      return items.splice(0, pageSize);
    },
  };
}

/** One fetched source page: its raw items and whether the source may have more. */
export interface PageFillPage<TRaw> {
  readonly items: readonly TRaw[];
  readonly hasMore: boolean | 'unknown';
}

export type PageFillOutcome = 'filled' | 'exhausted' | 'cancelled';

export interface PageFillOptions<TRaw, TItem> {
  readonly queue: PageFillQueue<TItem>;
  /** Queries the next source page. Called only while the queue is short. */
  readonly fetchPage: () => Promise<Result<PageFillPage<TRaw>, ToolError>>;
  /**
   * The callback: turns one fetched page into the items it accepts (a filter, a
   * read + answer, whatever the search needs). It may accept none, some or all.
   */
  readonly processPage: (items: readonly TRaw[]) => Promise<Result<readonly TItem[], ToolError>>;
  readonly isCancelled: () => boolean;
  /**
   * Called when a fetched page has no raw items at all. The caller can record
   * why it stopped (e.g. AEM claimed more); the routine itself always treats an
   * empty page as the end, because it cannot make progress from it.
   */
  readonly onEmptyPage?: (page: PageFillPage<TRaw>) => void;
}

/**
 * Drives {@link PageFillQueue}: fetch a page -> process it via the callback ->
 * accept its items -> repeat while the queue is short. It stops when the queue
 * can hand out a display page (full, or the source exhausted), when a fetched
 * page is empty, on cancellation, or when a callback returns an error.
 *
 * The display step is deliberately the caller's: this routine only decides how
 * many source pages a display page needs. `aem_semantic_search` wraps it in a
 * loop that paints the page and asks "Load more"; a code-only filter would use
 * the same routine with a non-model `processPage`.
 */
export async function runPageFill<TRaw, TItem>(
  options: PageFillOptions<TRaw, TItem>,
): Promise<Result<PageFillOutcome, ToolError>> {
  const { queue } = options;
  while (queue.needsPage()) {
    if (options.isCancelled()) return ok('cancelled');
    const page = await options.fetchPage();
    if (!page.ok) return page;
    if (page.value.items.length === 0) {
      options.onEmptyPage?.(page.value);
      queue.exhaust();
      return ok('exhausted');
    }
    const processed = await options.processPage(page.value.items);
    if (!processed.ok) return processed;
    queue.accept(processed.value);
    if (page.value.hasMore === false) queue.exhaust();
  }
  return ok(queue.sourceExhausted ? 'exhausted' : 'filled');
}
