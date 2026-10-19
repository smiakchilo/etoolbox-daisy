import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemosIpcOperations } from '../../../../src/main/ipc/memos';
import {
  MEMOS_OPEN_FOLDER_CHANNEL,
  MEMOS_REVEAL_CHANNEL,
  MEMOS_UNDO_CHANNEL,
} from '../../../../src/shared';
import { ipcEventFrom, makeRecordingLogger } from '../../../support/ipcHandlerHarness';
import { createScratchDirs } from '../../../support/scratchDirs';

const invokeHandlers = new Map<string, (...args: unknown[]) => unknown>();
const openPath = vi.fn<(path: string) => Promise<string>>();
const showItemInFolder = vi.fn<(path: string) => void>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      invokeHandlers.set(channel, listener);
    },
  },
  shell: {
    openPath: (target: string) => openPath(target),
    showItemInFolder: (target: string) => {
      showItemInFolder(target);
    },
  },
  app: { on: vi.fn(), removeListener: vi.fn() },
  session: {},
}));

const { openMemosFolder, registerMemosIpcHandlers, revealMemo, undoMemo } =
  await import('../../../../src/main/ipc/memos');

const scratch = createScratchDirs('memos-ipc', 'memos-ipc-');
const RENDERER_DIST = path.join(process.cwd(), 'out', 'renderer');
const TRUSTED_URL = pathToFileURL(path.join(RENDERER_DIST, 'index.html')).href;
const MAIN_WEB_CONTENTS_ID = 7;
const MEMO_ID = 'generic/20261018-090507-a.md';
const MEMO_PATH = 'C:\\memos\\generic\\20261018-090507-a.md';

const locate = vi.fn<(id: string) => Promise<string | undefined>>();
const remove = vi.fn<(id: string) => Promise<boolean>>();

beforeEach(() => {
  invokeHandlers.clear();
  for (const mock of [openPath, showItemInFolder, locate, remove]) mock.mockReset();
  openPath.mockResolvedValue('');
});

afterEach(() => {
  scratch.cleanup();
});

function makeOps(overrides: Partial<MemosIpcOperations> = {}): MemosIpcOperations {
  return {
    directory: path.join(scratch.create(), 'memos'),
    store: { locate, remove },
    logger: makeRecordingLogger(),
    openPath,
    showItemInFolder,
    ...overrides,
  };
}

describe('openMemosFolder', () => {
  it('creates a missing folder and hands it to the file manager', async () => {
    const ops = makeOps();

    expect(await openMemosFolder(ops)).toEqual({ ok: true });
    expect(existsSync(ops.directory)).toBe(true);
    expect(openPath).toHaveBeenCalledWith(ops.directory);
  });

  it('reports open_failed when the OS refuses, logging no free text', async () => {
    openPath.mockResolvedValue('C:\\secret\\path: no handler');
    const logger = makeRecordingLogger();

    const result = await openMemosFolder(makeOps({ logger }));

    expect(result).toMatchObject({ ok: false, error: { code: 'open_failed' } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(logger.error).toHaveBeenCalledWith('MEMOS_FOLDER_OPEN_FAILED', { outcome: 'failure' });
  });
});

describe('revealMemo', () => {
  it('reveals the path main resolves from the id', async () => {
    locate.mockResolvedValue(MEMO_PATH);

    expect(await revealMemo(makeOps(), { id: MEMO_ID })).toEqual({ ok: true });
    expect(locate).toHaveBeenCalledWith(MEMO_ID);
    expect(showItemInFolder).toHaveBeenCalledWith(MEMO_PATH);
  });

  it('reports not_found for a memo that is gone', async () => {
    locate.mockResolvedValue(undefined);

    expect(await revealMemo(makeOps(), { id: MEMO_ID })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it.each([undefined, { id: '../x.md' }, { id: MEMO_ID, extra: 1 }, { path: MEMO_PATH }])(
    'refuses the payload %j',
    async (payload) => {
      expect(await revealMemo(makeOps(), payload)).toMatchObject({
        ok: false,
        error: { code: 'invalid_payload' },
      });
      expect(locate).not.toHaveBeenCalled();
    },
  );
});

describe('undoMemo', () => {
  it('removes the memo by id', async () => {
    remove.mockResolvedValue(true);

    expect(await undoMemo(makeOps(), { id: MEMO_ID })).toEqual({ ok: true });
    expect(remove).toHaveBeenCalledWith(MEMO_ID);
  });

  it('reports not_found when nothing was removed', async () => {
    remove.mockResolvedValue(false);

    expect(await undoMemo(makeOps(), { id: MEMO_ID })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('refuses an invalid payload without touching the store', async () => {
    expect(await undoMemo(makeOps(), { id: 42 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_payload' },
    });
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('registerMemosIpcHandlers', () => {
  function register(): ReturnType<typeof makeRecordingLogger> {
    const logger = makeRecordingLogger();
    registerMemosIpcHandlers({
      directory: path.join(scratch.create(), 'memos'),
      store: { locate, remove },
      logger,
      rendererDistDir: RENDERER_DIST,
      mainWebContentsId: MAIN_WEB_CONTENTS_ID,
    });
    return logger;
  }

  function handler(channel: string): (event: unknown, payload?: unknown) => Promise<unknown> {
    const registered = invokeHandlers.get(channel);
    if (registered === undefined) throw new Error(`${channel} not registered`);
    return (event, payload) => Promise.resolve(registered(event, payload));
  }

  it('serves all three channels for a trusted sender', async () => {
    register();
    locate.mockResolvedValue(MEMO_PATH);
    remove.mockResolvedValue(true);
    const trusted = ipcEventFrom(TRUSTED_URL, MAIN_WEB_CONTENTS_ID);

    expect(await handler(MEMOS_OPEN_FOLDER_CHANNEL)(trusted)).toEqual({ ok: true });
    expect(await handler(MEMOS_REVEAL_CHANNEL)(trusted, { id: MEMO_ID })).toEqual({ ok: true });
    expect(await handler(MEMOS_UNDO_CHANNEL)(trusted, { id: MEMO_ID })).toEqual({ ok: true });
  });

  it.each([MEMOS_OPEN_FOLDER_CHANNEL, MEMOS_REVEAL_CHANNEL, MEMOS_UNDO_CHANNEL])(
    'refuses a remote frame on %s',
    async (channel) => {
      const logger = register();

      const result = await handler(channel)(
        ipcEventFrom('https://aem.example/', MAIN_WEB_CONTENTS_ID),
        { id: MEMO_ID },
      );

      expect(result).toMatchObject({ ok: false, error: { code: 'untrusted_sender' } });
      expect(openPath).not.toHaveBeenCalled();
      expect(locate).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('MEMOS_IPC_SENDER_REJECTED');
    },
  );
});
