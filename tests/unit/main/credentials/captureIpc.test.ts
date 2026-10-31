import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CREDENTIALS_CAPTURED_CHANNEL } from '../../../../src/shared';
import { makeRecordingLogger } from '../../../support/ipcHandlerHarness';

const { ipcOn } = vi.hoisted(() => ({
  ipcOn: vi.fn<(channel: string, listener: (event: unknown, payload: unknown) => void) => void>(),
}));

vi.mock('electron', () => ({ ipcMain: { on: ipcOn } }));

import { registerCredentialCaptureIpc } from '../../../../src/main/credentials/capture';

function frameEvent(url: string): unknown {
  const frame: { url: string; top: unknown } = { url, top: undefined };
  frame.top = frame;
  return { senderFrame: frame };
}

function register() {
  const vault = {
    record: vi.fn<(entry: unknown) => Promise<void>>().mockResolvedValue(undefined),
    latestUsername: vi.fn<(origin: string) => string | undefined>(),
  };
  const authDiagnostics = { noteSignIn: vi.fn<(origin: string, nowMs: number) => void>() };
  registerCredentialCaptureIpc({ vault, logger: makeRecordingLogger(), authDiagnostics });
  const registration = ipcOn.mock.calls
    .filter(([channel]) => channel === CREDENTIALS_CAPTURED_CHANNEL)
    .at(-1);
  expect(registration).toBeDefined();
  return { vault, authDiagnostics, listener: registration![1] };
}

describe('registerCredentialCaptureIpc - sign-in episode', () => {
  beforeEach(() => {
    ipcOn.mockClear();
  });

  it('starts a sign-in episode for the origin of the frame that sent the capture', () => {
    const { authDiagnostics, listener } = register();

    listener(frameEvent('http://author.example:4502/libs/granite/core/content/login.html'), {
      username: 'admin',
      password: 'secret',
    });

    expect(authDiagnostics.noteSignIn).toHaveBeenCalledWith(
      'http://author.example:4502',
      expect.any(Number),
    );
  });

  it('does not start an episode for a capture that is refused', () => {
    const { authDiagnostics, listener } = register();

    listener(frameEvent('file:///login.html'), { username: 'admin', password: 'secret' });

    expect(authDiagnostics.noteSignIn).not.toHaveBeenCalled();
  });
});
