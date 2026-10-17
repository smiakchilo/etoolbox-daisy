import { type Mock, vi } from 'vitest';
import type { Logger } from '../../src/main/logger';

type LogFn = Logger['warn'];

export function makeRecordingLogger(): {
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

/** An IPC invoke event as the sender guards read it: a frame URL and a web contents id. */
export function ipcEventFrom(url: string, webContentsId: number, topFrame = true): unknown {
  const frame: { url: string; top: unknown } = { url, top: undefined };
  frame.top = topFrame ? frame : {};
  return { senderFrame: frame, sender: { id: webContentsId } };
}
