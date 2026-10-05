import { describe, expect, it, vi } from 'vitest';

/**
 * `createAemSession` is mostly Electron-value wiring with no independently
 * interesting decision logic (see its own module comment). The one behaviour
 * added here that a reader cannot verify by types alone is the **download
 * guard** (owner decision: a DAM asset link is "a preview experience - not
 * downloaded or offered to download"), so it is asserted directly: the AEM
 * session must register a `will-download` listener that cancels every download.
 */

type SessionEvent = 'will-download';
type SessionListener = (...args: unknown[]) => void;

const { fakeSession, appOn } = vi.hoisted(() => {
  const fakeSession = {
    on: vi.fn<(event: SessionEvent, listener: SessionListener) => void>(),
    closeAllConnections: vi.fn(() => Promise.resolve()),
    cookies: {
      on: vi.fn<(event: string, listener: SessionListener) => void>(),
      set: vi.fn(() => Promise.resolve()),
    },
  };
  return { fakeSession, appOn: vi.fn() };
});

vi.mock('electron', () => ({
  app: { on: appOn },
  session: { fromPartition: vi.fn(() => fakeSession) },
}));

import { createAemSession } from '../../../../src/main/aem';

describe('createAemSession - download guard', () => {
  it('cancels every download on the AEM session', () => {
    createAemSession();

    const registration = fakeSession.on.mock.calls.find(([event]) => event === 'will-download');
    expect(registration).toBeDefined();

    const handler = registration![1];
    const event = { preventDefault: vi.fn() };
    handler(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });
});
