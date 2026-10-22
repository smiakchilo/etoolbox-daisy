import { z } from 'zod';
import {
  type ToolExecutor,
  type JsonValue,
  type RequestId,
  type Result,
  type SearchFilter,
  type ToolDescriptor,
  type ToolError,
  type ToolHost,
  AEM_COUNT_TIMEOUT_MS,
  CONTENT_ROOT_DEFAULT,
  LOAD_ALL_ROW_LIMIT,
  MAX_QUERY_LIMIT,
  MAX_SEARCH_ROOTS,
  MIN_QUERY_LIMIT,
  SEARCH_PAGE_SIZE,
  TURN_COMPLETE_RESULT_KEY,
  applySearchFilters,
  buildQueryUrl,
  classifyAemResponse,
  computeDeadline,
  createToolError,
  describeSearchFilters,
  describeTotalValues,
  effectiveRoots,
  err,
  isComponentSearchPredicates,
  jsonValueSchema,
  newRequestId,
  ok,
  readCountTotal,
  resolveSearchRoots,
  resolveSearchScope,
  searchFiltersSchema,
  searchRootsSchema,
} from '../../shared';

/**
 * The `aem_query_format_ask` tool, self-contained: a **composite** tool.
 *
 * Its name follows the composite-tool convention - the base tool, then the
 * mixins it adds, in the order they run: `aem_query`, then `format_table`, then
 * `ask_user`. It is the `/search` loop made deterministic. A full-text query
 * runs through `aem_query`; the page goes to `format_table` (`new`, then
 * `append`); while more results may exist, `ask_user` offers one "Load more"
 * button, and a click repeats the loop at the next offset. Once an exact total
 * is known and fits in `LOAD_ALL_ROW_LIMIT` rows, a "Load all" button is
 * offered alongside it; a click then fetches the whole remainder in one
 * `aem_query` request (a nested call may ask for that larger `limit`; the model
 * may not) and appends it as one table block. The
 * model makes one call and never relays JSON between tools, and never forgets a
 * button. A hand-built search passes its QueryBuilder predicates instead of
 * terms; the loop is the same.
 *
 * Every step is the real tool, run through {@link ToolHost.invokeTool} (the
 * tool-to-tool bridge), so each step shows in the transcript and journal
 * exactly as if the model had called it, and each step keeps its own
 * validation. The parts are declared in the manifest's `uses` list.
 *
 * **The honest total.** `aem_query` sends a numeric `p.guessTotal` cap, so its
 * total is exact below the cap and a lower bound at it. When page 1's total is
 * only a lower bound this executor starts **one** background count - a direct
 * `host.bridge.request` with no `p.guessTotal`, run sequentially per effective
 * root - and passes `totalPending: true` on every `format_table` call while it
 * runs (so the total line wears a spinner). When it settles the executor makes
 * one extra `append` call carrying either the exact total ("Total: 12,345")
 * or, on failure, no total line at all (the fallback stays). The
 * count has no billet and no journal entry of its own; only the `format_table`
 * calls it drives do.
 */

export const AEM_QUERY_FORMAT_ASK_TOOL_NAME = 'aem_query_format_ask';
export const AEM_QUERY_FORMAT_ASK_ALLOWLIST_ENTRY = 'custom:aem_query_format_ask';

/** The tools this one runs, in order; the manifest's `uses` list. */
export const AEM_QUERY_FORMAT_ASK_USES = ['aem_query', 'format_table', 'ask_user'] as const;

const LOAD_MORE = 'Load more';
/** The whole-result button; only offered alongside "Load more" when it fits (see below). */
const LOAD_ALL = 'Load all';

export const aemQueryFormatAskArgsSchema = z
  .object({
    /** The full-text search string, sent as QueryBuilder's `fulltext` predicate. */
    terms: z.string().trim().min(1).optional(),
    /**
     * A hand-built QueryBuilder predicate map, instead of `terms`. Validated by
     * `aem_query` itself, exactly as if the model had passed it there.
     */
    predicates: z.record(z.string(), z.string()).optional(),
    /**
     * Where to search: full paths as the user wrote them, or path fragments the
     * application resolves (`resolveSearchScope`). Omitted falls back to the
     * host's content roots followed by its DAM roots; the Scope rules tell the
     * model to pass the family the subject needs instead.
     */
    roots: searchRootsSchema
      .describe(
        'JCR paths or path fragments to search under, exactly as the user wrote them: a full ' +
          'path ("/content/site/us/en") or a fragment ("us/en"). The application resolves a ' +
          'fragment to a full path. Never build or complete a path yourself - not from the ' +
          'current page, not from another path you have seen. When the user names no path, pass ' +
          "the root family the subject needs (the host's content roots for pages and components, " +
          'its DAM roots for files and assets, both when both are asked for), as listed in the ' +
          'current-page context block. See Scope in your instructions.',
      )
      .optional(),
    /** Which result fields come back per hit, as `aem_query`'s `properties`. */
    properties: z
      .array(z.string().min(1))
      .describe(
        'Omit it unless the user asked to see particular fields: every field adds a column to ' +
          'the table, whose first column is always `Path`. Name fields relative to the matched ' +
          'node (e.g. "jcr:content/jcr:title"), never `path`.',
      )
      .optional(),
    /** Rows per page (per root, as with `aem_query`). */
    limit: z
      .number()
      .int()
      .min(MIN_QUERY_LIMIT)
      .max(MAX_QUERY_LIMIT)
      .default(SEARCH_PAGE_SIZE)
      .describe('Rows per page. Omit it unless the user asked for a page size.'),
    /**
     * Keep only results whose page carries a given property value (a template,
     * a replication state, a modification date, ...).
     */
    filters: searchFiltersSchema.optional(),
  })
  .strict()
  .refine((args) => (args.terms === undefined) !== (args.predicates === undefined), {
    message: 'Pass exactly one of `terms` or `predicates`',
  });

export const AEM_QUERY_FORMAT_ASK_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: AEM_QUERY_FORMAT_ASK_TOOL_NAME,
  description:
    'Runs an AEM search and presents it completely, in one call: it queries, shows the page as ' +
    "the chat's table, and, while more results may exist, offers the user a 'Load more' button " +
    'and loads the next page when it is clicked. When an exact total is known and is small ' +
    "enough to fetch in one go, it also offers 'Load all', which loads every remaining page. " +
    'Pass either `terms` (a plain full-text search ' +
    'string) or `predicates` (a hand-built QueryBuilder predicate map, exactly as for ' +
    'aem_query) - never both. A `predicates` search that carries its own `path` scopes itself: ' +
    'never combine `roots` with a `path` predicate. `properties` ' +
    'optionally selects the fields per hit - leave it out unless the user asked for particular ' +
    'fields, since each one adds a table column. ' +
    'A search that matches a component by `sling:resourceType` shows each hit against its ' +
    'owning page, with the path within the page beside it. ' +
    'Optional `filters` keep only results whose page carries a given property value; a ' +
    'component search applies a filter to the page that owns the component. Each filter is ' +
    '`{ property, operator?, value?, negate?, group? }`, the property named relative to the ' +
    "page's content node (`cq:template`). Filters apply to a `terms` search (then pages and " +
    'assets only), to predicates with type=cq:Page or type=dam:Asset, and to a component search. ' +
    'When it returns, the table is already on screen and the user has finished loading pages: ' +
    'do not call aem_query, ask_user or this tool again for the same search, and do not repeat ' +
    'the results.',
  parameters: z.toJSONSchema(aemQueryFormatAskArgsSchema, { io: 'input' }),
};

/** A predicate map as one readable line: `key=value; key=value`. */
export function describePredicates(predicates: Readonly<Record<string, JsonValue>>): string {
  return Object.entries(predicates)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('; ');
}

/** Why the loop ended: no further results, or the user did not ask for more. */
export type SearchEnd = 'exhausted' | 'stopped';

/** The parts of an `aem_query` payload this tool reads. */
const queryPageSchema = z.looseObject({
  rows: z.array(jsonValueSchema),
  pagination: z.looseObject({
    hasMore: z.union([z.boolean(), z.literal('unknown')]),
    total: jsonValueSchema,
  }),
});

const askAnswerSchema = z.looseObject({ selections: z.array(z.string()) });

function isRecord(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The separator inside a page path that marks where the page ends and its content begins. */
const JCR_CONTENT_SEGMENT = '/jcr:content/';

/** The keys a component hit's page path lives under - the standard identifying keys. */
const PAGE_PATH_KEYS = ['jcr:path', 'path'] as const;

/**
 * Splits a component hit's path for display: the identifying `jcr:path`/`path`
 * key keeps the owning page (so the column reads the shared `Path` header), and
 * a `node` key is added with the component node's path within it (so the column
 * reads the plain title-cased `Node`, with no bespoke header). The row is
 * copied, never mutated; a path with no `/jcr:content/`, or a row carrying no
 * path at all, is returned unchanged.
 */
function toComponentNodeRow(row: JsonValue): JsonValue {
  if (!isRecord(row)) return row;
  for (const key of PAGE_PATH_KEYS) {
    const value = row[key];
    if (typeof value === 'string') {
      const at = value.indexOf(JCR_CONTENT_SEGMENT);
      if (at > 0) {
        return { ...row, [key]: value.slice(0, at), node: value.slice(at + 1) };
      }
    }
  }
  return row;
}

/**
 * A stateful display mapper for a component search's rows. It rewrites each
 * hit with {@link toComponentNodeRow}, then **blanks a page path that repeats
 * the row above** - a page with several placements shows its path once, and the
 * empty cell means "the same page as the row above". The blanking runs across
 * pages (the state outlives one `format_table` page), so a Load more page whose
 * first hit belongs to the previous page's last row has no seam. The row itself
 * is kept, so the `#` numbering still counts every placement.
 */
function createComponentNodeDisplay(): (rows: readonly JsonValue[]) => JsonValue[] {
  let lastPagePath: string | undefined;
  return (rows) =>
    rows.map((row) => {
      const mapped = toComponentNodeRow(row);
      if (!isRecord(mapped)) return mapped;
      for (const key of PAGE_PATH_KEYS) {
        const pagePath = mapped[key];
        if (typeof pagePath !== 'string') continue;
        const repeated = pagePath === lastPagePath;
        lastPagePath = pagePath;
        return repeated ? { ...mapped, [key]: '' } : mapped;
      }
      return mapped;
    });
}

/** A total as words, never a bare number: a lower bound stays a lower bound. */
export function describeSearchTotal(
  total: JsonValue | undefined,
  hasMore: JsonValue | undefined,
): string {
  return describeTotalValues(total, hasMore);
}

/** The table's total line for a proved exact count. */
function exactTotalLine(value: number): string {
  return `Total: ${String(value)}`;
}

/** The filters as a clause of the model's summary; empty when none apply. */
function describeFilterClause(filters: readonly SearchFilter[] | undefined): string {
  const described = describeSearchFilters(filters);
  return described === undefined ? '' : ` with filters ${described}`;
}

function unexpected(message: string, requestId: RequestId): Result<JsonValue, ToolError> {
  return err(createToolError('UNEXPECTED_RESPONSE', message, requestId));
}

/**
 * Builds the executor: validate, resolve the roots, then loop query -> table ->
 * (button -> next page). A failed step's own error is returned as this call's
 * error; a cancelled or declined "Load more" ends the search normally. A
 * background count (see the module doc) updates the total line in place.
 */
export function createAemQueryFormatAskExecutor(host: ToolHost): ToolExecutor {
  return async (rawArgs, context) => {
    const requestId = newRequestId(host.idGenerator);

    const parsed = aemQueryFormatAskArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Invalid aem_query_format_ask arguments';
      return err(createToolError('INVALID_ARGUMENT', message, requestId));
    }
    const { terms, limit, filters } = parsed.data;
    const searchPredicates = parsed.data.predicates ?? { fulltext: terms ?? '' };
    // The filters join the predicates the page query and the background count
    // both use; a shape they cannot be applied to is refused.
    const filtered = applySearchFilters(searchPredicates, filters);
    if (!filtered.ok) {
      return err(createToolError('INVALID_ARGUMENT', filtered.message, requestId));
    }
    const predicates = filtered.predicates;
    // A search that matches a component by `sling:resourceType` returns the
    // component instances; the table shows each against its owning page. Read
    // from the query - never asked of the model - so the page path cannot go
    // missing when a call forgets a display flag.
    const componentNodeDisplay = isComponentSearchPredicates(searchPredicates)
      ? createComponentNodeDisplay()
      : undefined;
    const scopedByPath = Object.prototype.hasOwnProperty.call(predicates, 'path');
    // A fragment (`us/en`) becomes a full path here - by configuration, a lookup
    // or a question to the user, never a guess. A `path` predicate is left to
    // `aem_query`, which rejects the combination with `roots`.
    let explicitRoots = parsed.data.roots;
    if (explicitRoots !== undefined && !scopedByPath) {
      const resolvedScope = await resolveSearchScope({
        host,
        context,
        requestId,
        roots: explicitRoots,
      });
      if (!resolvedScope.ok) return resolvedScope;
      explicitRoots = resolvedScope.value;
    }
    const roots =
      explicitRoots ??
      (scopedByPath
        ? undefined
        : resolveSearchRoots(host.environmentFacts()).slice(0, MAX_SEARCH_ROOTS));
    const scope = roots === undefined ? predicates['path'] : roots.join(', ');
    const subject = terms === undefined ? describePredicates(searchPredicates) : `"${terms}"`;
    const filterText = describeFilterClause(filters);

    /**
     * Every `format_table` call this executor makes is chained through here, so
     * the journal order is deterministic: a Load more page and the count's
     * settle call can never interleave into an order the table cannot replay.
     * A failure is returned to the caller to decide on (the loop returns it;
     * the settle call is a UX best-effort).
     */
    let chain: Promise<void> = Promise.resolve();
    const showTable = (
      args: Readonly<Record<string, JsonValue>>,
    ): Promise<Result<JsonValue, ToolError>> => {
      const result = chain.then(() => host.invokeTool('format_table', args, context));
      chain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };

    // --- the background honest count -----------------------------------------
    // Its own controller, linked to the turn's signal: it is aborted when the
    // loop ends, when the turn is cancelled, or once paging itself proves the
    // end. The abort is client-side only - the AEM-side query runs to
    // completion regardless (see docs/accurate-search-total.md F5).
    const countAbort = new AbortController();
    const abortCount = (): void => {
      countAbort.abort();
    };
    if (context.signal?.aborted === true) countAbort.abort();
    else context.signal?.addEventListener('abort', abortCount, { once: true });

    let countStarted = false;
    let countSettled = false;
    let exactTotal: number | undefined;
    let finished = false;
    /** True while a "Load more" question is awaiting the user's answer. */
    let askPending = false;
    /** Whether the question now pending already carries "Load all". */
    let loadAllOffered = false;

    const runCount = async (): Promise<number | undefined> => {
      let current;
      try {
        current = host.currentContext();
      } catch {
        return undefined;
      }
      // One request per effective root, sequentially, to limit author load.
      // The priority ordering splits the same roots, so their union count is
      // the same; a `path` predicate is one request on its own.
      const countRoots: readonly (string | undefined)[] = scopedByPath
        ? [undefined]
        : effectiveRoots(roots ?? [CONTENT_ROOT_DEFAULT]);
      let sum = 0;
      for (const root of countRoots) {
        if (countAbort.signal.aborted) return undefined;
        const scoped = root === undefined ? predicates : { ...predicates, path: root };
        const built = buildQueryUrl({ mode: 'count', origin: current.origin, predicates: scoped });
        if (!built.ok) return undefined;
        const countRequestId = newRequestId(host.idGenerator);
        const outcome = await host.bridge.request(
          {
            operation: AEM_QUERY_FORMAT_ASK_TOOL_NAME,
            requestId: countRequestId,
            chatId: current.chatId,
            turnId: current.turnId,
            serverId: current.serverId,
            serverRevision: current.serverRevision,
            navigationEpoch: current.navigationEpoch,
            deadlineMs: computeDeadline(host.clock, AEM_COUNT_TIMEOUT_MS),
            args: { predicates: scoped },
          },
          built.value.url,
        );
        if (countAbort.signal.aborted) return undefined;
        if (outcome.kind !== 'response') return undefined;
        const classified = classifyAemResponse({
          status: outcome.status,
          contentType: outcome.contentType,
          bodyText: outcome.bodyText,
        });
        host.recordResponseClassification?.(countRequestId, classified.kind);
        if (classified.kind !== 'ok') return undefined;
        const total = readCountTotal(classified.value);
        if (total === undefined) return undefined;
        sum += total;
      }
      return sum;
    };

    /** One extra append carrying the count's verdict; the run's fallback stays on failure. */
    const settleTable = async (exact: number | undefined): Promise<void> => {
      await showTable({
        data: { rows: [] },
        mode: 'append',
        totalPending: false,
        ...(exact === undefined ? {} : { totalLine: exactTotalLine(exact) }),
      });
    };

    /** Starts the one count, only when page 1's total is a lower bound. */
    const maybeStartCount = (pageTotal: JsonValue): void => {
      if (countStarted) return;
      if (!isRecord(pageTotal) || pageTotal['accuracy'] !== 'atLeast') return;
      countStarted = true;
      const handleCount = (exact: number | undefined): void => {
        countSettled = true;
        if (exact !== undefined) exactTotal = exact;
        else host.reportToolDiagnostic?.('AEM_COUNT_FAILED');
        // A count that settles after the executor returned (any exit, including
        // an early error) must not enqueue a nested call: `finished` is set in
        // `finally`, before this microtask can run.
        if (finished || context.signal?.aborted === true) return;
        // The count usually settles while "Load more" is already on screen:
        // offer "Load all" on that very question instead of the next one.
        if (askPending && !loadAllOffered && canLoadAll(total, rowCount, hasMore)) {
          loadAllOffered = true;
          host.addUserInputActions?.([LOAD_ALL]);
        }
        void settleTable(exact);
      };
      // `runCount` is written not to reject, but a rejected promise must never
      // become an unhandled rejection: treat it exactly as a failed count.
      runCount().then(handleCount, () => {
        handleCount(undefined);
      });
    };

    let offset = 0;
    let pages = 0;
    let rowCount = 0;
    /**
     * How many rows a "Load all" click would still fetch, or `undefined` when it
     * must not be offered. It needs an **exact** total (`exactTotal` from the
     * background count, or the page's own total when it is already exact) and
     * the remaining matches must fit in `LOAD_ALL_ROW_LIMIT`, so one click
     * fetches a proven, bounded number of rows - never an unbounded set. A
     * lower-bound total offers no "Load all": the true size is unknown while the
     * count runs, and the next question - once the count has settled - offers
     * it. With a multi-root fan-out `limit` applies per root, so this remainder
     * is a safe upper bound for each root.
     */
    const loadAllRemaining = (
      pageTotal: JsonValue,
      rowsShown: number,
      more: boolean | 'unknown',
    ): number | undefined => {
      if (more !== true) return undefined;
      const pageExact =
        isRecord(pageTotal) &&
        pageTotal['accuracy'] === 'exact' &&
        typeof pageTotal['value'] === 'number'
          ? pageTotal['value']
          : undefined;
      const exact = exactTotal ?? pageExact;
      if (exact === undefined) return undefined;
      const remaining = exact - rowsShown;
      return remaining > 0 && remaining <= LOAD_ALL_ROW_LIMIT ? remaining : undefined;
    };
    const canLoadAll = (
      pageTotal: JsonValue,
      rowsShown: number,
      more: boolean | 'unknown',
    ): boolean => loadAllRemaining(pageTotal, rowsShown, more) !== undefined;
    /** Set once the user clicks "Load all": the next request is the last one. */
    let loadAll = false;
    /** The `limit` of the next request: a page, or - after "Load all" - the whole remainder. */
    let requestLimit = limit;
    let total: JsonValue;
    let hasMore: boolean | 'unknown';
    let ended: SearchEnd;

    try {
      for (;;) {
        if (context.signal?.aborted === true) {
          return err(createToolError('CANCELLED', 'The search was cancelled', requestId));
        }
        const query = await host.invokeTool(
          'aem_query',
          {
            predicates,
            ...(roots === undefined ? {} : { roots: [...roots] }),
            properties: [...(parsed.data.properties ?? [])],
            limit: requestLimit,
            offset,
          },
          context,
        );
        if (!query.ok) return query;
        const page = queryPageSchema.safeParse(query.value);
        if (!page.success) return unexpected('aem_query returned an unexpected result', requestId);
        const { rows, pagination } = page.data;

        // Started before the page is painted, so the page's own `format_table`
        // call already carries `totalPending: true`.
        if (pages === 0) maybeStartCount(pagination.total);

        // Display only: the query's hits keep their real paths; a component
        // instance is shown against its owning page, with its node beside it.
        const displayedRows =
          componentNodeDisplay === undefined ? rows : componentNodeDisplay(rows);
        const shown = await showTable({
          data: { rows: displayedRows, pagination: pagination as unknown as JsonValue },
          mode: pages === 0 ? 'new' : 'append',
          totalPending: countStarted && !countSettled,
          ...(exactTotal === undefined ? {} : { totalLine: exactTotalLine(exactTotal) }),
        });
        if (!shown.ok) return shown;

        pages += 1;
        rowCount += rows.length;
        total = pagination.total;
        hasMore = pagination.hasMore;
        if (hasMore === false) {
          ended = 'exhausted';
          break;
        }

        if (loadAll) {
          // The "Load all" request asked for the whole proven remainder; if the
          // result still says more exists, the data changed underneath it - stop
          // rather than loop.
          ended = 'stopped';
          break;
        }

        const actions = canLoadAll(pagination.total, rowCount, hasMore)
          ? [LOAD_MORE, LOAD_ALL]
          : [LOAD_MORE];
        loadAllOffered = actions.includes(LOAD_ALL);
        askPending = true;
        const asked = await host.invokeTool('ask_user', { actions }, context);
        askPending = false;
        if (!asked.ok) {
          if (asked.error.code === 'CANCELLED') {
            ended = 'stopped';
            break;
          }
          return asked;
        }
        const answer = askAnswerSchema.safeParse(asked.value);
        const selections = answer.success ? answer.data.selections : [];
        const wantsAll = selections.includes(LOAD_ALL);
        const remaining = wantsAll ? loadAllRemaining(total, rowCount, hasMore) : undefined;
        if (remaining !== undefined) {
          loadAll = true;
          requestLimit = remaining;
        } else if (!wantsAll && !selections.includes(LOAD_MORE)) {
          ended = 'stopped';
          break;
        }
        offset += limit;
      }
    } finally {
      // Marked before anything can await: a count settling after this point
      // (an early error return, a stop) must not enqueue a nested call.
      finished = true;
      context.signal?.removeEventListener('abort', abortCount);
      // Exit while the count is pending: abort it and settle the table so no
      // spinner is left for a run that is over. A cancelled turn refuses
      // nested calls, so there the journal's last call stays `totalPending`
      // and `journalReplay` settles it on restore.
      if (countStarted && !countSettled) {
        abortCount();
        if (context.signal?.aborted !== true) {
          await showTable({ data: { rows: [] }, mode: 'append', totalPending: false });
        }
      }
    }

    // The best total known at return: the count if it finished, else the last
    // page's own.
    const effectiveTotal: JsonValue =
      exactTotal === undefined ? total : { accuracy: 'exact', value: exactTotal };
    const totalText = describeSearchTotal(effectiveTotal, hasMore);
    const reason =
      ended === 'exhausted'
        ? 'no further results exist'
        : 'the user did not load more (further results may exist)';
    return ok({
      operation: AEM_QUERY_FORMAT_ASK_TOOL_NAME,
      requestId,
      ...(terms === undefined ? { predicates: searchPredicates } : { terms }),
      // The typed filter objects are plain JSON; the cast only satisfies the
      // index-signature shape a JsonValue has.
      ...(filters === undefined ? {} : { filters: filters as unknown as JsonValue }),
      ...(roots === undefined ? {} : { roots: [...roots] }),
      pageSize: limit,
      pages,
      rows: rowCount,
      total: effectiveTotal,
      hasMore,
      ended,
      // This call is the whole search: the table is on screen and the run is
      // over, so the model's turn ends here rather than being resumed for a
      // "search is finished" completion (see `TURN_COMPLETE_RESULT_KEY`).
      [TURN_COMPLETE_RESULT_KEY]: true,
      textResultForLlm:
        `Searched for ${subject}${filterText} in ${scope ?? 'the whole repository'}: ${String(rowCount)} row(s) over ` +
        `${String(pages)} page(s) are on screen in the chat's table (total matches: ` +
        `${totalText}). The search is finished because ${reason}. Do not repeat the results ` +
        'or call the search tools again for this search.',
      resultType: 'success',
    });
  };
}
