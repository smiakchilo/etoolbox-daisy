import type { WebContents } from 'electron';

/**
 * Why an epoch was invalidated. Kept as a closed union rather than a free
 * string because these values are logged and asserted on: a tool result that
 * was discarded needs to say *which* event discarded it, and "the page
 * navigated" is a materially different diagnosis from "you switched servers".
 */
export type NavigationEpochBumpReason =
  'document_navigation' | 'server_switch' | 'render_process_gone' | 'view_destroyed';

/**
 * Who caused an epoch invalidation. A *user* navigation makes the agent's
 * in-flight work moot, so it aborts the turn (`agentComposition.ts`); an
 * *agent* navigation (the `browser_navigate` tool moving the pane to resolve a
 * page on another host) does not - the turn is doing exactly what it asked for.
 */
export type NavigationEpochInitiator = 'user' | 'agent';

export interface NavigationEpochChange {
  readonly epoch: number;
  readonly reason: NavigationEpochBumpReason;
  readonly initiator: NavigationEpochInitiator;
}

export interface NavigationEpochTracker {
  /**
   * The epoch an outgoing tool request is stamped with, and the value a reply
   * must still match to be honoured.
   */
  current(): number;
  /**
   * Invalidates every in-flight request and returns the new epoch. `initiator`
   * defaults to `'user'` - the safe default for any caller that does not know
   * it is acting for the agent.
   */
  bump(reason: NavigationEpochBumpReason, initiator?: NavigationEpochInitiator): number;
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
    bump(reason, initiator = 'user') {
      epoch += 1;
      const change: NavigationEpochChange = { epoch, reason, initiator };
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

export interface NavigationEpochTrackingOptions {
  /**
   * Whether a main-frame document navigation stays on the currently active
   * AEM server's origin.
   *
   * A same-origin navigation (for example following a link inside the AEM
   * authoring UI, or a reload) changes the *page*, not the AEM *context*: the
   * origin, the authenticated session and therefore the target of any in-flight
   * tool request are unchanged. Such a navigation must neither invalidate an
   * in-flight tool request nor cancel the agent's turn, so it does not bump the
   * epoch at all. A cross-origin navigation (an SSO/IdP hop, or a server
   * switch) does change the context and still invalidates.
   *
   * Defaults to `() => false`, i.e. every main-frame navigation invalidates -
   * the strict behaviour, and the only safe default for a caller that has no
   * notion of "the active server".
   */
  readonly isSameOriginNavigation?: (url: string) => boolean;
  /**
   * Attributes a *bumping* main-frame navigation to its initiator, read at the
   * moment of the bump. Returns `'agent'` only while the application is
   * deliberately navigating the pane for the agent (the `browser_navigate`
   * tool), so the switch's own load - and any SSO redirect hop it follows - is
   * not mistaken for the user leaving the page. Defaults to `'user'`.
   */
  readonly bumpInitiator?: () => NavigationEpochInitiator;
  /**
   * Observability hook, called for a main-frame navigation that did *not*
   * invalidate. Never called for one that did - that path is visible as the
   * epoch change itself.
   */
  readonly onSameOriginNavigation?: (url: string) => void;
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
  options: NavigationEpochTrackingOptions = {},
): () => void {
  const isSameOrigin = options.isSameOriginNavigation ?? ((): boolean => false);
  const bumpInitiator = options.bumpInitiator ?? ((): NavigationEpochInitiator => 'user');

  /** Same-origin navigations are reported but not bumped - see the option's doc. */
  const handleMainFrameNavigation = (url: string): void => {
    if (isSameOrigin(url)) {
      options.onSameOriginNavigation?.(url);
      return;
    }
    tracker.bump('document_navigation', bumpInitiator());
  };

  // Reads the `details` event object rather than the trailing positional
  // arguments, which Electron 44 marks `@deprecated`. The positional form also
  // spells the same-document flag `isInPlace`, which is easy to misread.
  const onStartNavigation = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
  ): void => {
    // Sub-frame navigation leaves the main frame's document - and therefore the
    // context a reply comes from - intact, so it must not invalidate anything.
    if (!details.isMainFrame || details.isSameDocument) return;
    handleMainFrameNavigation(details.url);
  };
  const onNavigate = (_event: Electron.Event, url: string): void => {
    handleMainFrameNavigation(url);
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
