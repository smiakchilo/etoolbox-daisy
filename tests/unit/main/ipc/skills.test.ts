import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { Logger } from '../../../../src/main/logger';
import { SKILLS_OPEN_FOLDER_CHANNEL } from '../../../../src/shared';
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

const { isTrustedSkillsIpcSender, openSkillsFolder, registerSkillsIpcHandlers } =
  await import('../../../../src/main/ipc/skills');

const scratch = createScratchDirs('skills-ipc', 'skills-ipc-');
const RENDERER_DIST = path.join(process.cwd(), 'out', 'renderer');
const TRUSTED_URL = pathToFileURL(path.join(RENDERER_DIST, 'index.html')).href;
const MAIN_WEB_CONTENTS_ID = 7;

type LogFn = Logger['warn'];

function makeLogger(): {
  info: Mock<LogFn>;
  warn: Mock<LogFn>;
  error: Mock<LogFn>;
  getHealth: Logger['getHealth'];
} {
  return {
    info: vi.fn<LogFn>(),
    warn: vi.fn<LogFn>(),
    error: vi.fn<LogFn>(),
    getHealth: () => ({ writeFailureCount: 0, lastFailureCode: null, rotationCount: 0 }),
  };
}

function eventFrom(url: string, webContentsId: number, topFrame = true): unknown {
  const frame: { url: string; top: unknown } = { url, top: undefined };
  frame.top = topFrame ? frame : {};
  return { senderFrame: frame, sender: { id: webContentsId } };
}

beforeEach(() => {
  invokeHandlers.clear();
  openPath.mockReset();
  openPath.mockResolvedValue('');
});

afterEach(() => {
  scratch.cleanup();
});

describe('openSkillsFolder', () => {
  it('creates a missing folder and hands it to the file manager', async () => {
    const directory = path.join(scratch.create(), 'skills');
    const logger = makeLogger();

    const result = await openSkillsFolder({ directory, logger, openPath });

    expect(result).toEqual({ ok: true });
    expect(existsSync(directory)).toBe(true);
    expect(openPath).toHaveBeenCalledWith(directory);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('reports open_failed when the OS refuses, logging no free text', async () => {
    openPath.mockResolvedValue('C:\\secret\\path: no handler');
    const logger = makeLogger();

    const result = await openSkillsFolder({
      directory: path.join(scratch.create(), 'skills'),
      logger,
      openPath,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'open_failed' } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(logger.error).toHaveBeenCalledWith('SKILLS_FOLDER_OPEN_FAILED', { outcome: 'failure' });
  });
});

describe('isTrustedSkillsIpcSender', () => {
  const expectation = { mainWebContentsId: MAIN_WEB_CONTENTS_ID, rendererDistDir: RENDERER_DIST };

  it('accepts the app window main frame only', () => {
    const sender = { url: TRUSTED_URL, isMainFrame: true, webContentsId: MAIN_WEB_CONTENTS_ID };
    expect(isTrustedSkillsIpcSender(sender, expectation)).toBe(true);
    expect(isTrustedSkillsIpcSender({ ...sender, isMainFrame: false }, expectation)).toBe(false);
    expect(isTrustedSkillsIpcSender({ ...sender, webContentsId: 99 }, expectation)).toBe(false);
    expect(isTrustedSkillsIpcSender({ ...sender, url: 'https://aem.example/' }, expectation)).toBe(
      false,
    );
    expect(isTrustedSkillsIpcSender(undefined, expectation)).toBe(false);
  });
});

describe('registerSkillsIpcHandlers', () => {
  function register(logger: Logger): (event: unknown) => Promise<unknown> {
    registerSkillsIpcHandlers({
      directory: path.join(scratch.create(), 'skills'),
      logger,
      rendererDistDir: RENDERER_DIST,
      mainWebContentsId: MAIN_WEB_CONTENTS_ID,
    });
    const handler = invokeHandlers.get(SKILLS_OPEN_FOLDER_CHANNEL);
    if (handler === undefined) throw new Error('handler not registered');
    return (event) => Promise.resolve(handler(event));
  }

  it('opens the folder for a trusted sender', async () => {
    const handler = register(makeLogger());
    expect(await handler(eventFrom(TRUSTED_URL, MAIN_WEB_CONTENTS_ID))).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledTimes(1);
  });

  it('refuses a remote frame without touching the file manager', async () => {
    const logger = makeLogger();
    const handler = register(logger);

    const result = await handler(eventFrom('https://aem.example/', MAIN_WEB_CONTENTS_ID));

    expect(result).toMatchObject({ ok: false, error: { code: 'untrusted_sender' } });
    expect(openPath).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('SKILLS_IPC_SENDER_REJECTED');
  });

  it('refuses a call with no sender frame', async () => {
    const handler = register(makeLogger());
    const result = await handler({ senderFrame: null, sender: { id: MAIN_WEB_CONTENTS_ID } });
    expect(result).toMatchObject({ ok: false, error: { code: 'untrusted_sender' } });
    expect(openPath).not.toHaveBeenCalled();
  });
});
