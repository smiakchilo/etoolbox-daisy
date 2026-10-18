import { type AgentChatHistoryListResult, type AgentChatListConversationsRequest } from '../shared';
import { readChatHistoryPage, type ChatHistoryPage, snapshotChatHistoryIds } from './chatHistory';

/**
 * The `agent-chat:list-conversations` handler's body: the stateful scan behind
 * the History panel's small-batch loading. A first request snapshots the chats
 * directory's observable chat ids once (cheap - file names and mtimes only)
 * and serves the page's journals; a continuation request carrying the previous
 * result's opaque `next` cursor reads the following page from the *same*
 * snapshot, so paging stays consistent (and cheap: no journal is read twice).
 *
 * The pager is deliberately exchangeable with a stateless re-scan only at the
 * edges: when `next` is unknown or expired it starts a fresh scan, treating
 * the caller's lost cursor as "start over" rather than an error - the renderer
 * only ever passes back what it received, and its panel restarts a fresh scan
 * on every reload. Scans expire after {@link CHAT_CURSOR_TTL_MS} (the panel
 * re-anchors a fresh one on every open), so a slow-disk scan can never leak
 * state.
 */

/** Journals read per `agent-chat:list-conversations` call - deliberately small. */
export const HISTORY_PAGE_SIZE = 25;

/** Keeps an idle scan's cursor live; callers get a fresh scan afterwards. */
export const CHAT_CURSOR_TTL_MS = 5 * 60_000;

interface ActiveScan {
  readonly ids: readonly string[];
  offset: number;
  expiresAt: number;
}

export interface ChatHistoryPagerOptions {
  readonly chatsDir: string;
  /** Journals per page; defaults to {@link HISTORY_PAGE_SIZE}. */
  readonly pageSize?: number;
  /** Cursor lifetime; defaults to {@link CHAT_CURSOR_TTL_MS}. */
  readonly cursorTtlMs?: number;
  /** Injectable clock, so tests can expire cursors deterministically. */
  readonly now?: () => number;
  /** Injectable cursor mint; defaults to `crypto.randomUUID()`. */
  readonly nextToken?: () => string;
  /** Injectable snapshot; defaults to `snapshotChatHistoryIds`. */
  readonly snapshotIds?: (chatsDir: string) => readonly string[];
  /** Injectable page reader; defaults to `readChatHistoryPage`. */
  readonly readPage?: (
    chatsDir: string,
    ids: readonly string[],
    offset: number,
    limit: number,
  ) => ChatHistoryPage;
}

/**
 * Builds the request -> result handler. It never throws: a failing directory
 * or journal read comes back as an `ok: false` result, which the renderer
 * shows as "History is unavailable" (or, mid-scan, a note after the rows it
 * already painted).
 */
export function createChatHistoryPager(
  options: ChatHistoryPagerOptions,
): (request: AgentChatListConversationsRequest) => AgentChatHistoryListResult {
  const chatsDir = options.chatsDir;
  const pageSize = options.pageSize ?? HISTORY_PAGE_SIZE;
  const cursorTtlMs = options.cursorTtlMs ?? CHAT_CURSOR_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const nextToken = options.nextToken ?? (() => globalThis.crypto.randomUUID());
  const snapshotIds = options.snapshotIds ?? ((dir: string) => snapshotChatHistoryIds(dir));
  const readPage =
    options.readPage ??
    ((dir: string, ids: readonly string[], offset: number, limit: number) =>
      readChatHistoryPage(dir, ids, offset, limit));

  const scans = new Map<string, ActiveScan>();

  return (request: AgentChatListConversationsRequest): AgentChatHistoryListResult => {
    try {
      return handle(request);
    } catch {
      return storageFailureResult();
    }
  };

  function handle(request: AgentChatListConversationsRequest): AgentChatHistoryListResult {
    const at = now();

    // One sweep per call: the panel is the only caller and paginates within
    // seconds, so on its rhythm every expired-but-never-resumed scan is dead
    // shortly after its own caller moved on - nothing can accumulate.
    for (const [token, scan] of scans) {
      if (scan.expiresAt < at) scans.delete(token);
    }

    const held = serveHeld(request.next, at);
    if (held !== undefined) return held;
    // A first request (no cursor), or an unknown/expired one: the caller asked
    // to continue a thing we no longer know, and a fresh scan is the honest,
    // still-correct answer.
    return serveFresh(at);
  }

  function serveHeld(
    cursor: string | undefined,
    at: number,
  ): AgentChatHistoryListResult | undefined {
    if (cursor === undefined) return undefined;
    const scan = scans.get(cursor);
    if (scan === undefined) return undefined;
    return serve(cursor, scan, at);
  }

  function serveFresh(at: number): AgentChatHistoryListResult {
    const token = nextToken();
    const scan: ActiveScan = {
      ids: snapshotIds(chatsDir),
      offset: 0,
      expiresAt: at + cursorTtlMs,
    };
    scans.set(token, scan);
    return serve(token, scan, at);
  }

  function serve(token: string, scan: ActiveScan, at: number): AgentChatHistoryListResult {
    const page = readPage(chatsDir, scan.ids, scan.offset, pageSize);
    scan.offset += pageSize;
    const more = page.hasMore && scan.offset < scan.ids.length;
    if (more) {
      scan.expiresAt = at + cursorTtlMs;
      return { ok: true, entries: [...page.entries], next: token };
    }
    // Exhausted: the snapshot has served its purpose; drop it.
    scans.delete(token);
    return { ok: true, entries: [...page.entries] };
  }
}

/** What an unexpected pager failure reports - the same backstop the whole-list read's caller had. */
function storageFailureResult(): AgentChatHistoryListResult {
  return {
    ok: false,
    error: { code: 'STORAGE_ERROR', message: 'The conversation history could not be read' },
  };
}
