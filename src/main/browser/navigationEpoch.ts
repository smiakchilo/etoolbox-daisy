import type { WebContents } from 'electron';

/**
 * Why an epoch was invalidated. Kept as a closed union rather than a free
 * string because these values are logged and asserted on: a tool result that
 * was discarded needs to say *which* event discarded it, and "the page
 * navigated" is a materially different diagnosis from "you switched servers".
 */
export type NavigationEpochBumpReason =
  'document_navigation' | 'server_switch' | 'render_process_gone' | 'view_destroyed';

export interface NavigationEpochChange {
  readonly epoch: number;
  readonly reason: NavigationEpochBumpReason;
}

export interface NavigationEpochTracker {
  /**
   * The epoch an outgoing tool request is stamped with, and the value a reply
   * must still match to be honoured.
   */
  current(): number;
  /** Invalidates every in-flight request and returns the new epoch. */
  bump(reason: NavigationEpochBumpReason): number;
  /** Notified after every bump. Returns an unsubscribe function. */
  subscribe(listener: (change: NavigationEpochChange) => void): () => void;
}

/**
 * Tracks which *document* the AEM view is currently showing
 * (implementation-plan.md step 06).
 *
 * The epoch is the mechanism that stops a late reply from a page that has
 * since been navigated away from - or from a server that has since been
 * switched - completing a request that was issued against a different
 * document. `classifyStaleness` in `src/shared/contracts/toolContracts.ts`
 * compares a request envelope's epoch against the value here with a symmetric
 * `!==`, so this counter must only ever move forward; nothing may reset it.
 *
 * It deliberately does *not* bump on same-document navigation (fragment
 * changes, `history.pushState`). Those keep the same document, the same origin
 * and the same script context, so a reply issued before one is still a reply
 * from the page that was asked - and AEM's authoring UI performs them
 * constantly, so invalidating on them would make the tool useless in practice.
 */
export function createNavigationEpochTracker(initialEpoch = 0): NavigationEpochTracker {
  let epoch = initialEpoch;
  const listeners = new Set<(change: NavigationEpochChange) => void>();

  return {
    current: () => epoch,
    bump(reason) {
      epoch += 1;
      const change: NavigationEpochChange = { epoch, reason };
      // Copied before iterating so a listener that unsubscribes itself - which
      // the request broker does when it cancels - cannot mutate the set mid-loop.
      for (const listener of [...listeners]) listener(change);
      return epoch;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Wires an existing tracker to a live `WebContents`. Split from the tracker
 * itself so the invalidation rules above can be unit-tested without Electron.
 *
 * `did-start-navigation` rather than `did-navigate` is the primary trigger on
 * purpose: it fires as the frame *begins* leaving the current document, which
 * closes the window in which a reply from the outgoing document could still
 * arrive and be treated as current. `did-navigate` is kept as a backstop for
 * navigations whose start this listener never observed (for example one
 * already in flight when the view was attached).
 */
export function attachNavigationEpochTracking(
  webContents: WebContents,
  tracker: NavigationEpochTracker,
): () => void {
  // Reads the `details` event object rather than the trailing positional
  // arguments, which Electron 44 marks `@deprecated`. The positional form also
  // spells the same-document flag `isInPlace`, which is easy to misread.
  const onStartNavigation = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
  ): void => {
    // Sub-frame navigation leaves the main frame's document - and therefore the
    // context a reply comes from - intact, so it must not invalidate anything.
    if (!details.isMainFrame || details.isSameDocument) return;
    tracker.bump('document_navigation');
  };
  const onNavigate = (): void => {
    tracker.bump('document_navigation');
  };
  const onRenderProcessGone = (): void => {
    tracker.bump('render_process_gone');
  };
  const onDestroyed = (): void => {
    tracker.bump('view_destroyed');
  };

  webContents.on('did-start-navigation', onStartNavigation);
  webContents.on('did-navigate', onNavigate);
  webContents.on('render-process-gone', onRenderProcessGone);
  webContents.once('destroyed', onDestroyed);

  return () => {
    if (webContents.isDestroyed()) return;
    webContents.off('did-start-navigation', onStartNavigation);
    webContents.off('did-navigate', onNavigate);
    webContents.off('render-process-gone', onRenderProcessGone);
    webContents.off('destroyed', onDestroyed);
  };
}
