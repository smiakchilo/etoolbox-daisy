import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainEvent, WebContents } from 'electron';
import {
  WEBVIEW_BRIDGE_CANCEL_CHANNEL,
  WEBVIEW_BRIDGE_FETCH_CHANNEL,
  WEBVIEW_BRIDGE_READ_CHANNEL,
  WEBVIEW_BRIDGE_READY_CHANNEL,
  WEBVIEW_BRIDGE_REPLY_CHANNEL,
} from '../../../../src/shared/contracts/webviewBridge';
import type { BridgeReplyOrigin } from '../../../../src/main/webview/bridgeBroker';

const ipcListeners = new Map<string, Set<(event: IpcMainEvent, payload: unknown) => void>>();

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: (event: IpcMainEvent, payload: unknown) => void) => {
      const existing = ipcListeners.get(channel) ?? new Set();
      existing.add(listener);
      ipcListeners.set(channel, existing);
    },
    removeListener: (
      channel: string,
      listener: (event: IpcMainEvent, payload: unknown) => void,
    ) => {
      ipcListeners.get(channel)?.delete(listener);
    },
  },
}));

const { createWebviewBridgeTransport } =
  await import('../../../../src/main/webview/bridgeTransport');

interface FakeViewControls {
  readonly webContents: WebContents;
  readonly sent: { channel: string; payload: unknown }[];
  destroyed: boolean;
}

function makeFakeView(id: number): FakeViewControls {
  const sent: { channel: string; payload: unknown }[] = [];
  const controls = {
    sent,
    destroyed: false,
  } as FakeViewControls & { destroyed: boolean };
  const webContents = {
    id,
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload });
    },
    isDestroyed: () => controls.destroyed,
  } as unknown as WebContents;
  Reflect.set(controls, 'webContents', webContents);
  return controls;
}

/** A sender frame that reports itself as the top frame, as a real main frame does. */
function mainFrameEvent(senderId: number): IpcMainEvent {
  const frame = {};
  Reflect.set(frame, 'top', frame);
  return { sender: { id: senderId }, senderFrame: frame } as unknown as IpcMainEvent;
}

function subFrameEvent(senderId: number): IpcMainEvent {
  const top = {};
  return { sender: { id: senderId }, senderFrame: { top } } as unknown as IpcMainEvent;
}

function fireReply(event: IpcMainEvent, payload: unknown): void {
  for (const listener of [...(ipcListeners.get(WEBVIEW_BRIDGE_REPLY_CHANNEL) ?? [])]) {
    listener(event, payload);
  }
}

function fireReady(event: IpcMainEvent): void {
  for (const listener of [...(ipcListeners.get(WEBVIEW_BRIDGE_READY_CHANNEL) ?? [])]) {
    listener(event, {});
  }
}

beforeEach(() => {
  ipcListeners.clear();
});

describe('createWebviewBridgeTransport - delivering commands', () => {
  it('sends a fetch command to the live AEM view and reports that it went out', () => {
    const view = makeFakeView(7);
    const transport = createWebviewBridgeTransport({ viewWebContents: () => view.webContents });

    const sent = transport.sendFetch({
      requestId: 'req-a',
      url: 'https://author.example/x.0.json',
    });

    expect(sent).toBe(true);
    expect(view.sent).toEqual([
      {
        channel: WEBVIEW_BRIDGE_FETCH_CHANNEL,
        payload: { requestId: 'req-a', url: 'https://author.example/x.0.json' },
      },
    ]);
  });

  it('sends a read command on its own channel and reports whether it went out', () => {
    const view = makeFakeView(7);
    const transport = createWebviewBridgeTransport({ viewWebContents: () => view.webContents });
    const command = { requestId: 'req-a', selector: 'a', limit: 5 };

    expect(transport.sendRead?.(command)).toBe(true);
    expect(view.sent).toEqual([{ channel: WEBVIEW_BRIDGE_READ_CHANNEL, payload: command }]);

    const absent = createWebviewBridgeTransport({ viewWebContents: () => undefined });
    expect(absent.sendRead?.(command)).toBe(false);
  });

  it('reports that a fetch did not go out when there is no view, rather than pretending it did', () => {
    const transport = createWebviewBridgeTransport({ viewWebContents: () => undefined });

    expect(transport.sendFetch({ requestId: 'req-a', url: 'https://author.example/x' })).toBe(
      false,
    );
  });

  it('treats a destroyed view as no view at all', () => {
    const view = makeFakeView(7);
    view.destroyed = true;
    const transport = createWebviewBridgeTransport({ viewWebContents: () => view.webContents });

    expect(transport.sendFetch({ requestId: 'req-a', url: 'https://author.example/x' })).toBe(
      false,
    );
    expect(view.sent).toEqual([]);
  });

  it('sends a cancel command on its own channel so the preload can abort the fetch', () => {
    const view = makeFakeView(7);
    const transport = createWebviewBridgeTransport({ viewWebContents: () => view.webContents });

    transport.sendCancel({ requestId: 'req-a' });

    expect(view.sent).toEqual([
      { channel: WEBVIEW_BRIDGE_CANCEL_CHANNEL, payload: { requestId: 'req-a' } },
    ]);
  });

  it('resolves the target view fresh on every send, so a replaced view is the one that receives', () => {
    // The pane can be rebuilt underneath the transport. A target captured once
    // would keep addressing a view the user is no longer looking at.
    let view = makeFakeView(7);
    const transport = createWebviewBridgeTransport({ viewWebContents: () => view.webContents });
    transport.sendFetch({ requestId: 'req-a', url: 'https://author.example/a' });

    const replacement = makeFakeView(99);
    view = replacement;
    transport.sendFetch({ requestId: 'req-b', url: 'https://author.example/b' });

    expect(replacement.sent).toHaveLength(1);
  });
});

describe('createWebviewBridgeTransport - deciding who may answer', () => {
  function captureOrigin(deps: { viewWebContents: () => WebContents | undefined }): {
    origins: BridgeReplyOrigin[];
    payloads: unknown[];
    dispose: () => void;
  } {
    const origins: BridgeReplyOrigin[] = [];
    const payloads: unknown[] = [];
    const transport = createWebviewBridgeTransport(deps);
    transport.onReply((payload, origin) => {
      payloads.push(payload);
      origins.push(origin);
    });
    return { origins, payloads, dispose: () => transport.dispose() };
  }

  it('trusts a main-frame reply whose sender is the live AEM view', () => {
    const view = makeFakeView(7);
    const captured = captureOrigin({ viewWebContents: () => view.webContents });

    fireReply(mainFrameEvent(7), { kind: 'cancelled', requestId: 'req-a' });

    expect(captured.origins).toEqual([{ isTrustedView: true, isMainFrame: true }]);
  });

  it('does not trust a reply from any other WebContents, however well-formed', () => {
    const view = makeFakeView(7);
    const captured = captureOrigin({ viewWebContents: () => view.webContents });

    fireReply(mainFrameEvent(8), { kind: 'cancelled', requestId: 'req-a' });

    expect(captured.origins[0]?.isTrustedView).toBe(false);
  });

  it('does not trust a reply from a sub-frame of the AEM view', () => {
    // Remote AEM content can embed iframes; only the frame our preload runs in
    // may answer.
    const view = makeFakeView(7);
    const captured = captureOrigin({ viewWebContents: () => view.webContents });

    fireReply(subFrameEvent(7), { kind: 'cancelled', requestId: 'req-a' });

    expect(captured.origins[0]).toEqual({ isTrustedView: true, isMainFrame: false });
  });

  it('does not trust any reply while there is no live view, instead of matching absence to absence', () => {
    const captured = captureOrigin({ viewWebContents: () => undefined });

    fireReply(mainFrameEvent(7), { kind: 'cancelled', requestId: 'req-a' });

    expect(captured.origins[0]?.isTrustedView).toBe(false);
  });

  it('re-reads the trusted identity on every reply, so the old view stops being trusted once replaced', () => {
    // This is the step 05 bug in its bridge form: an identity captured when the
    // listener was registered would still name the view that has since gone.
    let view = makeFakeView(7);
    const captured = captureOrigin({ viewWebContents: () => view.webContents });

    fireReply(mainFrameEvent(7), { kind: 'cancelled', requestId: 'req-a' });
    view = makeFakeView(99);
    fireReply(mainFrameEvent(7), { kind: 'cancelled', requestId: 'req-b' });
    fireReply(mainFrameEvent(99), { kind: 'cancelled', requestId: 'req-c' });

    expect(captured.origins.map((origin) => origin.isTrustedView)).toEqual([true, false, true]);
  });

  it('hands the payload through untouched, leaving validation to the broker', () => {
    const view = makeFakeView(7);
    const captured = captureOrigin({ viewWebContents: () => view.webContents });

    fireReply(mainFrameEvent(7), { anything: 'at all' });

    expect(captured.payloads).toEqual([{ anything: 'at all' }]);
  });
});

describe('createWebviewBridgeTransport - preload readiness', () => {
  it('is not ready before the preload has announced itself', () => {
    const view = makeFakeView(7);
    const transport = createWebviewBridgeTransport({ viewWebContents: () => view.webContents });

    expect(transport.isReady()).toBe(false);
  });

  it('is ready once the trusted view main frame announces, and stays ready', () => {
    const view = makeFakeView(7);
    const transport = createWebviewBridgeTransport({ viewWebContents: () => view.webContents });

    fireReady(mainFrameEvent(7));

    expect(transport.isReady()).toBe(true);
  });

  it('does not become ready from another WebContents, however well-formed', () => {
    const view = makeFakeView(7);
    const transport = createWebviewBridgeTransport({ viewWebContents: () => view.webContents });

    fireReady(mainFrameEvent(8));

    expect(transport.isReady()).toBe(false);
  });

  it('does not become ready from a sub-frame of the AEM view', () => {
    const view = makeFakeView(7);
    const transport = createWebviewBridgeTransport({ viewWebContents: () => view.webContents });

    fireReady(subFrameEvent(7));

    expect(transport.isReady()).toBe(false);
  });

  it('stops being ready when the view is replaced by one that has not announced', () => {
    // A rebuilt pane is a new WebContents whose preload has not run yet; a
    // readiness captured once would wrongly report the new view as usable.
    let view = makeFakeView(7);
    const transport = createWebviewBridgeTransport({ viewWebContents: () => view.webContents });
    fireReady(mainFrameEvent(7));
    expect(transport.isReady()).toBe(true);

    view = makeFakeView(99);

    expect(transport.isReady()).toBe(false);
  });

  it('removes the ready listener on dispose', () => {
    const view = makeFakeView(7);
    const transport = createWebviewBridgeTransport({ viewWebContents: () => view.webContents });

    transport.dispose();

    expect(ipcListeners.get(WEBVIEW_BRIDGE_READY_CHANNEL)?.size ?? 0).toBe(0);
  });
});

describe('createWebviewBridgeTransport - teardown', () => {
  it('stops receiving replies once the subscription is released', () => {
    const view = makeFakeView(7);
    const received: unknown[] = [];
    const transport = createWebviewBridgeTransport({ viewWebContents: () => view.webContents });
    const unsubscribe = transport.onReply((payload) => received.push(payload));

    unsubscribe();
    fireReply(mainFrameEvent(7), { kind: 'cancelled', requestId: 'req-a' });

    expect(received).toEqual([]);
    expect(ipcListeners.get(WEBVIEW_BRIDGE_REPLY_CHANNEL)?.size ?? 0).toBe(0);
  });

  it('leaves no listener behind after dispose, and tolerates being disposed twice', () => {
    const view = makeFakeView(7);
    const transport = createWebviewBridgeTransport({ viewWebContents: () => view.webContents });
    transport.onReply(() => {});

    transport.dispose();
    expect(() => transport.dispose()).not.toThrow();

    expect(ipcListeners.get(WEBVIEW_BRIDGE_REPLY_CHANNEL)?.size ?? 0).toBe(0);
  });
});
