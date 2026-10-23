import { describe, expect, it } from 'vitest';
import {
  type ToolError,
  createPageFillQueue,
  createToolError,
  err,
  ok,
  runPageFill,
} from '../../../../../src/shared';

describe('createPageFillQueue', () => {
  it('needs a source page until a full display page is accepted', () => {
    const queue = createPageFillQueue<string>(3);
    expect(queue.needsPage()).toBe(true);
    expect(queue.buffered).toEqual([]);

    queue.accept(['a', 'b']);
    expect(queue.needsPage()).toBe(true);
    expect(queue.buffered).toEqual(['a', 'b']);

    queue.accept(['c']);
    expect(queue.needsPage()).toBe(false);
    expect(queue.hasMore).toBe(true);
  });

  it('hands out exactly one display page and keeps the surplus, in order', () => {
    const queue = createPageFillQueue<string>(3);
    queue.accept(['a']);
    queue.accept(['b', 'c', 'd']);

    expect(queue.takePage()).toEqual(['a', 'b', 'c']);
    expect(queue.buffered).toEqual(['d']);
    // The surplus stays first in line: the next page still needs two items.
    expect(queue.needsPage()).toBe(true);
    expect(queue.hasMore).toBe(true);
    queue.accept(['e', 'f']);
    expect(queue.takePage()).toEqual(['d', 'e', 'f']);
    expect(queue.buffered).toEqual([]);
  });

  it('still has more while the source may supply pages, even with an empty buffer', () => {
    const queue = createPageFillQueue<string>(2);
    queue.accept(['a']);
    expect(queue.takePage()).toEqual(['a']);
    expect(queue.needsPage()).toBe(true);
    expect(queue.hasMore).toBe(true);
  });

  it('hands out a short final page when the source is exhausted', () => {
    const queue = createPageFillQueue<string>(3);
    queue.accept(['a', 'b']);
    queue.exhaust();

    expect(queue.sourceExhausted).toBe(true);
    expect(queue.needsPage()).toBe(false);
    expect(queue.hasMore).toBe(true);
    expect(queue.takePage()).toEqual(['a', 'b']);
    expect(queue.hasMore).toBe(false);
    expect(queue.needsPage()).toBe(false);
  });

  it('finishes with nothing to hand out when it is exhausted empty', () => {
    const queue = createPageFillQueue<string>(3);
    queue.exhaust();
    expect(queue.needsPage()).toBe(false);
    expect(queue.hasMore).toBe(false);
    expect(queue.takePage()).toEqual([]);
  });

  it('accepts a page answered before the source was exhausted', () => {
    const queue = createPageFillQueue<string>(2);
    queue.exhaust();
    queue.accept(['a']);

    expect(queue.needsPage()).toBe(false);
    expect(queue.hasMore).toBe(true);
    expect(queue.takePage()).toEqual(['a']);
    expect(queue.hasMore).toBe(false);
  });

  it('treats exhaust as idempotent', () => {
    const queue = createPageFillQueue<string>(1);
    queue.exhaust();
    queue.exhaust();
    expect(queue.sourceExhausted).toBe(true);
  });

  it('refuses a page size that cannot hold an item', () => {
    expect(() => createPageFillQueue(0)).toThrow(RangeError);
    expect(() => createPageFillQueue(-1)).toThrow(RangeError);
    expect(() => createPageFillQueue(1.5)).toThrow(RangeError);
  });
});

function failure(code: Parameters<typeof createToolError>[0] = 'UNEXPECTED_RESPONSE'): ToolError {
  return createToolError(code, 'upstream failed', 'request' as never);
}

describe('runPageFill', () => {
  it('fetches and processes pages until a display page is filled', async () => {
    const queue = createPageFillQueue<number>(3);
    let fetches = 0;
    const result = await runPageFill<number, number>({
      queue,
      fetchPage: () => {
        fetches += 1;
        return Promise.resolve(ok({ items: [1, 2], hasMore: true }));
      },
      processPage: (items) => Promise.resolve(ok(items)),
      isCancelled: () => false,
    });

    expect(result).toEqual(ok('filled'));
    expect(fetches).toBe(2);
    expect(queue.buffered).toEqual([1, 2, 1, 2]);
  });

  it('loops while the callback accepts fewer items than the page held', async () => {
    const queue = createPageFillQueue<number>(3);
    let fetches = 0;
    const result = await runPageFill<number, number>({
      queue,
      fetchPage: () => {
        fetches += 1;
        return Promise.resolve(ok({ items: [1, 2], hasMore: true }));
      },
      // A filter: only odd items survive.
      processPage: (items) => Promise.resolve(ok(items.filter((item) => item % 2 === 1))),
      isCancelled: () => false,
    });

    expect(result).toEqual(ok('filled'));
    // 1 + 1 + 1 across three fetched pages.
    expect(fetches).toBe(3);
    expect(queue.buffered).toEqual([1, 1, 1]);
  });

  it('exhausts after processing a page that says no more exist', async () => {
    const queue = createPageFillQueue<number>(3);
    const result = await runPageFill<number, number>({
      queue,
      fetchPage: () => Promise.resolve(ok({ items: [1], hasMore: false })),
      processPage: (items) => Promise.resolve(ok(items)),
      isCancelled: () => false,
    });

    expect(result).toEqual(ok('exhausted'));
    expect(queue.sourceExhausted).toBe(true);
    expect(queue.buffered).toEqual([1]);
  });

  it('stops on an empty page and reports it to the caller', async () => {
    const queue = createPageFillQueue<number>(3);
    const emptyPages: number[] = [];
    const result = await runPageFill<number, number>({
      queue,
      fetchPage: () => Promise.resolve(ok({ items: [], hasMore: true })),
      processPage: () => Promise.reject(new Error('must not process an empty page')),
      isCancelled: () => false,
      onEmptyPage: (page) => {
        emptyPages.push(page.items.length);
      },
    });

    expect(result).toEqual(ok('exhausted'));
    expect(emptyPages).toEqual([0]);
    expect(queue.sourceExhausted).toBe(true);
  });

  it('stops before fetching when cancelled', async () => {
    const queue = createPageFillQueue<number>(2);
    let fetches = 0;
    const result = await runPageFill<number, number>({
      queue,
      fetchPage: () => {
        fetches += 1;
        return Promise.resolve(ok({ items: [1], hasMore: true }));
      },
      processPage: (items) => Promise.resolve(ok(items)),
      isCancelled: () => true,
    });

    expect(result).toEqual(ok('cancelled'));
    expect(fetches).toBe(0);
  });

  it('returns a fetch error without processing anything', async () => {
    const queue = createPageFillQueue<number>(2);
    let processed = 0;
    const result = await runPageFill<number, number>({
      queue,
      fetchPage: () => Promise.resolve(err(failure())),
      processPage: (items) => {
        processed += 1;
        return Promise.resolve(ok(items));
      },
      isCancelled: () => false,
    });

    expect(!result.ok && result.error.code).toBe('UNEXPECTED_RESPONSE');
    expect(processed).toBe(0);
  });

  it('returns a callback error as the routine result', async () => {
    const queue = createPageFillQueue<number>(2);
    const result = await runPageFill<number, number>({
      queue,
      fetchPage: () => Promise.resolve(ok({ items: [1], hasMore: true })),
      processPage: () => Promise.resolve(err(failure('CANCELLED'))),
      isCancelled: () => false,
    });

    expect(!result.ok && result.error.code).toBe('CANCELLED');
  });
});
