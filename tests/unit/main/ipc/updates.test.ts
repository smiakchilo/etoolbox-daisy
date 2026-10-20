import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Updater } from '../../../../src/main/updates/updater';
import {
  UPDATES_APPLY_CHANNEL,
  UPDATES_CHECK_CHANNEL,
  UPDATES_GET_STATUS_CHANNEL,
  type UpdateStatus,
} from '../../../../src/shared';
import { ipcEventFrom, makeRecordingLogger } from '../../../support/ipcHandlerHarness';

const invokeHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      invokeHandlers.set(channel, listener);
    },
  },
  app: { on: vi.fn(), removeListener: vi.fn() },
  session: {},
}));

const { registerUpdatesIpcHandlers } = await import('../../../../src/main/ipc/updates');

const RENDERER_DIST = path.join(process.cwd(), 'out', 'renderer');
const TRUSTED_URL = pathToFileURL(path.join(RENDERER_DIST, 'index.html')).href;
const MAIN_WEB_CONTENTS_ID = 7;

const AVAILABLE: UpdateStatus = { kind: 'available', version: '2.0.0' };

let updater: { [K in keyof Updater]: ReturnType<typeof vi.fn> };
let logger: ReturnType<typeof makeRecordingLogger>;

beforeEach(() => {
  invokeHandlers.clear();
  updater = {
    getStatus: vi.fn(() => AVAILABLE),
    check: vi.fn(() => Promise.resolve(AVAILABLE)),
    apply: vi.fn(() => Promise.resolve({ kind: 'applying' } satisfies UpdateStatus)),
  };
  logger = makeRecordingLogger();
  registerUpdatesIpcHandlers({
    updater: updater as unknown as Updater,
    logger,
    rendererDistDir: RENDERER_DIST,
    mainWebContentsId: MAIN_WEB_CONTENTS_ID,
  });
});

function call(channel: string, event: unknown): Promise<unknown> {
  const handler = invokeHandlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} not registered`);
  return Promise.resolve(handler(event));
}

const trusted = (): unknown => ipcEventFrom(TRUSTED_URL, MAIN_WEB_CONTENTS_ID);

describe('registerUpdatesIpcHandlers', () => {
  it('answers each call with the status the updater returns', async () => {
    expect(await call(UPDATES_GET_STATUS_CHANNEL, trusted())).toEqual({
      ok: true,
      status: AVAILABLE,
    });
    expect(await call(UPDATES_CHECK_CHANNEL, trusted())).toEqual({ ok: true, status: AVAILABLE });
    expect(await call(UPDATES_APPLY_CHANNEL, trusted())).toEqual({
      ok: true,
      status: { kind: 'applying' },
    });
    expect(updater.check).toHaveBeenCalledTimes(1);
    expect(updater.apply).toHaveBeenCalledTimes(1);
  });

  it.each([UPDATES_GET_STATUS_CHANNEL, UPDATES_CHECK_CHANNEL, UPDATES_APPLY_CHANNEL])(
    'refuses a remote frame on %s without touching the updater',
    async (channel) => {
      const result = await call(
        channel,
        ipcEventFrom('https://aem.example/', MAIN_WEB_CONTENTS_ID),
      );
      expect(result).toMatchObject({ ok: false, error: { code: 'untrusted_sender' } });
      expect(updater.check).not.toHaveBeenCalled();
      expect(updater.apply).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('UPDATES_IPC_SENDER_REJECTED');
    },
  );

  it('refuses a call with no sender frame', async () => {
    const result = await call(UPDATES_APPLY_CHANNEL, {
      senderFrame: null,
      sender: { id: MAIN_WEB_CONTENTS_ID },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'untrusted_sender' } });
    expect(updater.apply).not.toHaveBeenCalled();
  });
});
