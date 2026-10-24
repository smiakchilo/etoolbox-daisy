import { ipcMain, type IpcMainEvent, type WebContents } from 'electron';
import {
  WEBVIEW_BRIDGE_CANCEL_CHANNEL,
  WEBVIEW_BRIDGE_FETCH_CHANNEL,
  WEBVIEW_BRIDGE_READ_CHANNEL,
  WEBVIEW_BRIDGE_READY_CHANNEL,
  WEBVIEW_BRIDGE_REPLY_CHANNEL,
} from '../../shared/contracts/webviewBridge';
import type { BridgeReplyOrigin, BridgeTransport } from './bridgeBroker';

/**
 * The Electron half of the bridge: it moves commands and replies between
 * the main process and the browser view's preload, and answers exactly one
 * question of its own - did this reply come from the view we asked?
 *
 * That question is answered by comparing against
 * {@link WebviewBridgeTransportDeps.viewWebContents}, which is a *function*,
 * resolved fresh on every send and every reply. This is not incidental. In
 * step 05 an IPC guard captured a `webContents.id` at registration time and
 * consequently could never authorize the Settings window, which is created
 * later - and every unit test passed regardless, because each test supplied
 * the id it expected. A capture here would be worse than useless in the same
 * way: the browser view is replaced whenever the pane is rebuilt, so a captured
 * id would either reject the live view or, after id reuse, accept something
 * that is not it.
 */
export interface WebviewBridgeTransportDeps {
  /**
   * The browser view's live `WebContents`, or `undefined` when no view exists.
   * Called at the moment of every decision - never cached by this module.
   */
  readonly viewWebContents: () => WebContents | undefined;
}

export interface WebviewBridgeTransportHandle extends BridgeTransport {
  /** Always implemented on the live transport, unlike the optional seam on {@link BridgeTransport}. */
  isReady(): boolean;
  /** Removes the reply listener. Safe to call more than once. */
  dispose(): void;
}

function liveTarget(deps: WebviewBridgeTransportDeps): WebContents | undefined {
  const target = deps.viewWebContents();
  if (target === undefined || target.isDestroyed()) return undefined;
  return target;
}

/**
 * Derives the two facts the broker gates on. Split out so the trust rule is
 * one readable expression rather than something spread through the listener.
 *
 * A reply from a destroyed or absent view is untrusted rather than merely
 * unmatched: there is no live view, so nothing could legitimately be
 * answering, and treating the comparison as "undefined === undefined" would
 * turn the absence of a view into a pass.
 */
function replyOrigin(event: IpcMainEvent, deps: WebviewBridgeTransportDeps): BridgeReplyOrigin {
  const target = liveTarget(deps);
  const frame = event.senderFrame;
  return {
    isTrustedView: target !== undefined && event.sender.id === target.id,
    isMainFrame: frame !== null && frame.top === frame,
  };
}

export function createWebviewBridgeTransport(
  deps: WebviewBridgeTransportDeps,
): WebviewBridgeTransportHandle {
  let replyListener: ((event: IpcMainEvent, payload: unknown) => void) | undefined;

  /**
   * The `WebContents` id whose preload last announced it could answer fetches.
   * `undefined` until the first announcement, which is exactly the state a
   * missing or broken preload leaves it in forever. Compared against the
   * *live* view on every read (never cached), for the same reason replies are:
   * a rebuilt pane is a new `WebContents` whose preload has not announced yet.
   */
  let readyWebContentsId: number | undefined;

  function send(channel: string, payload: unknown): boolean {
    const target = liveTarget(deps);
    if (target === undefined) return false;
    target.send(channel, payload);
    return true;
  }

  // Registered once, at construction, and independent of `onReply`: readiness
  // is a fact about the view, not about whether a caller is currently awaiting
  // a reply. Trust is decided by the same rule replies use, so a stray
  // announcement from any other `WebContents` or sub-frame cannot mark the
  // bridge ready.
  const readyListener = (event: IpcMainEvent): void => {
    const origin = replyOrigin(event, deps);
    if (!origin.isTrustedView || !origin.isMainFrame) return;
    readyWebContentsId = event.sender.id;
  };
  ipcMain.on(WEBVIEW_BRIDGE_READY_CHANNEL, readyListener);

  return {
    sendFetch(command) {
      return send(WEBVIEW_BRIDGE_FETCH_CHANNEL, command);
    },
    sendRead(command) {
      return send(WEBVIEW_BRIDGE_READ_CHANNEL, command);
    },
    sendCancel(command) {
      // Nothing to report when the view is already gone: a view that no longer
      // exists has no fetch left to abort, and the broker has already settled
      // whatever prompted the cancel.
      send(WEBVIEW_BRIDGE_CANCEL_CHANNEL, command);
    },
    isReady() {
      const target = liveTarget(deps);
      return target !== undefined && target.id === readyWebContentsId;
    },
    onReply(listener) {
      const handler = (event: IpcMainEvent, payload: unknown): void => {
        listener(payload, replyOrigin(event, deps));
      };
      replyListener = handler;
      ipcMain.on(WEBVIEW_BRIDGE_REPLY_CHANNEL, handler);
      return () => {
        if (replyListener !== handler) return;
        ipcMain.removeListener(WEBVIEW_BRIDGE_REPLY_CHANNEL, handler);
        replyListener = undefined;
      };
    },
    dispose() {
      ipcMain.removeListener(WEBVIEW_BRIDGE_READY_CHANNEL, readyListener);
      if (replyListener === undefined) return;
      ipcMain.removeListener(WEBVIEW_BRIDGE_REPLY_CHANNEL, replyListener);
      replyListener = undefined;
    },
  };
}
