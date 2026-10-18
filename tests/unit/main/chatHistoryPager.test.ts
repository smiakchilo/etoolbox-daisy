import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatId, ChatJournalRecord } from '../../../src/shared';
import { CHAT_CURSOR_TTL_MS, createChatHistoryPager } from '../../../src/main/chatHistoryPager';

/**
 * The stateful scan behind the History panel's small-batch loading
 * (`agent-chat:list-conversations`). A first request snapshots the chats
 * directory once and serves a page; the result's `next` cursor continues that
 * snapshot; a result without one ends the scan. The cursor's lifecycle is
 * provable here without a filesystem (injected snapshot/page/clock/token); one
 * case runs the pager's default members against a real scratch directory.
 */

const CHATS_DIR = 'C:/home/etoolbox-daisy/chats';

interface PageRead {
  readonly ids: readonly string[];
  readonly offset: number;
  readonly limit: number;
}

interface PagerHarness {
  readonly call: (request: {
    next?: string;
  }) => Awaited<ReturnType<ReturnType<typeof createChatHistoryPager>>>;
  readonly snapshotCalls: () => number;
  readonly pagesRead: () => readonly PageRead[];
}

const ENTRY_SHAPE = { chatId: '', startedAt: 1000, updatedAt: 2000 } as const;

/** Brands a raw string as a `ChatId`, as the writer/reader boundaries do. */
function cid(value: string): ChatId {
  return value as ChatId;
}

/** A pager over a stubbed snapshot/page read, with a controllable clock. */
function harnessFixture(
  snapshot: readonly string[],
  options: {
    readonly pageSize?: number;
    readonly now?: () => number;
    readonly tokens?: string[];
  } = {},
): PagerHarness {
  const snapshotCalls: number[] = [];
  const pages: PageRead[] = [];
  let tokenIndex = 0;
  const tokens = options.tokens ?? ['tok-1', 'tok-2', 'tok-3', 'tok-4'];
  const pager = createChatHistoryPager({
    chatsDir: CHATS_DIR,
    ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    nextToken: () => {
      const token = tokens[tokenIndex];
      tokenIndex += 1;
      if (token === undefined) throw new Error('out of test tokens');
      return token;
    },
    snapshotIds: () => {
      snapshotCalls.push(1);
      return snapshot;
    },
    readPage: (_dir, ids, offset, limit) => {
      pages.push({ ids: [...ids], offset, limit });
      const entries = ids
        .slice(offset, offset + limit)
        .map((chatId) => ({ ...ENTRY_SHAPE, chatId: cid(chatId) }));
      return { entries, hasMore: offset + limit < ids.length };
    },
  });
  return {
    call: (request) => pager(request),
    snapshotCalls: () => snapshotCalls.length,
    pagesRead: () => pages,
  };
}

describe('createChatHistoryPager', () => {
  it('serves the first page with a cursor, one snapshot per scan', () => {
    const harness = harnessFixture(['c1', 'c2', 'c3'], { pageSize: 2 });

    const first = harness.call({});

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.entries.map((entry) => entry.chatId)).toEqual(['c1', 'c2']);
    expect(first.next).toBe('tok-1');
    expect(harness.snapshotCalls()).toBe(1);
    expect(harness.pagesRead()).toEqual([{ ids: ['c1', 'c2', 'c3'], offset: 0, limit: 2 }]);
  });

  it('continues the same snapshot page by page until it reports none left', () => {
    const harness = harnessFixture(['c1', 'c2', 'c3'], { pageSize: 2 });
    const first = harness.call({});
    const cursor = first.ok ? first.next : undefined;
    if (cursor === undefined) throw new Error('a full page must carry a cursor');

    const second = harness.call({ next: cursor });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // The last page is the tail, and it carries no cursor.
    expect(second.entries.map((entry) => entry.chatId)).toEqual(['c3']);
    expect(second.next).toBeUndefined();
    expect(harness.pagesRead()[1]).toEqual({ ids: ['c1', 'c2', 'c3'], offset: 2, limit: 2 });
    expect(harness.snapshotCalls()).toBe(1);
  });

  it('restarts from a fresh snapshot when the cursor is unknown', () => {
    const harness = harnessFixture(['c1'], { pageSize: 2 });

    const result = harness.call({ next: 'forgotten' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((entry) => entry.chatId)).toEqual(['c1']);
    expect(result.next).toBeUndefined();
    expect(harness.snapshotCalls()).toBe(1);
  });

  it('treats an expired cursor as unknown and starts over', () => {
    let clock = CHAT_CURSOR_TTL_MS * 10;
    const harness = harnessFixture(['c1', 'c2', 'c3'], {
      pageSize: 2,
      now: () => clock,
    });
    const first = harness.call({});
    const cursor = first.ok ? first.next : undefined;
    if (cursor === undefined) throw new Error('a full page must carry a cursor');

    clock += CHAT_CURSOR_TTL_MS + 1;
    const stale = harness.call({ next: cursor });

    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    // A brand-new scan from the top, not a continuation of the dead one.
    expect(stale.entries.map((entry) => entry.chatId)).toEqual(['c1', 'c2']);
    expect(stale.next).toBe('tok-2');
    expect(harness.snapshotCalls()).toBe(2);
  });

  it('serves one page for an empty history and asks for none', () => {
    const harness = harnessFixture([], { pageSize: 2 });

    const result = harness.call({});

    expect(result).toEqual({ ok: true, entries: [] });
  });

  it('does not hand back a cursor for a half-filled last page', () => {
    const harness = harnessFixture(['c1'], { pageSize: 2 });

    const result = harness.call({});

    expect(result).toEqual({ ok: true, entries: [{ ...ENTRY_SHAPE, chatId: 'c1' }] });
  });

  it('runs its default members against a real directory of real journals', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'daisy-pager-'));
    try {
      // Journals the real reader parses: a header plus a user prompt each, in
      // the writer's own shapes, so the full read path is exercised.
      const header: ChatJournalRecord = {
        recordType: 'header',
        schemaVersion: 1,
        chatId: 'chat-1',
        sessionId: 'sdk-1',
        startedAt: 1000,
      } as unknown as ChatJournalRecord;
      const prompt: ChatJournalRecord = {
        recordType: 'user.prompt',
        at: 2000,
        chatId: 'chat-1',
        turnId: 'turn-1',
        prompt: 'Where is the media library?',
      } as unknown as ChatJournalRecord;
      const line = (record: ChatJournalRecord): string => `${JSON.stringify(record)}\n`;
      writeFileSync(path.join(scratch, 'chat-1.jsonl'), line(header) + line(prompt), 'utf8');
      writeFileSync(path.join(scratch, 'ignore.txt'), 'not a journal', 'utf8');

      const pager = createChatHistoryPager({ chatsDir: scratch, pageSize: 1 });
      const first = pager({});
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.entries.map((entry) => entry.chatId)).toEqual(['chat-1']);
      expect(first.entries[0]?.title).toBe('Where is the media library?');
      // One journal, one page: the scan ends here.
      expect(first.next).toBeUndefined();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
