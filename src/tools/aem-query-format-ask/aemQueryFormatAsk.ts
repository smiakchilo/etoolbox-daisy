import { z } from 'zod';
import {
  type AemToolExecutor,
  type JsonValue,
  type RequestId,
  type Result,
  type ToolDescriptor,
  type ToolError,
  type ToolHost,
  AEM_COUNT_TIMEOUT_MS,
  CONTENT_ROOT_DEFAULT,
  SEARCH_PAGE_SIZE,
  buildQueryUrl,
  classifyAemResponse,
  computeDeadline,
  createToolError,
  describeTotalValues,
  effectiveRoots,
  err,
  jsonValueSchema,
  newRequestId,
  ok,
  readCountTotal,
} from '../../shared';

/**
 * The `aem_query_format_ask` tool, self-contained: a **composite** tool.
 *
 * Its name follows the composite-tool convention - the base tool, then the
 * mixins it adds, in the order they run: `aem_query`, then `format_table`, then
 * `ask_user`. It is the `/search` loop made deterministic. A full-text query
 * runs through `aem_query`; the page goes to `format_table` (`new`, then
 * `append`); while more results may exist, `ask_user` offers one "Load more"
 * button, and a click repeats the loop at the next offset. The model makes one
 * call and never relays JSON between tools, and never forgets the button. A
 * hand-built search passes its QueryBuilder predicates instead of terms;
 * the loop is the same.
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
 * one extra `append` call carrying either the exact total ("Total: 12,345
 * results") or, on failure, no total line at all (the fallback stays). The
 * count has no billet and no journal entry of its own; only the `format_table`
 * calls it drives do.
 */

export const AEM_QUERY_FORMAT_ASK_TOOL_NAME = 'aem_query_format_ask';
export const AEM_QUERY_FORMAT_ASK_ALLOWLIST_ENTRY = 'custom:aem_query_format_ask';

/** The tools this one runs, in order; the manifest's `uses` list. */
export const AEM_QUERY_FORMAT_ASK_USES = ['aem_query', 'format_table', 'ask_user'] as const;

const MAX_SEARCH_PAGE_SIZE = 200;
const MAX_SEARCH_ROOTS = 8;
const LOAD_MORE = 'Load more';

export const aemQueryFormatAskArgsSchema = z
  .object({
    /** The full-text search string, sent as QueryBuilder's `fulltext` predicate. */
    terms: z.string().trim().min(1).optional(),
    /**
     * A hand-built QueryBuilder predicate map, instead of `terms`. Validated by
     * `aem_query` itself, exactly as if the model had passed it there.
     */
    predicates: z.record(z.string(), z.string()).optional(),
    /** Where to search. Omitted means the current host's content roots (or the `path` predicate). */
    roots: z.array(z.string().min(1)).min(1).max(MAX_SEARCH_ROOTS).optional(),
    /** Which result fields come back per hit, as `aem_query`'s `properties`. */
    properties: z.array(z.string().min(1)).optional(),
    /** Rows per page (per root, as with `aem_query`). */
    limit: z.number().int().min(1).max(MAX_SEARCH_PAGE_SIZE).default(SEARCH_PAGE_SIZE),
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
    'and loads the next page when it is clicked. Pass either `terms` (a plain full-text search ' +
    'string) or `predicates` (a hand-built QueryBuilder predicate map, exactly as for ' +
    "aem_query) - never both. `roots` defaults to the current host's content roots (none when " +
    '`predicates` has a `path`; never combine `roots` with a `path` predicate); `properties` ' +
    `optionally selects the fields per hit; \`limit\` (rows per page) defaults to ${String(SEARCH_PAGE_SIZE)}. ` +
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

/** A total as words, never a bare number: a lower bound stays a lower bound. */
export function describeSearchTotal(
  total: JsonValue | undefined,
  hasMore: JsonValue | undefined,
): string {
  return describeTotalValues(total, hasMore);
}

/** The table's total line for a proved exact count. */
function exactTotalLine(value: number): string {
  return `Total: ${String(value)} result${value === 1 ? '' : 's'}`;
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
export function createAemQueryFormatAskExecutor(host: ToolHost): AemToolExecutor {
  return async (rawArgs, context) => {
    const requestId = newRequestId(host.idGenerator);

    const parsed = aemQueryFormatAskArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Invalid aem_query_format_ask arguments';
      return err(createToolError('INVALID_ARGUMENT', message, requestId));
    }
    const { terms, limit } = parsed.data;
    const predicates = parsed.data.predicates ?? { fulltext: terms ?? '' };
    const scopedByPath = Object.prototype.hasOwnProperty.call(predicates, 'path');
    const roots =
      parsed.data.roots ??
      (scopedByPath
        ? undefined
        : (host.environmentFacts()?.contentRoots ?? [CONTENT_ROOT_DEFAULT]));
    const scope = roots === undefined ? predicates['path'] : roots.join(', ');
    const subject = terms === undefined ? describePredicates(predicates) : `"${terms}"`;

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
            limit,
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

        const shown = await showTable({
          data: { rows, pagination: pagination as unknown as JsonValue },
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

        const asked = await host.invokeTool('ask_user', { actions: [LOAD_MORE] }, context);
        if (!asked.ok) {
          if (asked.error.code === 'CANCELLED') {
            ended = 'stopped';
            break;
          }
          return asked;
        }
        const answer = askAnswerSchema.safeParse(asked.value);
        if (!answer.success || !answer.data.selections.includes(LOAD_MORE)) {
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
      ...(terms === undefined ? { predicates } : { terms }),
      ...(roots === undefined ? {} : { roots: [...roots] }),
      pageSize: limit,
      pages,
      rows: rowCount,
      total: effectiveTotal,
      hasMore,
      ended,
      textResultForLlm:
        `Searched for ${subject} in ${scope ?? 'the whole repository'}: ${String(rowCount)} row(s) over ` +
        `${String(pages)} page(s) are on screen in the chat's table (total matches: ` +
        `${totalText}). The search is finished because ${reason}. Do not repeat the results ` +
        'or call the search tools again for this search.',
      resultType: 'success',
    });
  };
}
