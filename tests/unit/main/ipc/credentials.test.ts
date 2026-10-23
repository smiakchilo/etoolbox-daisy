import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CREDENTIALS_ERASE_CHANNEL } from '../../../../src/shared';
import { ipcEventFrom, makeRecordingLogger } from '../../../support/ipcHandlerHarness';

const invokeHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      invokeHandlers.set(channel, listener);
    },
  },
}));

const { registerCredentialsIpcHandlers } = await import('../../../../src/main/ipc/credentials');

const RENDERER_DIST = path.join(process.cwd(), 'out', 'renderer');
const TRUSTED_URL = pathToFileURL(path.join(RENDERER_DIST, 'index.html')).href;
const MAIN_WEB_CONTENTS_ID = 7;

const eraseAll = vi.fn<() => Promise<number>>();
const ready = Promise.resolve();

beforeEach(() => {
  invokeHandlers.clear();
  eraseAll.mockReset();
  eraseAll.mockResolvedValue(0);
});

function register(): ReturnType<typeof makeRecordingLogger> {
  const logger = makeRecordingLogger();
  registerCredentialsIpcHandlers({
    vault: { eraseAll, ready },
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

describe('registerCredentialsIpcHandlers', () => {
  it('erases and acknowledges without echoing a count', async () => {
    const logger = register();
    eraseAll.mockResolvedValue(4);

    expect(
      await handler(CREDENTIALS_ERASE_CHANNEL)(ipcEventFrom(TRUSTED_URL, MAIN_WEB_CONTENTS_ID)),
    ).toEqual({ ok: true });
    expect(logger.info).toHaveBeenCalledWith('CREDENTIALS_ERASED', { count: 4 });
  });

  it('reports a failed erase as a storage error', async () => {
    const logger = register();
    eraseAll.mockRejectedValueOnce(new Error('locked'));

    const result = await handler(CREDENTIALS_ERASE_CHANNEL)(
      ipcEventFrom(TRUSTED_URL, MAIN_WEB_CONTENTS_ID),
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'storage_error' } });
    expect(logger.error).toHaveBeenCalledWith('CREDENTIALS_ERASE_FAILED', { count: 1 });
  });

  it('refuses a remote frame', async () => {
    const logger = register();

    const result = await handler(CREDENTIALS_ERASE_CHANNEL)(
      ipcEventFrom('https://aem.example/', MAIN_WEB_CONTENTS_ID),
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'untrusted_sender' } });
    expect(eraseAll).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('CREDENTIALS_IPC_SENDER_REJECTED');
  });

  it('refuses the app renderer when it is not the main frame', async () => {
    register();

    const result = await handler(CREDENTIALS_ERASE_CHANNEL)(
      ipcEventFrom(TRUSTED_URL, MAIN_WEB_CONTENTS_ID, false),
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'untrusted_sender' } });
  });

  it('refuses a different web contents id with the right URL', async () => {
    register();

    const result = await handler(CREDENTIALS_ERASE_CHANNEL)(
      ipcEventFrom(TRUSTED_URL, MAIN_WEB_CONTENTS_ID + 1),
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'untrusted_sender' } });
  });
});
