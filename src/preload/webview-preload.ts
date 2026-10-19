import { ipcRenderer } from 'electron';
import {
  WEBVIEW_BRIDGE_CANCEL_CHANNEL,
  WEBVIEW_BRIDGE_FETCH_CHANNEL,
  WEBVIEW_BRIDGE_READY_CHANNEL,
  WEBVIEW_BRIDGE_REPLY_CHANNEL,
  webviewBridgeCancelCommandSchema,
  webviewBridgeFetchCommandSchema,
} from '../shared/contracts/webviewBridge';
import { performBridgeFetch } from './bridgeFetch';

/**
 * Preload for the browser view - the private bridge of implementation-plan.md
 * step 06.
 *
 * It deliberately calls `contextBridge.exposeInMainWorld` **not at all**. The
 * page showing remote content gets nothing: no bridge object, no version
 * probe, no capability to start or observe a tool fetch. Everything here is
 * driven by the main process over IPC and lives entirely in the isolated
 * world, which page script cannot reach. An earlier revision of this file
 * exposed an inert `{ apiVersion: 1 }` marker as a placeholder; that has been
 * removed rather than grown, because "expose nothing to the page's main
 * world" is a property worth being able to state without exceptions.
 *
 * Only the two commands below are accepted, both validated before use. There
 * is no generic "run this" entry point, and no way for a command to name a
 * function, a module, or anything other than a URL to fetch.
 */

/** Abort handles for in-flight fetches, keyed by the request id main assigned. */
const inFlight = new Map<string, AbortController>();

ipcRenderer.on(WEBVIEW_BRIDGE_FETCH_CHANNEL, (_event, rawCommand: unknown) => {
  const parsed = webviewBridgeFetchCommandSchema.safeParse(rawCommand);
  // A malformed command is dropped in silence on purpose: there is no reply id
  // to answer with, and inventing one would let a garbled message complete
  // some unrelated pending request. Main's own deadline covers the case.
  if (!parsed.success) return;
  const command = parsed.data;

  // A repeated id would otherwise orphan the first controller and make the
  // first request uncancellable. Main enforces concurrency 1, so this is a
  // consistency guard rather than an expected path.
  if (inFlight.has(command.requestId)) return;

  const controller = new AbortController();
  inFlight.set(command.requestId, controller);

  void performBridgeFetch(
    command,
    { fetch: globalThis.fetch.bind(globalThis), currentOrigin: globalThis.location.origin },
    controller.signal,
  )
    .then((reply) => {
      // Dropped if the entry is gone: that means cancellation already ran and
      // main is no longer waiting for this id, so replying could complete a
      // request that has since been superseded.
      if (!inFlight.delete(command.requestId)) return;
      ipcRenderer.send(WEBVIEW_BRIDGE_REPLY_CHANNEL, reply);
    })
    .catch((error: unknown) => {
      if (!inFlight.delete(command.requestId)) return;
      ipcRenderer.send(WEBVIEW_BRIDGE_REPLY_CHANNEL, {
        kind: 'network_error',
        requestId: command.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
});

ipcRenderer.on(WEBVIEW_BRIDGE_CANCEL_CHANNEL, (_event, rawCommand: unknown) => {
  const parsed = webviewBridgeCancelCommandSchema.safeParse(rawCommand);
  if (!parsed.success) return;
  const controller = inFlight.get(parsed.data.requestId);
  if (controller === undefined) return;
  // Removed before aborting so the `.then`/`.catch` above find no entry and
  // stay silent: main asked to stop caring about this id, so it must not
  // receive a late reply for it.
  inFlight.delete(parsed.data.requestId);
  controller.abort();
});

// Announced only after both listeners are registered, so main never treats
// "ready" as true for a document that could not yet answer a fetch. Main uses
// this to fail a request immediately when the preload never loaded, instead of
// letting it look like a request timeout. Sent once per document; a navigation
// re-runs this file, which re-registers and re-announces.
ipcRenderer.send(WEBVIEW_BRIDGE_READY_CHANNEL, {});
