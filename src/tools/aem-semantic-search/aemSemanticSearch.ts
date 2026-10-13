import { z } from 'zod';
import {
  type AemToolExecutor,
  type BrokerOutcome,
  type JsonValue,
  type RequestId,
  type Result,
  type ToolDescriptor,
  type ToolError,
  type ToolExecutionContext,
  type ToolHost,
  CONTENT_ROOT_DEFAULT,
  SEARCH_PAGE_SIZE,
  classifyAemResponse,
  computeDeadline,
  createToolError,
  describeTotalValues,
  err,
  jsonValueSchema,
  newRequestId,
  ok,
  parseJcrPath,
  parseOrigin,
} from '../../shared';

/**
 * The `aem_semantic_search` tool, self-contained: a **stateful composite**.
 *
 * It is the `/semantic-search` loop made deterministic, except for the one step
 * only the model can do - judging meaning. The application runs everything
 * else, in code, so a weak model cannot skip a hit, forget the table, or stop
 * before the user does:
 *
 * 1. **Call A** `{ terms, context }` queries one page (`aem_query`, `limit` hits
 *    at the current offset), reads the content of **every** hit (a small pool
 *    of direct QueryBuilder reads through the AEM pane) and returns the
 *    numbered candidates with excerpts, plus a `searchId`.
 * 2. **Call B** `{ searchId, matches }` takes the model's verdict on every
 *    candidate, appends the matches to the chat's table (`format_table`, whose
 *    total line counts the relevant matches - see {@link describeRelevantTotal}),
 *    and - unless AEM reported the results exhausted - offers "Load more"
 *    (`ask_user`). A click queries and reads the next page and returns its
 *    candidates, so the model judges again and calls back again; a cancel or
 *    exhaustion ends the search.
 *
 * The search state lives in this executor's closure, keyed by `searchId`.
 */

export const AEM_SEMANTIC_SEARCH_TOOL_NAME = 'aem_semantic_search';
export const AEM_SEMANTIC_SEARCH_ALLOWLIST_ENTRY = 'custom:aem_semantic_search';

/** The tools this one runs; the manifest's `uses` list. */
export const AEM_SEMANTIC_SEARCH_USES = ['aem_query', 'format_table', 'ask_user'] as const;

const MAX_SEMANTIC_PAGE_SIZE = 100;
const MAX_ROOTS = 8;
const LOAD_MORE = 'Load more';

/** Concurrent content reads per page; the broker serialises them, this keeps its queue fed. */
const READ_CONCURRENCY = 4;
/** Nodes a single hit's content read returns. */
const READ_NODE_LIMIT = 10;
const MAX_EXCERPTS = 3;
const EXCERPT_LENGTH = 200;
/** Searches remembered at once; the oldest is forgotten first. */
const MAX_LIVE_SEARCHES = 8;

const QUERYBUILDER_ENDPOINT_PATH = '/bin/querybuilder.json';

const matchSchema = z.union([
  z.number().int().min(1),
  z
    .object({ candidate: z.number().int().min(1), excerpt: z.number().int().min(1).optional() })
    .strict(),
]);

export const aemSemanticSearchArgsSchema = z
  .object({
    /** Call A: the full-text search string sent to AEM. */
    terms: z.string().trim().min(1).optional(),
    /** Call A: what a result must be about to count as relevant. */
    context: z.string().trim().min(1).optional(),
    /** Call A: where to search. Omitted means the current host's content roots. */
    roots: z.array(z.string().min(1)).min(1).max(MAX_ROOTS).optional(),
    /** Call A: hits per page. */
    limit: z.number().int().min(1).max(MAX_SEMANTIC_PAGE_SIZE).optional(),
    /** Call B: the id call A returned. */
    searchId: z.string().trim().min(1).optional(),
    /** Call B: the candidates that match the context (numbers, or `{ candidate, excerpt }`). */
    matches: z.array(matchSchema).optional(),
  })
  .strict();

export const AEM_SEMANTIC_SEARCH_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: AEM_SEMANTIC_SEARCH_TOOL_NAME,
  description:
    'Runs a semantic AEM search as a loop the application drives. Start it with ' +
    '`{ terms, context }`: `terms` is the full-text search string, `context` is what a result ' +
    'must be about to count. It returns a `searchId` and numbered candidates (every hit of the ' +
    'page, with excerpts of its content). Judge EVERY candidate against the context, then call ' +
    'this tool again with `{ searchId, matches }` - the numbers of the matching candidates ' +
    '(`[]` if none), optionally `{ candidate, excerpt }` to choose the excerpt cited. The ' +
    'application shows the table and the "Load more" button itself; when the user loads more you ' +
    'receive the next candidates and judge again. Stop only when the result says the search is ' +
    'finished; never write the results yourself.',
  parameters: z.toJSONSchema(aemSemanticSearchArgsSchema, { io: 'input' }),
};

export type SemanticSearchEnd = 'exhausted' | 'stopped';

/**
 * One readable piece of a candidate's content: the absolute path of the node
 * the property lives on, the property's own name, and its text. Kept as the
 * three facts rather than a single pre-joined label, because the chat's table
 * shows the node path (Path) and the property name (Property) as separate
 * columns, while the model's candidate list shows them joined relative to the
 * hit.
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
  readonly roots: readonly string[];
  readonly limit: number;
  offset: number;
  pages: number;
  candidatesRead: number;
  matchesShown: number;
  tableShown: boolean;
  candidates: readonly Candidate[];
  pagination: Pagination;
}

type SemanticSearchArgs = z.infer<typeof aemSemanticSearchArgsSchema>;
type Match = z.infer<typeof matchSchema>;

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
 * hits. "so far" stays while further pages may exist.
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

/** Read through a call so a second check after an wait is not narrowed away. */
function isAborted(context: ToolExecutionContext): boolean {
  return context.signal?.aborted === true;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/** Builds the executor; the search state lives in its closure. */
export function createAemSemanticSearchExecutor(host: ToolHost): AemToolExecutor {
  const searches = new Map<string, SearchState>();

  const remember = (searchId: string, state: SearchState): void => {
    searches.set(searchId, state);
    while (searches.size > MAX_LIVE_SEARCHES) {
      const oldest = searches.keys().next().value;
      if (oldest === undefined) break;
      searches.delete(oldest);
    }
  };

  const cancelled = (requestId: RequestId): Result<JsonValue, ToolError> =>
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

  /** Queries the page at `state.offset` and reads every hit; updates the state. */
  const loadPage = async (
    state: SearchState,
    context: ToolExecutionContext,
    requestId: RequestId,
  ): Promise<Result<JsonValue, ToolError> | undefined> => {
    const query = await host.invokeTool(
      'aem_query',
      {
        predicates: { fulltext: state.terms },
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
    // Reading every hit's content is the slow part of a semantic search and
    // the part with no transcript entry of its own, so report it: the running
    // billet shows "Reading n of m" while the reads proceed. A count, not a
    // percentage - the reads finish out of order, and this is the honest
    // progress ("n reads done").
    const reportProgress = (read: number): void => {
      host.reportToolProgress?.(
        context.toolCallId,
        `Reading ${String(read)} of ${String(paths.length)}`,
      );
    };
    reportProgress(0);
    let readsDone = 0;
    try {
      state.candidates = await mapPooled(paths, READ_CONCURRENCY, async (path) => {
        const candidate = await readCandidate(path, state.terms, context);
        readsDone += 1;
        reportProgress(readsDone);
        return candidate;
      });
    } catch (error) {
      if (error instanceof SearchCancelled) return cancelled(requestId);
      throw error;
    }
    state.pages += 1;
    state.candidatesRead += state.candidates.length;
    state.pagination = {
      hasMore: page.data.pagination.hasMore,
      total: page.data.pagination.total,
      raw: page.data.pagination as JsonValue,
    };
    return undefined;
  };

  const summary = (
    searchId: string,
    state: SearchState,
    requestId: RequestId,
    textResultForLlm: string,
    ended?: SemanticSearchEnd,
  ): JsonValue => ({
    operation: AEM_SEMANTIC_SEARCH_TOOL_NAME,
    requestId,
    terms: state.terms,
    context: state.context,
    roots: [...state.roots],
    pageSize: state.limit,
    page: state.pages,
    candidatesRead: state.candidatesRead,
    matchesShown: state.matchesShown,
    total: state.pagination.total,
    hasMore: state.pagination.hasMore,
    ...(ended === undefined ? { searchId, candidates: state.candidates.length } : { ended }),
    textResultForLlm,
    resultType: 'success',
  });

  const candidatesResult = (
    searchId: string,
    state: SearchState,
    requestId: RequestId,
  ): JsonValue => {
    const lines = state.candidates.map((candidate, index) => {
      const head = `[${String(index + 1)}] ${candidate.path}`;
      if (candidate.excerpts.length === 0) {
        const why = candidate.unreadable ? 'content could not be read' : 'no readable text';
        return `${head}\n    (${why})`;
      }
      const excerpts = candidate.excerpts.map(
        (excerpt, excerptIndex) =>
          `    (${String(excerptIndex + 1)}) ` +
          `${relativeLabel(candidate.path, excerpt.nodePath, excerpt.name)}: ` +
          `${JSON.stringify(excerpt.text)}`,
      );
      return [head, ...excerpts].join('\n');
    });
    const text =
      `Semantic search for "${state.terms}", page ${String(state.pages)}: ` +
      `${String(state.candidates.length)} candidate(s) to judge.\n` +
      `Context: ${JSON.stringify(state.context)}\n\n` +
      `${lines.join('\n')}\n\n` +
      'Judge EVERY candidate above against the context. Then call aem_semantic_search with ' +
      `{"searchId":${JSON.stringify(searchId)},"matches":[...]} listing the numbers of ALL ` +
      'matching candidates (use {"candidate":n,"excerpt":m} to choose the excerpt cited; pass [] ' +
      'if none match). Do not write any text and do not call any other tool before that call.';
    return summary(searchId, state, requestId, text);
  };

  /**
   * Shows the judged rows, then loops: "Load more" -> next page. Returns the
   * next candidates to judge, or the finished result.
   */
  const presentAndContinue = async (
    searchId: string,
    state: SearchState,
    rows: readonly JsonValue[],
    context: ToolExecutionContext,
    requestId: RequestId,
  ): Promise<Result<JsonValue, ToolError>> => {
    let pending = rows;
    let ended: SemanticSearchEnd;
    for (;;) {
      if (context.signal?.aborted === true) {
        searches.delete(searchId);
        return cancelled(requestId);
      }
      state.matchesShown += pending.length;
      const shown = await host.invokeTool(
        'format_table',
        {
          data: { rows: [...pending], pagination: state.pagination.raw },
          mode: state.tableShown ? 'append' : 'new',
          totalLine: describeRelevantTotal(state.matchesShown, state.pagination.hasMore === false),
        },
        context,
      );
      if (!shown.ok) {
        searches.delete(searchId);
        return shown;
      }
      state.tableShown = true;
      state.candidates = [];
      if (state.pagination.hasMore === false) {
        ended = 'exhausted';
        break;
      }
      const asked = await host.invokeTool('ask_user', { actions: [LOAD_MORE] }, context);
      if (!asked.ok && asked.error.code !== 'CANCELLED') {
        searches.delete(searchId);
        return asked;
      }
      const answer = asked.ok ? askAnswerSchema.safeParse(asked.value) : undefined;
      if (answer?.success !== true || !answer.data.selections.includes(LOAD_MORE)) {
        ended = 'stopped';
        break;
      }
      state.offset += state.limit;
      const failed = await loadPage(state, context, requestId);
      if (failed !== undefined) {
        searches.delete(searchId);
        return failed;
      }
      if (state.candidates.length > 0) return ok(candidatesResult(searchId, state, requestId));
      pending = [];
    }
    searches.delete(searchId);
    const reason =
      ended === 'exhausted'
        ? 'no further results exist'
        : 'the user did not load more (further results may exist)';
    return ok(
      summary(
        searchId,
        state,
        requestId,
        `The semantic search for "${state.terms}" is finished because ${reason}: ` +
          `${String(state.matchesShown)} relevant result(s) of ${String(state.candidatesRead)} ` +
          "read are on screen in the chat's table. End your turn now without writing any text.",
        ended,
      ),
    );
  };

  const start = async (
    args: SemanticSearchArgs,
    terms: string,
    semanticContext: string,
    context: ToolExecutionContext,
    requestId: RequestId,
  ): Promise<Result<JsonValue, ToolError>> => {
    const searchId = host.idGenerator();
    const state: SearchState = {
      terms,
      context: semanticContext,
      roots: [...(args.roots ?? host.environmentFacts()?.contentRoots ?? [CONTENT_ROOT_DEFAULT])],
      limit: args.limit ?? SEARCH_PAGE_SIZE,
      offset: 0,
      pages: 0,
      candidatesRead: 0,
      matchesShown: 0,
      tableShown: false,
      candidates: [],
      pagination: { hasMore: 'unknown', total: null, raw: null },
    };
    const failed = await loadPage(state, context, requestId);
    if (failed !== undefined) return failed;
    remember(searchId, state);
    if (state.candidates.length === 0) {
      return presentAndContinue(searchId, state, [], context, requestId);
    }
    return ok(candidatesResult(searchId, state, requestId));
  };

  const judge = async (
    searchId: string,
    matches: readonly Match[],
    context: ToolExecutionContext,
    requestId: RequestId,
  ): Promise<Result<JsonValue, ToolError>> => {
    const state = searches.get(searchId);
    if (state === undefined) {
      return err(
        createToolError(
          'INVALID_ARGUMENT',
          `Unknown searchId "${searchId}": that search is finished or was never started`,
          requestId,
        ),
      );
    }
    if (state.candidates.length === 0) {
      return err(
        createToolError(
          'INVALID_ARGUMENT',
          'There are no candidates waiting to be judged for this search',
          requestId,
        ),
      );
    }
    const rows: JsonValue[] = [];
    const picked = new Set<number>();
    for (const match of matches) {
      const number = typeof match === 'number' ? match : match.candidate;
      const candidate = state.candidates[number - 1];
      if (candidate === undefined) {
        const count = String(state.candidates.length);
        return err(
          createToolError(
            'INVALID_ARGUMENT',
            `Candidate ${String(number)} does not exist; this page has ${count} candidate(s)`,
            requestId,
          ),
        );
      }
      if (picked.has(number)) continue;
      picked.add(number);
      const excerptNumber = typeof match === 'number' ? 1 : (match.excerpt ?? 1);
      const excerpt = candidate.excerpts[excerptNumber - 1] ?? candidate.excerpts[0];
      // The Path column is the concrete node the property lives on, not the
      // hit that was queried; Property is that property's own name. A candidate
      // whose content could not be read falls back to the hit path and no
      // property.
      rows.push({
        'jcr:path': excerpt?.nodePath ?? candidate.path,
        property: excerpt?.name ?? '',
        citation: excerpt?.text ?? '',
      });
    }
    return presentAndContinue(searchId, state, rows, context, requestId);
  };

  return async (rawArgs, context) => {
    const requestId = newRequestId(host.idGenerator);
    const parsed = aemSemanticSearchArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Invalid aem_semantic_search arguments';
      return err(createToolError('INVALID_ARGUMENT', message, requestId));
    }
    const args = parsed.data;
    if (context.signal?.aborted === true) return cancelled(requestId);
    if (args.searchId !== undefined) {
      if (args.matches === undefined) {
        return err(
          createToolError('INVALID_ARGUMENT', 'Pass `matches` together with `searchId`', requestId),
        );
      }
      return judge(args.searchId, args.matches, context, requestId);
    }
    if (args.terms === undefined || args.context === undefined) {
      return err(
        createToolError(
          'INVALID_ARGUMENT',
          'Pass `terms` and `context` to start a search, or `searchId` and `matches` to continue one',
          requestId,
        ),
      );
    }
    return start(args, args.terms, args.context, context, requestId);
  };
}
