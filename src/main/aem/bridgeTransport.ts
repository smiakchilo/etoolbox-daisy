import { ipcMain, type IpcMainEvent, type WebContents } from 'electron';
import {
  AEM_BRIDGE_CANCEL_CHANNEL,
  AEM_BRIDGE_FETCH_CHANNEL,
  AEM_BRIDGE_REPLY_CHANNEL,
} from '../../shared/contracts/aemBridge';
import type { BridgeReplyOrigin, BridgeTransport } from './bridgeBroker';

/**
 * The Electron half of the AEM bridge: it moves commands and replies between
 * the main process and the AEM view's preload, and answers exactly one
 * question of its own - did this reply come from the view we asked?
 *
 * That question is answered by comparing against
 * {@link AemBridgeTransportDeps.aemWebContents}, which is a *function*,
 * resolved fresh on every send and every reply. This is not incidental. In
 * step 05 an IPC guard captured a `webContents.id` at registration time and
 * consequently could never authorize the Settings window, which is created
 * later - and every unit test passed regardless, because each test supplied
 * the id it expected. A capture here would be worse than useless in the same
 * way: the AEM view is replaced whenever the pane is rebuilt, so a captured
 * id would either reject the live view or, after id reuse, accept something
 * that is not it.
 */
export interface AemBridgeTransportDeps {
  /**
   * The AEM view's live `WebContents`, or `undefined` when no view exists.
   * Called at the moment of every decision - never cached by this module.
   */
  readonly aemWebContents: () => WebContents | undefined;
}

export interface AemBridgeTransportHandle extends BridgeTransport {
  /** Removes the reply listener. Safe to call more than once. */
  dispose(): void;
}

function liveTarget(deps: AemBridgeTransportDeps): WebContents | undefined {
  const target = deps.aemWebContents();
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
function replyOrigin(event: IpcMainEvent, deps: AemBridgeTransportDeps): BridgeReplyOrigin {
  const target = liveTarget(deps);
  const frame = event.senderFrame;
  return {
    isTrustedAemView: target !== undefined && event.sender.id === target.id,
    isMainFrame: frame !== null && frame.top === frame,
  };
}

export function createAemBridgeTransport(deps: AemBridgeTransportDeps): AemBridgeTransportHandle {
  let replyListener: ((event: IpcMainEvent, payload: unknown) => void) | undefined;

  function send(channel: string, payload: unknown): boolean {
    const target = liveTarget(deps);
    if (target === undefined) return false;
    target.send(channel, payload);
    return true;
  }

  return {
    sendFetch(command) {
      return send(AEM_BRIDGE_FETCH_CHANNEL, command);
    },
    sendCancel(command) {
      // Nothing to report when the view is already gone: a view that no longer
      // exists has no fetch left to abort, and the broker has already settled
      // whatever prompted the cancel.
      send(AEM_BRIDGE_CANCEL_CHANNEL, command);
    },
    onReply(listener) {
      const handler = (event: IpcMainEvent, payload: unknown): void => {
        listener(payload, replyOrigin(event, deps));
      };
      replyListener = handler;
      ipcMain.on(AEM_BRIDGE_REPLY_CHANNEL, handler);
      return () => {
        if (replyListener !== handler) return;
        ipcMain.removeListener(AEM_BRIDGE_REPLY_CHANNEL, handler);
        replyListener = undefined;
      };
    },
    dispose() {
      if (replyListener === undefined) return;
      ipcMain.removeListener(AEM_BRIDGE_REPLY_CHANNEL, replyListener);
      replyListener = undefined;
    },
  };
}
