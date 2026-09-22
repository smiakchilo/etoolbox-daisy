import type {
  AemBridgeCancelCommand,
  AemBridgeFetchCommand,
  AemBridgeReply,
} from '../../shared/contracts/aemBridge';
import { aemBridgeReplySchema } from '../../shared/contracts/aemBridge';
import type { Clock, CurrentAemContext, ToolRequestEnvelope } from '../../shared';
import { classifyStaleness, isDeadlineExpired } from '../../shared';
import type { BrokerOutcome } from '../../shared';
import { toLoggableUrl, type LogOutcome, type Logger } from '../logger';

export type { BrokerOutcome };

/**
 * Main-side half of the private AEM bridge (implementation-plan.md step 06).
 *
 * The AEM view holds a live HttpOnly session cookie that the main process
 * must never see; the preload fetches on main's behalf and reports back over
 * IPC. This module owns the *policy* around that round trip - concurrency,
 * staleness, deadlines, and who is allowed to answer - and nothing else. It
 * takes every collaborator as an injected seam and never imports `electron`,
 * so it is exercisable under plain vitest with hand-built fakes, the same
 * discipline `responseValidation.ts` uses for the HTTP-semantics half of this
 * same feature.
 */

/** Whether a reply arrived from the one WebContents we asked, in its main frame. */
export interface BridgeReplyOrigin {
  readonly isTrustedAemView: boolean;
  readonly isMainFrame: boolean;
}

export interface BridgeTransport {
  /** Delivers a fetch command to the AEM view. Returns false when there is no live view to send to. */
  sendFetch(command: AemBridgeFetchCommand): boolean;
  sendCancel(command: AemBridgeCancelCommand): void;
  /**
   * Whether the live AEM view's preload has announced it can answer fetches
   * (see `AEM_BRIDGE_READY_CHANNEL`). Optional so a test double need not model
   * it; when absent the broker assumes ready, preserving the pre-handshake
   * behaviour. A live transport always supplies it, and returning `false` lets
   * the broker fail a request immediately instead of waiting out the deadline
   * for a reply that can never come.
   */
  isReady?(): boolean;
  /** Registers the reply listener. Returns an unsubscribe function. */
  onReply(listener: (rawReply: unknown, origin: BridgeReplyOrigin) => void): () => void;
}

export interface BrokerDeps {
  readonly transport: BridgeTransport;
  readonly clock: Clock;
  /** Schedules `fn` after `delayMs`; returns a cancel function. Injected so tests need no fake timers. */
  readonly setTimer: (fn: () => void, delayMs: number) => () => void;
  /** The live serverRevision + navigationEpoch, read fresh at every decision point. */
  readonly currentContext: () => CurrentAemContext;
  /**
   * Optional diagnostics sink. When supplied, every request logs
   * `AEM_REQUEST_STARTED` when it reaches the view and `AEM_REQUEST_COMPLETED`
   * when it settles, with its duration, HTTP status (when there is one) and a
   * closed-vocabulary outcome - so `logs/app.log` can answer "did the AEM
   * request actually succeed", which the chat journal deliberately cannot
   * (it records normalized agent events, not HTTP results).
   */
  readonly logger?: Logger;
}

/** Maps a raw broker verdict onto the logger's closed outcome vocabulary. */
function toLogOutcome(outcome: BrokerOutcome): LogOutcome {
  switch (outcome.kind) {
    case 'response':
      return outcome.status >= 200 && outcome.status < 400 ? 'success' : 'failure';
    case 'timeout':
      return 'timeout';
    case 'cancelled':
      return 'cancelled';
    case 'blocked':
    case 'network_error':
    case 'stale':
    case 'no_view':
    case 'bridge_unavailable':
      return 'failure';
  }
}

/**
 * The verdict of one bridge round trip is defined in `src/shared/tools/types.ts`
 * (a tool module depends on this shape) and re-exported at the top of this file
 * so the broker's own consumers keep a single import site.
 */
export interface AemBridgeBroker {
  /** Issues one fetch. Resolves exactly once. */
  request(envelope: ToolRequestEnvelope, url: string): Promise<BrokerOutcome>;
  /**
   * Cancels the in-flight request and every queued one. Used on stop, chat
   * switch, and server switch. Takes no reason argument on purpose: nothing
   * here reads one, and a parameter nobody reads is indistinguishable from a
   * promise the module does not keep.
   */
  cancelAll(): void;
  /** Releases the reply listener. */
  dispose(): void;
}

interface PendingRequest {
  readonly envelope: ToolRequestEnvelope;
  readonly url: string;
  readonly resolve: (outcome: BrokerOutcome) => void;
  /** When the request was enqueued, so `AEM_REQUEST_COMPLETED` can report total wait. */
  readonly queuedAt: number;
  settled: boolean;
  cancelTimer: (() => void) | undefined;
}

function replyToOutcome(reply: AemBridgeReply): BrokerOutcome {
  switch (reply.kind) {
    case 'response':
      return {
        kind: 'response',
        status: reply.status,
        contentType: reply.contentType,
        bodyText: reply.bodyText,
      };
    case 'blocked':
      return { kind: 'blocked', reason: reply.reason };
    case 'network_error':
      return { kind: 'network_error', message: reply.message };
    case 'cancelled':
      return { kind: 'cancelled' };
  }
}

export function createAemBridgeBroker(deps: BrokerDeps): AemBridgeBroker {
  // requirements-decisions.md section 6: exactly one AEM request in flight,
  // application-wide. `inFlight` is the single request currently sent to the
  // view; everything else waits here in arrival order.
  const queue: PendingRequest[] = [];
  let inFlight: PendingRequest | undefined;

  /**
   * The only place a pending request's promise is ever resolved.
   *
   * Every step below is independently idempotent - `resolve` is a no-op on an
   * already-resolved promise, `cancelTimer` nulls itself, and the `inFlight`
   * clear is conditional - so the `settled` flag is not, on its own, what
   * makes a double settle harmless. It is recorded because the *timer*
   * callback reads it to avoid emitting a cancel command for a request that
   * already has an outcome, and because a future side effect added here
   * would not be idempotent for free. Anything added below must either be
   * idempotent in its own right or be covered by a test that fails when this
   * guard is removed; at present no test does, which is a deliberate
   * statement about this function rather than an oversight.
   */
  function settle(entry: PendingRequest, outcome: BrokerOutcome): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.cancelTimer?.();
    entry.cancelTimer = undefined;
    if (inFlight === entry) inFlight = undefined;
    deps.logger?.info('AEM_REQUEST_COMPLETED', {
      durationMs: Math.max(0, deps.clock() - entry.queuedAt),
      outcome: toLogOutcome(outcome),
      ...(outcome.kind === 'response' && outcome.status >= 100 && outcome.status <= 599
        ? { statusCode: outcome.status }
        : {}),
      ids: { requestId: entry.envelope.requestId },
      url: toLoggableUrl(entry.url),
    });
    entry.resolve(outcome);
  }

  /**
   * Drives the queue forward. Only ever sends the head of the queue once
   * nothing is in flight, so "concurrency exactly 1" is a property of this
   * loop rather than something every caller has to remember to preserve.
   * Every exit from a request's pending state - reply, timeout, cancel,
   * no-view - calls back into this function so the next queued request (if
   * any) gets its turn.
   */
  function pump(): void {
    if (inFlight !== undefined) return;
    while (queue.length > 0) {
      const entry = queue.shift();
      if (entry === undefined) break;

      if (isDeadlineExpired(entry.envelope.deadlineMs, deps.clock)) {
        settle(entry, { kind: 'timeout' });
        continue;
      }

      // Checked again immediately before sending: a request can sit behind
      // another one in the queue long enough for the user to navigate or
      // switch servers, and a request built against a document that is no
      // longer current must never reach the page at all.
      const staleness = classifyStaleness(entry.envelope, deps.currentContext());
      if (staleness !== 'fresh') {
        settle(entry, { kind: 'stale', status: staleness });
        continue;
      }

      // The view is live but its preload has never announced it can answer - a
      // build/packaging fault, not an AEM one. Failing here, rather than
      // sending into a `WebContents` that has no listener and waiting out the
      // whole deadline for a reply that can never come, is what keeps this from
      // masquerading as an AEM timeout.
      if (deps.transport.isReady !== undefined && !deps.transport.isReady()) {
        settle(entry, { kind: 'bridge_unavailable' });
        continue;
      }

      inFlight = entry;
      const remainingMs = entry.envelope.deadlineMs - deps.clock();
      entry.cancelTimer = deps.setTimer(() => {
        // `settle` below is idempotent regardless, but guarding here too means
        // a timer that fires despite having been "cancelled" (the class of
        // race this codebase has hit before) never sends a pointless cancel
        // command for a request that already has a different outcome.
        if (entry.settled) return;
        deps.transport.sendCancel({ requestId: entry.envelope.requestId });
        settle(entry, { kind: 'timeout' });
        pump();
      }, remainingMs);

      const sent = deps.transport.sendFetch({
        requestId: entry.envelope.requestId,
        url: entry.url,
      });
      if (!sent) {
        settle(entry, { kind: 'no_view' });
        continue;
      }
      deps.logger?.info('AEM_REQUEST_STARTED', {
        ids: { requestId: entry.envelope.requestId },
        url: toLoggableUrl(entry.url),
      });
      return;
    }
  }

  function cancelPending(): void {
    if (inFlight !== undefined) {
      const current = inFlight;
      deps.transport.sendCancel({ requestId: current.envelope.requestId });
      settle(current, { kind: 'cancelled' });
    }
    // Queued requests were never sent, so they need no cancel command - only
    // the resolution the caller (stop / chat switch / server switch) needs.
    const stranded = queue.splice(0, queue.length);
    for (const entry of stranded) settle(entry, { kind: 'cancelled' });
  }

  const unsubscribe = deps.transport.onReply((rawReply, origin) => {
    if (inFlight === undefined) return;
    const current = inFlight;

    // Evaluated per reply, not captured at subscription time - see the
    // history on `BridgeReplyOrigin`. A forged or misrouted reply leaves the
    // pending request pending rather than failing it: the sender it was
    // actually meant for (or, failing that, the deadline) still gets to
    // decide the outcome, so an untrusted origin cannot force a result.
    if (!origin.isTrustedAemView || !origin.isMainFrame) return;

    const parsed = aemBridgeReplySchema.safeParse(rawReply);
    if (!parsed.success) return;
    if (parsed.data.requestId !== current.envelope.requestId) return;

    // Checked again on arrival, not only before sending: the view may have
    // navigated away or the server may have switched while the fetch was in
    // flight, and a reply from a document that is no longer current must not
    // be honoured just because it happens to carry the right request id.
    const staleness = classifyStaleness(current.envelope, deps.currentContext());
    if (staleness !== 'fresh') {
      settle(current, { kind: 'stale', status: staleness });
      pump();
      return;
    }

    settle(current, replyToOutcome(parsed.data));
    pump();
  });

  return {
    request(envelope, url) {
      return new Promise<BrokerOutcome>((resolve) => {
        const entry: PendingRequest = {
          envelope,
          url,
          resolve,
          queuedAt: deps.clock(),
          settled: false,
          cancelTimer: undefined,
        };
        queue.push(entry);
        pump();
      });
    },
    cancelAll() {
      cancelPending();
    },
    dispose() {
      unsubscribe();
      cancelPending();
    },
  };
}
