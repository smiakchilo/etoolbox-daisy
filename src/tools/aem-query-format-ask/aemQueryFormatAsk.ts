import { z } from 'zod';
import {
  type AemToolExecutor,
  type JsonValue,
  type RequestId,
  type Result,
  type ToolDescriptor,
  type ToolError,
  type ToolHost,
  CONTENT_ROOT_DEFAULT,
  SEARCH_PAGE_SIZE,
  createToolError,
  err,
  jsonValueSchema,
  newRequestId,
  ok,
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
 * hand-built search passes its QueryBuilder predicates instead of 	erms;
 * the loop is the same.
 *
 * It owns no AEM access of its own: every step is the real tool, run through
 * {@link ToolHost.invokeTool} (the tool-to-tool bridge), so each step shows in
 * the transcript and journal exactly as if the model had called it, and each
 * step keeps its own validation. The parts are declared in the manifest's
 * `uses` list.
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

/** A total as words, never a bare number: an estimate stays an estimate. */
export function describeSearchTotal(
  total: JsonValue | undefined,
  hasMore: JsonValue | undefined,
): string {
  if (!isRecord(total)) return 'unknown';
  const value = total['value'];
  if (total['accuracy'] === 'exact' && typeof value === 'number') return String(value);
  if (total['accuracy'] === 'estimated' && typeof value === 'number') {
    return hasMore === true ? `${String(value)}+` : `approximately ${String(value)}`;
  }
  return 'unknown';
}

function unexpected(message: string, requestId: RequestId): Result<JsonValue, ToolError> {
  return err(createToolError('UNEXPECTED_RESPONSE', message, requestId));
}

/**
 * Builds the executor: validate, resolve the roots, then loop query -> table ->
 * (button -> next page). A failed step's own error is returned as this call's
 * error; a cancelled or declined "Load more" ends the search normally.
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

    let offset = 0;
    let pages = 0;
    let rowCount = 0;
    let total: JsonValue;
    let hasMore: boolean | 'unknown';
    let ended: SearchEnd;

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

      const shown = await host.invokeTool(
        'format_table',
        {
          data: { rows, pagination: pagination as JsonValue },
          mode: pages === 0 ? 'new' : 'append',
        },
        context,
      );
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

    const totalText = describeSearchTotal(total, hasMore);
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
      total,
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
