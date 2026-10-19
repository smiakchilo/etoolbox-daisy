import { describe, expect, it, vi } from 'vitest';

/**
 * `createViewSession` is mostly Electron-value wiring with no independently
 * interesting decision logic (see its own module comment). The behaviours
 * added here that a reader cannot verify by types alone are the **download
 * guard** (owner decision: a DAM asset link is "a preview experience - not
 * downloaded or offered to download") and the **renderable-attachment
 * rewrite** that lets an asset link actually display (AEM serves it as an
 * attachment, which the guard would otherwise cancel).
 */

type SessionEvent = 'will-download';
type SessionListener = (...args: unknown[]) => void;

interface HeadersDetails {
  readonly url: string;
  readonly responseHeaders?: Record<string, string[]>;
}
type HeadersCallback = (response: { responseHeaders?: Record<string, string[]> }) => void;
type HeadersListener = (details: HeadersDetails, callback: HeadersCallback) => void;

const { fakeSession, appOn } = vi.hoisted(() => {
  const fakeSession = {
    on: vi.fn<(event: SessionEvent, listener: SessionListener) => void>(),
    closeAllConnections: vi.fn(() => Promise.resolve()),
    webRequest: {
      onHeadersReceived: vi.fn<(listener: HeadersListener) => void>(),
    },
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

import { createViewSession } from '../../../../src/main/webview';

/** The listener `createViewSession` registered most recently. */
function registeredHeadersListener(): HeadersListener {
  const registration = fakeSession.webRequest.onHeadersReceived.mock.calls.at(-1);
  expect(registration).toBeDefined();
  return registration![0];
}

describe('createViewSession - download guard', () => {
  it('cancels every download on the AEM session', () => {
    createViewSession();

    const registration = fakeSession.on.mock.calls.find(([event]) => event === 'will-download');
    expect(registration).toBeDefined();

    const handler = registration![1];
    const event = { preventDefault: vi.fn() };
    handler(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });
});

describe('createViewSession - renderable attachments', () => {
  it('removes the attachment disposition from an image so the pane displays it', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), getHealth: vi.fn() };
    createViewSession({ logger });

    const callback = vi.fn<HeadersCallback>();
    registeredHeadersListener()(
      {
        url: 'http://author.example/content/dam/x/y.jpg',
        responseHeaders: {
          'content-type': ['image/jpeg'],
          'content-disposition': ['attachment; filename="y.jpg"'],
          'content-length': ['42'],
        },
      },
      callback,
    );

    expect(callback).toHaveBeenCalledWith({
      responseHeaders: { 'content-type': ['image/jpeg'], 'content-length': ['42'] },
    });
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('applies a caller-supplied rule list instead of the default', () => {
    createViewSession({ responseHeaderRules: [] });

    const callback = vi.fn<HeadersCallback>();
    registeredHeadersListener()(
      {
        url: 'http://author.example/content/dam/x/y.jpg',
        responseHeaders: {
          'content-type': ['image/jpeg'],
          'content-disposition': ['attachment'],
        },
      },
      callback,
    );

    expect(callback).toHaveBeenCalledWith({});
  });

  it('leaves a non-renderable attachment untouched, so the guard cancels it', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), getHealth: vi.fn() };
    createViewSession({ logger });

    const callback = vi.fn<HeadersCallback>();
    registeredHeadersListener()(
      {
        url: 'http://author.example/content/dam/x/archive.zip',
        responseHeaders: {
          'content-type': ['application/zip'],
          'content-disposition': ['attachment; filename="archive.zip"'],
        },
      },
      callback,
    );

    expect(callback).toHaveBeenCalledWith({});
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('leaves a response without headers untouched', () => {
    createViewSession();

    const callback = vi.fn<HeadersCallback>();
    registeredHeadersListener()({ url: 'http://author.example/' }, callback);

    expect(callback).toHaveBeenCalledWith({});
  });
});
