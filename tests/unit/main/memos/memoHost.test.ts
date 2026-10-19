import { describe, expect, it, vi } from 'vitest';
import { createMemoHost } from '../../../../src/main/memos/memoHost';
import type { MemoStore } from '../../../../src/main/memos/memoStore';
import type { MemoWriteRequest } from '../../../../src/shared';
import { makeRecordingLogger } from '../../../support/ipcHandlerHarness';
import { REAL_SKILL_MEMOS_TEMPLATE } from '../../../support/ruleResources';

const REQUEST: MemoWriteRequest = { title: 't', text: 'x', trigger: 'request' };

function makeHost(options: {
  enabled?: boolean;
  chatId?: string;
  write?: MemoStore['write'];
  forSkill?: MemoStore['forSkill'];
}) {
  const write = vi.fn<MemoStore['write']>(
    options.write ??
      (() =>
        Promise.resolve({ ok: true, value: { id: 'generic/a.md', title: 't', fileName: 'a.md' } })),
  );
  const forSkill = vi.fn<MemoStore['forSkill']>(
    options.forSkill ?? (() => Promise.resolve({ memos: [], skipped: 0 })),
  );
  const logger = makeRecordingLogger();
  const host = createMemoHost({
    store: { write, forSkill },
    skillMemosTemplate: REAL_SKILL_MEMOS_TEMPLATE,
    enabled: () => options.enabled ?? true,
    currentChatId: () => options.chatId,
    logger,
  });
  return { host, write, forSkill, logger };
}

describe('createMemoHost', () => {
  it('writes through the store with the current chat id', async () => {
    const { host, write } = makeHost({ chatId: 'chat-1' });

    expect((await host.write(REQUEST)).ok).toBe(true);
    expect(write).toHaveBeenCalledWith(REQUEST, { chatId: 'chat-1' });
  });

  it('writes without a chat id when none is current', async () => {
    const { host, write } = makeHost({});

    await host.write(REQUEST);

    expect(write).toHaveBeenCalledWith(REQUEST, {});
  });

  it('refuses while self-learning is switched off, without touching the store', async () => {
    const { host, write } = makeHost({ enabled: false });

    expect(host.enabled()).toBe(false);
    expect(await host.write(REQUEST)).toMatchObject({
      ok: false,
      error: { code: 'ACCESS_DENIED' },
    });
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ['STORAGE_ERROR', 'MEMO_WRITE_FAILED'],
    ['INVALID_ARGUMENT', 'MEMO_REJECTED'],
  ] as const)('logs a %s outcome as %s', async (code, logCode) => {
    const { host, logger } = makeHost({
      write: () => Promise.resolve({ ok: false, error: { code, message: 'm' } }),
    });

    await host.write(REQUEST);

    expect(logger.warn).toHaveBeenCalledWith(logCode, { outcome: 'failure' });
  });

  it("renders a skill's memos, read fresh from the store", async () => {
    const { host, forSkill } = makeHost({
      forSkill: () =>
        Promise.resolve({
          memos: [{ id: 'm', title: 'Both paths', body: 'Show both.' }],
          skipped: 0,
        }),
    });

    const block = await host.skillMemos('search');

    expect(forSkill).toHaveBeenCalledWith('search');
    expect(block).toContain('### Both paths');
    expect(block).toContain('Show both.');
  });

  it('gives no skill memos while self-learning is switched off', async () => {
    const { host, forSkill } = makeHost({
      enabled: false,
      forSkill: () => Promise.resolve({ memos: [{ id: 'm', title: 'T', body: 'B' }], skipped: 0 }),
    });

    expect(await host.skillMemos('search')).toBe('');
    expect(forSkill).not.toHaveBeenCalled();
  });

  it('gives no skill memos when the store fails, never rejecting', async () => {
    const { host } = makeHost({ forSkill: () => Promise.reject(new Error('disk')) });

    expect(await host.skillMemos('search')).toBe('');
  });
});
