import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../../src/main/logger';
import { RULES_OPEN_FOLDER_CHANNEL, RULES_RELOAD_CHANNEL } from '../../../../src/shared';
import { ipcEventFrom, makeRecordingLogger } from '../../../support/ipcHandlerHarness';
import { createScratchDirs } from '../../../support/scratchDirs';

const invokeHandlers = new Map<string, (...args: unknown[]) => unknown>();
const openPath = vi.fn<(path: string) => Promise<string>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      invokeHandlers.set(channel, listener);
    },
  },
  shell: { openPath: (target: string) => openPath(target) },
  app: { on: vi.fn(), removeListener: vi.fn() },
  session: {},
}));

const { openRulesFolder, registerRulesIpcHandlers, reloadRules } =
  await import('../../../../src/main/ipc/rules');

const scratch = createScratchDirs('rules-ipc', 'rules-ipc-');
const RENDERER_DIST = path.join(process.cwd(), 'out', 'renderer');
const TRUSTED_URL = pathToFileURL(path.join(RENDERER_DIST, 'index.html')).href;
const MAIN_WEB_CONTENTS_ID = 7;

beforeEach(() => {
  invokeHandlers.clear();
  openPath.mockReset();
  openPath.mockResolvedValue('');
});

afterEach(() => {
  scratch.cleanup();
});

describe('openRulesFolder', () => {
  it('creates a missing folder and hands it to the file manager', async () => {
    const directory = path.join(scratch.create(), 'rules');
    const logger = makeRecordingLogger();

    const result = await openRulesFolder({ directory, logger, openPath });

    expect(result).toEqual({ ok: true });
    expect(existsSync(directory)).toBe(true);
    expect(openPath).toHaveBeenCalledWith(directory);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('reports open_failed when the OS refuses, logging no free text', async () => {
    openPath.mockResolvedValue('C:\\secret\\path: no handler');
    const logger = makeRecordingLogger();

    const result = await openRulesFolder({
      directory: path.join(scratch.create(), 'rules'),
      logger,
      openPath,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'open_failed' } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(logger.error).toHaveBeenCalledWith('RULES_FOLDER_OPEN_FAILED', { outcome: 'failure' });
  });
});

describe('reloadRules', () => {
  it('reports the count the reload resolved to', async () => {
    const logger = makeRecordingLogger();
    expect(await reloadRules(() => Promise.resolve(3), logger)).toEqual({ ok: true, count: 3 });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('reports reload_failed and logs no free text when the reload throws', async () => {
    const logger = makeRecordingLogger();
    const result = await reloadRules(() => Promise.reject(new Error('C:\\secret')), logger);
    expect(result).toMatchObject({ ok: false, error: { code: 'reload_failed' } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(logger.error).toHaveBeenCalledWith('RULES_RELOAD_FAILED', { outcome: 'failure' });
  });
});

describe('registerRulesIpcHandlers', () => {
  const reload = vi.fn<() => Promise<number>>();

  function register(
    logger: Logger,
    channel:
      typeof RULES_OPEN_FOLDER_CHANNEL | typeof RULES_RELOAD_CHANNEL = RULES_OPEN_FOLDER_CHANNEL,
  ) {
    registerRulesIpcHandlers({
      directory: path.join(scratch.create(), 'rules'),
      logger,
      rendererDistDir: RENDERER_DIST,
      mainWebContentsId: MAIN_WEB_CONTENTS_ID,
      reload,
    });
    const handler = invokeHandlers.get(channel);
    if (handler === undefined) throw new Error('handler not registered');
    return (event: unknown) => Promise.resolve(handler(event));
  }

  it('reloads the rules for a trusted sender', async () => {
    reload.mockReset();
    reload.mockResolvedValue(2);
    const handler = register(makeRecordingLogger(), RULES_RELOAD_CHANNEL);
    expect(await handler(ipcEventFrom(TRUSTED_URL, MAIN_WEB_CONTENTS_ID))).toEqual({
      ok: true,
      count: 2,
    });
  });

  it('refuses a reload from a remote frame without reloading', async () => {
    reload.mockReset();
    const logger = makeRecordingLogger();
    const handler = register(logger, RULES_RELOAD_CHANNEL);
    const result = await handler(ipcEventFrom('https://aem.example/', MAIN_WEB_CONTENTS_ID));
    expect(result).toMatchObject({ ok: false, error: { code: 'untrusted_sender' } });
    expect(reload).not.toHaveBeenCalled();
  });

  it('opens the folder for a trusted sender', async () => {
    const handler = register(makeRecordingLogger());
    expect(await handler(ipcEventFrom(TRUSTED_URL, MAIN_WEB_CONTENTS_ID))).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledTimes(1);
  });

  it('refuses a remote frame without touching the file manager', async () => {
    const logger = makeRecordingLogger();
    const handler = register(logger);

    const result = await handler(ipcEventFrom('https://aem.example/', MAIN_WEB_CONTENTS_ID));

    expect(result).toMatchObject({ ok: false, error: { code: 'untrusted_sender' } });
    expect(openPath).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('RULES_IPC_SENDER_REJECTED');
  });

  it('refuses a call with no sender frame', async () => {
    const handler = register(makeRecordingLogger());
    const result = await handler({ senderFrame: null, sender: { id: MAIN_WEB_CONTENTS_ID } });
    expect(result).toMatchObject({ ok: false, error: { code: 'untrusted_sender' } });
    expect(openPath).not.toHaveBeenCalled();
  });
});
