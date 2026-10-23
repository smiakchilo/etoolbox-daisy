import { z } from 'zod';
import {
  type BrokerOutcome,
  type JsonValue,
  type AnswerItem,
  type AnswerResult,
  type PageFillPage,
  type PageFillQueue,
  type RequestId,
  type Result,
  type SearchFilter,
  type ToolDescriptor,
  type ToolError,
  type ToolExecutionContext,
  type ToolExecutor,
  type ToolHost,
  ANSWER_MAX_ATTEMPTS,
  DEFAULT_REQUEST_CONCURRENCY,
  MAX_QUERY_LIMIT,
  MAX_SEARCH_ROOTS,
  MIN_QUERY_LIMIT,
  TURN_COMPLETE_RESULT_KEY,
  applySearchFilters,
  classifyAemResponse,
  computeDeadline,
  createPageFillQueue,
  createToolError,
  describeTotalValues,
  err,
  jsonValueSchema,
  newRequestId,
  ok,
  parseJcrPath,
  parseOrigin,
  resolveSearchPageSize,
  resolveSearchRoots,
  resolveSearchScope,
  runPageFill,
  searchFiltersSchema,
  searchRootsSchema,
} from '../../shared';

/**
 * The `aem_semantic_search` tool, self-contained. The **tool owns the whole
 * search**; the model is involved only for what only a model can do - answering
 * whether a candidate's text carries the requested meaning.
 *
 * One call runs the complete loop:
 *
 * 1. **Query** one page of hits (`aem_query`, `limit` hits at the current
 *    offset). Pure code, no model.
 * 2. **Read** every hit's content in parallel (a small pool of direct
 *    QueryBuilder reads through the AEM pane). Pure code, no model.
 * 3. **Answer** that page with **one** model call through `ToolHost.answer` - a
 *    stateless, tools-disabled call on the active agent - and turn the verdicts
 *    into table rows. The only non-deterministic step.
 * 4. **Fill** the reusable {@link PageFillQueue}: while it holds fewer than
 *    `limit` answered matches and AEM may have more, query/read/answer another page.
 *    Once it holds a page (or AEM is exhausted), paint it with `format_table`
 *    and, while anything remains, ask "Load more" (`ask_user`). A surplus stays
 *    buffered for the next click; nothing is re-queried or re-answered.
 *
 * The model never receives candidate lists, never calls back with verdicts and
 * therefore cannot stop the search halfway: a tool call cannot end until the
 * search is exhausted, the user declines, or an answer/read fails. A failed
 * answer call is retried ({@link ANSWER_MAX_ATTEMPTS} attempts in total).
 */

export const AEM_SEMANTIC_SEARCH_TOOL_NAME = 'aem_semantic_search';
export const AEM_SEMANTIC_SEARCH_ALLOWLIST_ENTRY = 'custom:aem_semantic_search';

/** The tools this one runs; the manifest's `uses` list. */
export const AEM_SEMANTIC_SEARCH_USES = ['aem_query', 'format_table', 'ask_user'] as const;

const LOAD_MORE = 'Load more';

/** Nodes a single hit's content read returns. */
const READ_NODE_LIMIT = 10;
const MAX_EXCERPTS = 3;
const EXCERPT_LENGTH = 200;

const QUERYBUILDER_ENDPOINT_PATH = '/bin/querybuilder.json';

export const aemSemanticSearchArgsSchema = z
  .object({
    /** The full-text search string sent to AEM. */
    terms: z.string().trim().min(1),
    /** What a result must be about to count as relevant. */
    context: z.string().trim().min(1),
    /**
     * Where to search - full paths as the user wrote them, or path fragments
     * the application resolves (`resolveSearchScope`). Omitted falls back to the
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
    /** Hits per page. */
    limit: z
      .number()
      .int()
      .min(MIN_QUERY_LIMIT)
      .max(MAX_QUERY_LIMIT)
      .describe('Rows per page. Omit it unless the user asked for a page size.')
      .optional(),
    /**
     * Keep only results whose page carries a given property value (a template,
     * a replication state, a modification date, ...).
     */
    filters: searchFiltersSchema.optional(),
  })
  .strict();

export const AEM_SEMANTIC_SEARCH_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: AEM_SEMANTIC_SEARCH_TOOL_NAME,
  description:
    'Runs a complete semantic AEM search in one call. `terms` is the full-text search string and ' +
    '`context` is what a result must be about to count; optional `filters` keep only results ' +
    'whose page carries a given property value (a template, a replication state, a modification ' +
    "date), named relative to the page's content node. The application queries the hits, reads " +
    'every hit, and asks the active model whether each hit matches the meaning - you never see ' +
    "the candidates or decide which match. It shows the relevant matches as the chat's table " +
    "itself and offers the user 'Load more' while results remain, loading further pages on a " +
    'click. When it returns, the search is finished: do not call it again, do not call aem_query ' +
    'or ask_user for the same search, and do not write out the results.',
  parameters: z.toJSONSchema(aemSemanticSearchArgsSchema, { io: 'input' }),
};

export type SemanticSearchEnd = 'exhausted' | 'stopped';

/**
 * One readable piece of a candidate's content: the absolute path of the node
 * the property lives on, the property's own name, and its text. Kept as the
 * three facts rather than a single pre-joined label, because the chat's table
 * shows the node path (Path) and the property name (Property) as separate
 * columns.
 */
export interface Excerpt {
  readonly nodePath: string;
  readonly name: string;
  readonly text: string;
}

interface Candidate {
  readonly path: string;
  readonly excerpts: readonly Excerpt[];
  readonly unreadable: boolean;
}

interface Pagination {
  readonly hasMore: boolean | 'unknown';
  readonly total: JsonValue;
  readonly raw: JsonValue;
}

interface SearchState {
  readonly terms: string;
  readonly context: string;
  readonly filters: readonly SearchFilter[] | undefined;
  /** The query's predicates: the terms, plus the page-property filters when any apply. */
  readonly predicates: Readonly<Record<string, string>>;
  readonly roots: readonly string[];
  readonly limit: number;
  /** The offset of the next query page. */
  offset: number;
  pages: number;
  candidatesRead: number;
  matchesShown: number;
  tableShown: boolean;
  /** Matches the model answered, waiting for a display page (the reusable fill routine). */
  readonly fill: PageFillQueue<JsonValue>;
  pagination: Pagination;
  /** Why probing stopped when it was not simply "AEM had no more". */
  endReason?: string;
}

const queryPageSchema = z.looseObject({
  rows: z.array(jsonValueSchema),
  pagination: z.looseObject({
    hasMore: z.union([z.boolean(), z.literal('unknown')]),
    total: jsonValueSchema,
  }),
});

const askAnswerSchema = z.looseObject({ selections: z.array(z.string()) });

function isRecord(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A total as words, never a bare number: a lower bound stays a lower bound. */
export function describeSemanticTotal(
  total: JsonValue | undefined,
  hasMore: JsonValue | undefined,
): string {
  return describeTotalValues(total, hasMore);
}

/**
 * The table's total line: it counts the **relevant** matches shown, not AEM's
 * hits. "so far" stays while anything may still be shown.
 */
export function describeRelevantTotal(matches: number, exhausted: boolean): string {
  const soFar = exhausted ? '' : ' so far';
  if (matches === 0) return `Did not find any relevant results${soFar}`;
  return `Total: ${String(matches)}${soFar}`;
}

// ---------------------------------------------------------------------------
// Content reads
// ---------------------------------------------------------------------------

const SKIPPED_NAMESPACES = ['jcr:', 'cq:', 'sling:', 'rep:', 'mix:', 'nt:', 'dam:'];
const KEPT_NAMESPACED = new Set(['jcr:title', 'jcr:description']);

function isTextProperty(name: string): boolean {
  if (KEPT_NAMESPACED.has(name)) return true;
  return !SKIPPED_NAMESPACES.some((prefix) => name.startsWith(prefix));
}

function plainText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function termWords(terms: string): readonly string[] {
  return terms
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^["'+-]+|["']+$/g, ''))
    .filter((word) => word.length > 0);
}

/** Cuts `text` to the excerpt length, around the first term occurrence when there is one. */
function windowAround(text: string, words: readonly string[]): string {
  if (text.length <= EXCERPT_LENGTH) return text;
  const lower = text.toLowerCase();
  const hit = words.map((word) => lower.indexOf(word)).find((index) => index >= 0) ?? 0;
  const start = Math.max(0, Math.min(hit - EXCERPT_LENGTH / 4, text.length - EXCERPT_LENGTH));
  const slice = text.slice(start, start + EXCERPT_LENGTH).trim();
  return `${start > 0 ? '...' : ''}${slice}${start + EXCERPT_LENGTH < text.length ? '...' : ''}`;
}

function relativeLabel(hitPath: string, nodePath: string, name: string): string {
  if (nodePath === hitPath) return name;
  if (nodePath.startsWith(`${hitPath}/`)) return `${nodePath.slice(hitPath.length + 1)}/${name}`;
  return `${nodePath}/${name}`;
}

/**
 * Picks up to {@link MAX_EXCERPTS} readable texts from the nodes one content
 * read returned: text properties only (no system namespaces, no path values),
 * stripped of markup, the ones that contain a search term first.
 */
export function extractExcerpts(
  hitPath: string,
  nodes: readonly JsonValue[],
  terms: string,
): readonly Excerpt[] {
  const words = termWords(terms);
  const found: { readonly excerpt: Excerpt; readonly hasTerm: boolean; readonly order: number }[] =
    [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const nodePath = typeof node['jcr:path'] === 'string' ? node['jcr:path'] : hitPath;
    for (const [name, value] of Object.entries(node)) {
      if (!isTextProperty(name)) continue;
      const texts = (Array.isArray(value) ? value : [value])
        .filter((item): item is string => typeof item === 'string')
        .filter((item) => !item.startsWith('/'));
      if (texts.length === 0) continue;
      const text = plainText(texts.join(', '));
      if (text.length === 0 || seen.has(text)) continue;
      seen.add(text);
      found.push({
        excerpt: { nodePath, name, text: windowAround(text, words) },
        hasTerm: words.some((word) => text.toLowerCase().includes(word)),
        order: found.length,
      });
    }
  }
  return found
    .sort((a, b) => Number(b.hasTerm) - Number(a.hasTerm) || a.order - b.order)
    .slice(0, MAX_EXCERPTS)
    .map((entry) => entry.excerpt);
}

/**
 * The QueryBuilder URL that returns a hit and its descendants (each with its
 * own properties), optionally only those matching `terms`; `undefined` when
 * the origin or the path is not usable.
 */
export function buildContentReadUrl(
  origin: string,
  hitPath: string,
  terms: string | undefined,
): string | undefined {
  const parsedOrigin = parseOrigin(origin);
  if (!parsedOrigin.ok || !parseJcrPath(hitPath).ok) return undefined;
  const params = new URLSearchParams();
  params.append('path', hitPath);
  params.append('path.self', 'true');
  if (terms !== undefined) params.append('fulltext', terms);
  // `p.nodedepth` is deliberately absent: with `p.hits=full`, `0` would return
  // each node's whole subtree; omitted, each node carries only its own properties.
  params.append('p.hits', 'full');
  params.append('p.limit', String(READ_NODE_LIMIT));
  params.append('p.guessTotal', 'true');
  const url = new URL(`${parsedOrigin.origin}${QUERYBUILDER_ENDPOINT_PATH}?${params.toString()}`);
  if (url.origin !== parsedOrigin.origin || url.pathname !== QUERYBUILDER_ENDPOINT_PATH) {
    return undefined;
  }
  return url.toString();
}

/** Runs `worker` over `items` with at most `limit` in flight, keeping the input order. */
async function mapPooled<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

class SearchCancelled extends Error {}

/** Read through a call so a second check after an await is not narrowed away. */
function isAborted(context: ToolExecutionContext): boolean {
  return context.signal?.aborted === true;
}

/** The text the model sees for one candidate: its path and every excerpt. */
function describeCandidateForAnswer(candidate: Candidate): string {
  if (candidate.excerpts.length === 0) {
    const why = candidate.unreadable ? 'content could not be read' : 'no readable text';
    return `${candidate.path}\n    (${why})`;
  }
  const excerpts = candidate.excerpts.map(
    (excerpt, index) =>
      `    (${String(index + 1)}) ` +
      `${relativeLabel(candidate.path, excerpt.nodePath, excerpt.name)}: ` +
      `${JSON.stringify(excerpt.text)}`,
  );
  return [candidate.path, ...excerpts].join('\n');
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/** Builds the executor. No state survives the call: the whole search runs inside it. */
export function createAemSemanticSearchExecutor(host: ToolHost): ToolExecutor {
  const cancelled = <T>(requestId: RequestId): Result<T, ToolError> =>
    err(createToolError('CANCELLED', 'The search was cancelled', requestId));

  /** One content read; `undefined` when it could not be read (a cancel throws). */
  const fetchNodes = async (
    hitPath: string,
    terms: string | undefined,
  ): Promise<readonly JsonValue[] | undefined> => {
    let current;
    try {
      current = host.currentContext();
    } catch {
      return undefined;
    }
    const url = buildContentReadUrl(current.origin, hitPath, terms);
    if (url === undefined) return undefined;
    const requestId = newRequestId(host.idGenerator);
    const outcome: BrokerOutcome = await host.bridge.request(
      {
        operation: AEM_SEMANTIC_SEARCH_TOOL_NAME,
        requestId,
        chatId: current.chatId,
        turnId: current.turnId,
        serverId: current.serverId,
        serverRevision: current.serverRevision,
        navigationEpoch: current.navigationEpoch,
        deadlineMs: computeDeadline(host.clock),
        args: { path: hitPath },
      },
      url,
    );
    if (outcome.kind === 'cancelled') throw new SearchCancelled();
    if (outcome.kind !== 'response') return undefined;
    const classified = classifyAemResponse({
      status: outcome.status,
      contentType: outcome.contentType,
      bodyText: outcome.bodyText,
    });
    host.recordResponseClassification?.(requestId, classified.kind);
    if (classified.kind !== 'ok') return undefined;
    const hits = classified.value['hits'];
    return Array.isArray(hits) ? hits : undefined;
  };

  /** Reads one hit: the nodes matching the terms first, its own nodes when none do. */
  const readCandidate = async (
    hitPath: string,
    terms: string,
    context: ToolExecutionContext,
  ): Promise<Candidate> => {
    if (isAborted(context)) throw new SearchCancelled();
    let nodes = await fetchNodes(hitPath, terms);
    let excerpts = nodes === undefined ? [] : extractExcerpts(hitPath, nodes, terms);
    if (excerpts.length === 0) {
      if (isAborted(context)) throw new SearchCancelled();
      nodes = (await fetchNodes(hitPath, undefined)) ?? nodes;
      if (nodes !== undefined) excerpts = extractExcerpts(hitPath, nodes, terms);
    }
    return { path: hitPath, excerpts, unreadable: nodes === undefined };
  };

  /** Queries the next page and returns its hit paths; updates the counters + pagination. */
  const queryPage = async (
    state: SearchState,
    context: ToolExecutionContext,
    requestId: RequestId,
  ): Promise<Result<readonly string[], ToolError>> => {
    const query = await host.invokeTool(
      'aem_query',
      {
        predicates: { ...state.predicates },
        roots: [...state.roots],
        properties: [],
        limit: state.limit,
        offset: state.offset,
      },
      context,
    );
    if (!query.ok) return query;
    const page = queryPageSchema.safeParse(query.value);
    if (!page.success) {
      return err(
        createToolError(
          'UNEXPECTED_RESPONSE',
          'aem_query returned an unexpected result',
          requestId,
        ),
      );
    }
    const paths = page.data.rows
      .map((row) => (isRecord(row) ? row['jcr:path'] : undefined))
      .filter((path): path is string => typeof path === 'string');
    state.pages += 1;
    state.offset += state.limit;
    state.pagination = {
      hasMore: page.data.pagination.hasMore,
      total: page.data.pagination.total,
      raw: page.data.pagination as JsonValue,
    };
    if (state.pagination.hasMore === false) state.fill.exhaust();
    return ok(paths);
  };

  /** One uniform progress fragment: `n/limit collected`, never n > limit. */
  const selectionLabel = (state: SearchState, count: number): string => {
    const collected = Math.min(Math.max(count, 0), state.limit);
    return `${String(collected)}/${String(state.limit)} collected`;
  };

  /** Reads every hit in parallel and answers them with one model call per page. */
  const processPage = async (
    paths: readonly string[],
    state: SearchState,
    context: ToolExecutionContext,
    requestId: RequestId,
  ): Promise<Result<readonly JsonValue[], ToolError>> => {
    // Reading every hit's content is the slow part with no transcript entry of
    // its own, so report it: which source page is being probed and how far the
    // next display page already is.
    const reportProgress = (read: number): void => {
      const activity =
        paths.length === 0
          ? 'No hits on this page'
          : `Reading ${String(read)}/${String(paths.length)}`;
      host.reportToolProgress?.(
        context.toolCallId,
        `${activity} · Page ${String(state.pages)} · ${selectionLabel(state, state.fill.buffered.length)}`,
      );
    };
    reportProgress(0);
    let readsDone = 0;
    let candidates: Candidate[];
    try {
      candidates = await mapPooled(paths, DEFAULT_REQUEST_CONCURRENCY, async (path) => {
        const candidate = await readCandidate(path, state.terms, context);
        readsDone += 1;
        reportProgress(readsDone);
        return candidate;
      });
    } catch (error) {
      if (error instanceof SearchCancelled) return cancelled(requestId);
      throw error;
    }
    state.candidatesRead += candidates.length;

    const items: AnswerItem[] = candidates.map((candidate, index) => ({
      id: String(index + 1),
      text: describeCandidateForAnswer(candidate),
    }));
    const answer = host.answer;
    if (answer === undefined) {
      return err(
        createToolError(
          'AGENT_UNAVAILABLE',
          'The active agent cannot answer search candidates',
          requestId,
        ),
      );
    }
    // One model call answers the whole page. A failure or an unusable answer is
    // retried; it never silently becomes "nothing matched".
    for (let attempt = 1; attempt <= ANSWER_MAX_ATTEMPTS; attempt += 1) {
      if (isAborted(context)) return cancelled(requestId);
      host.reportToolProgress?.(
        context.toolCallId,
        `Testing ${String(items.length)} candidate(s) · Page ${String(state.pages)} · ` +
          selectionLabel(state, state.fill.buffered.length),
      );
      let answered: AnswerResult;
      try {
        answered = await answer({ instruction: state.context, items }, context.signal);
      } catch {
        answered = err({ message: 'The agent could not answer the candidates' });
      }
      if (answered.ok) return ok(toRows(candidates, answered.value));
      if (answered.error.cancelled === true) return cancelled(requestId);
    }
    return err(
      createToolError(
        'UNEXPECTED_RESPONSE',
        `The agent could not answer the candidates after ${String(ANSWER_MAX_ATTEMPTS)} attempts`,
        requestId,
      ),
    );
  };

  /** Turns verdicts into table rows: the first excerpt supplies Path/Property/Citation. */
  function toRows(
    candidates: readonly Candidate[],
    verdicts: readonly { readonly id: string; readonly match: boolean }[],
  ): readonly JsonValue[] {
    const matched = new Set(
      verdicts.filter((verdict) => verdict.match).map((verdict) => verdict.id),
    );
    const rows: JsonValue[] = [];
    candidates.forEach((candidate, index) => {
      if (!matched.has(String(index + 1))) return;
      const excerpt = candidate.excerpts[0];
      rows.push({
        'jcr:path': excerpt?.nodePath ?? candidate.path,
        property: excerpt?.name ?? '',
        citation: excerpt?.text ?? '',
      });
    });
    return rows;
  }

  const summary = (
    state: SearchState,
    requestId: RequestId,
    ended: SemanticSearchEnd,
    reason: string,
  ): JsonValue => ({
    operation: AEM_SEMANTIC_SEARCH_TOOL_NAME,
    requestId,
    terms: state.terms,
    context: state.context,
    // The typed filter objects are plain JSON; the cast only satisfies the
    // index-signature shape a JsonValue has.
    ...(state.filters === undefined ? {} : { filters: state.filters as unknown as JsonValue }),
    roots: [...state.roots],
    pageSize: state.limit,
    page: state.pages,
    candidatesRead: state.candidatesRead,
    matchesShown: state.matchesShown,
    total: state.pagination.total,
    hasMore: state.pagination.hasMore,
    ended,
    // This call is the whole search: the table is on screen and the run is
    // over, so the model's turn ends here rather than being resumed for a
    // "search is finished" completion (see `TURN_COMPLETE_RESULT_KEY`).
    [TURN_COMPLETE_RESULT_KEY]: true,
    textResultForLlm:
      `The semantic search for "${state.terms}" is finished because ${reason}: ` +
      `${String(state.matchesShown)} relevant result(s) of ${String(state.candidatesRead)} ` +
      "read are on screen in the chat's table. End your turn now without writing any text.",
    resultType: 'success',
  });

  const start = async (
    args: z.infer<typeof aemSemanticSearchArgsSchema>,
    context: ToolExecutionContext,
    requestId: RequestId,
  ): Promise<Result<JsonValue, ToolError>> => {
    const filtered = applySearchFilters({ fulltext: args.terms }, args.filters);
    if (!filtered.ok) {
      return err(createToolError('INVALID_ARGUMENT', filtered.message, requestId));
    }
    // A fragment (`us/en`) becomes a full path before anything is searched - by
    // configuration, a lookup or a question to the user, never a guess.
    let explicitRoots = args.roots;
    if (explicitRoots !== undefined) {
      const resolvedScope = await resolveSearchScope({
        host,
        context,
        requestId,
        roots: explicitRoots,
      });
      if (!resolvedScope.ok) return resolvedScope;
      explicitRoots = resolvedScope.value;
    }
    const limit = resolveSearchPageSize(args.limit);
    const state: SearchState = {
      terms: args.terms,
      context: args.context,
      filters: args.filters,
      predicates: filtered.predicates,
      roots: [
        ...(explicitRoots ??
          resolveSearchRoots(host.environmentFacts()).slice(0, MAX_SEARCH_ROOTS)),
      ],
      limit,
      offset: 0,
      pages: 0,
      candidatesRead: 0,
      matchesShown: 0,
      tableShown: false,
      fill: createPageFillQueue<JsonValue>(limit),
      pagination: { hasMore: 'unknown', total: null, raw: null },
    };

    const fetchPage = async (): Promise<Result<PageFillPage<string>, ToolError>> => {
      const paths = await queryPage(state, context, requestId);
      if (!paths.ok) return paths;
      return ok({ items: paths.value, hasMore: state.pagination.hasMore });
    };
    const onEmptyPage = (page: PageFillPage<string>): void => {
      if (page.hasMore !== false) {
        state.endReason =
          'a page returned no hits while AEM reported more, so the search cannot continue';
      }
    };

    let ended: SemanticSearchEnd;
    for (;;) {
      if (isAborted(context)) return cancelled(requestId);
      const filled = await runPageFill({
        queue: state.fill,
        fetchPage,
        processPage: (paths) => processPage(paths, state, context, requestId),
        isCancelled: () => isAborted(context),
        onEmptyPage,
      });
      if (!filled.ok) return filled;
      if (filled.value === 'cancelled') return cancelled(requestId);

      const page = state.fill.takePage();
      state.matchesShown += page.length;
      // What is happening now, then the page, then the next page's collection -
      // one shape for every progress line. After the page is taken, the count is
      // the true remainder, so it can never read "23/20".
      host.reportToolProgress?.(
        context.toolCallId,
        `Showing ${String(page.length)} · Page ${String(state.pages)} · ` +
          selectionLabel(state, state.fill.buffered.length),
      );
      const shown = await host.invokeTool(
        'format_table',
        {
          data: { rows: [...page], pagination: state.pagination.raw },
          mode: state.tableShown ? 'append' : 'new',
          totalLine: describeRelevantTotal(state.matchesShown, !state.fill.hasMore),
        },
        context,
      );
      if (!shown.ok) return shown;
      state.tableShown = true;
      if (!state.fill.hasMore) {
        ended = 'exhausted';
        break;
      }
      const asked = await host.invokeTool('ask_user', { actions: [LOAD_MORE] }, context);
      if (!asked.ok && asked.error.code !== 'CANCELLED') return asked;
      const selection = asked.ok ? askAnswerSchema.safeParse(asked.value) : undefined;
      if (selection?.success !== true || !selection.data.selections.includes(LOAD_MORE)) {
        ended = 'stopped';
        break;
      }
    }
    const reason =
      ended === 'exhausted'
        ? (state.endReason ?? 'no further results exist')
        : 'the user did not load more (further results may exist)';
    return ok(summary(state, requestId, ended, reason));
  };

  return async (rawArgs, context) => {
    const requestId = newRequestId(host.idGenerator);
    const parsed = aemSemanticSearchArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Invalid aem_semantic_search arguments';
      return err(createToolError('INVALID_ARGUMENT', message, requestId));
    }
    if (isAborted(context)) return cancelled(requestId);
    return start(parsed.data, context, requestId);
  };
}
