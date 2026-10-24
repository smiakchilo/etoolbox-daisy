import { describe, expect, it } from 'vitest';
import {
  createWebviewBridgeBroker,
  type BridgeReplyOrigin,
  type BridgeTransport,
  type BrokerDeps,
  type BrokerOutcome,
} from '../../../../src/main/webview/bridgeBroker';
import { type CurrentBridgeContext } from '../../../../src/shared';
import type {
  WebviewBridgeFetchCommand,
  WebviewBridgeReadCommand,
} from '../../../../src/shared/contracts/webviewBridge';
import { toolRequestEnvelopeSchema, type ToolRequestEnvelope } from '../../../support/toolUnions';
import type { Logger } from '../../../../src/main/logger';
import type {
  ToolHttpLogger,
  ToolHttpRequestRecord,
  ToolHttpResponseRecord,
} from '../../../../src/main/webview/toolHttpLog';

/** A logger double that records every line's code and fields. */
function recordingLogger(): { logger: Logger; lines: { code: string; fields: unknown }[] } {
  const lines: { code: string; fields: unknown }[] = [];
  const logger = {
    info: (code: string, fields?: unknown) => lines.push({ code, fields }),
    warn: (code: string, fields?: unknown) => lines.push({ code, fields }),
    error: (code: string, fields?: unknown) => lines.push({ code, fields }),
    getHealth: () => ({ writeFailureCount: 0, lastFailureCode: null, rotationCount: 0 }),
  } as unknown as Logger;
  return { logger, lines };
}

/** A tool-log double that records the request/response records it is given. */
function recordingToolLogger(): {
  toolLogger: ToolHttpLogger;
  requests: ToolHttpRequestRecord[];
  responses: ToolHttpResponseRecord[];
} {
  const requests: ToolHttpRequestRecord[] = [];
  const responses: ToolHttpResponseRecord[] = [];
  const toolLogger = {
    request: (record: ToolHttpRequestRecord) => requests.push(record),
    response: (record: ToolHttpResponseRecord) => responses.push(record),
    getHealth: () => ({ writeFailureCount: 0, lastFailureCode: null, rotationCount: 0 }),
  } as unknown as ToolHttpLogger;
  return { toolLogger, requests, responses };
}

const TRUSTED_ORIGIN: BridgeReplyOrigin = { isTrustedView: true, isMainFrame: true };

function makeEnvelope(
  requestId: string,
  overrides: Partial<{ serverRevision: number; navigationEpoch: number; deadlineMs: number }> = {},
): ToolRequestEnvelope {
  return toolRequestEnvelopeSchema.parse({
    operation: 'aem_get_json',
    requestId,
    chatId: 'chat-1',
    turnId: 'turn-1',
    serverId: 'server-1',
    serverRevision: overrides.serverRevision ?? 0,
    navigationEpoch: overrides.navigationEpoch ?? 0,
    deadlineMs: overrides.deadlineMs ?? 100_000,
    args: { path: '/content/foo' },
  });
}

interface FakeTimer {
  readonly delayMs: number;
  readonly fn: () => void;
  cancelled: boolean;
}

/**
 * A hand-built fake of every seam `bridgeBroker` depends on. Kept as plain
 * recording state rather than `vi.fn()` mocks, matching the harness style
 * already used for `ServerSwitchController` in this repo - the assertions
 * that matter here are call order and call counts, both of which a plain
 * array shows plainly.
 */
function createHarness(options: { readonly maxConcurrentRequests?: number } = {}) {
  const sendFetchCalls: string[] = [];
  const sendFetchCommands: WebviewBridgeFetchCommand[] = [];
  const sendReadCommands: WebviewBridgeReadCommand[] = [];
  const sendCancelCalls: string[] = [];
  const timers: FakeTimer[] = [];
  let replyListener: ((rawReply: unknown, origin: BridgeReplyOrigin) => void) | undefined;
  let now = 0;
  let context: CurrentBridgeContext = { serverRevision: 0, navigationEpoch: 0 };
  const blockedRequestIds = new Set<string>();
  let ready = true;

  const transport: BridgeTransport = {
    sendFetch(command) {
      sendFetchCalls.push(command.requestId);
      sendFetchCommands.push(command);
      return !blockedRequestIds.has(command.requestId);
    },
    sendRead(command) {
      sendReadCommands.push(command);
      return !blockedRequestIds.has(command.requestId);
    },
    sendCancel(command) {
      sendCancelCalls.push(command.requestId);
    },
    isReady: () => ready,
    onReply(listener) {
      replyListener = listener;
      return () => {
        replyListener = undefined;
      };
    },
  };

  const deps: BrokerDeps = {
    transport,
    clock: () => now,
    setTimer: (fn, delayMs) => {
      const timer: FakeTimer = { delayMs, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    currentContext: () => context,
    // The per-slot rule tests (FIFO, staleness, cancel) pin a single slot so
    // their orderings are deterministic. The multi-flight behaviour of the
    // production default is proved by the dedicated test below.
    maxConcurrentRequests: options.maxConcurrentRequests ?? 1,
  };

  return {
    deps,
    sendFetchCalls,
    sendFetchCommands,
    sendReadCommands,
    sendCancelCalls,
    timers,
    setNow: (value: number) => {
      now = value;
    },
    setContext: (next: CurrentBridgeContext) => {
      context = next;
    },
    blockRequestId: (requestId: string) => {
      blockedRequestIds.add(requestId);
    },
    setReady: (value: boolean) => {
      ready = value;
    },
    fireReply: (rawReply: unknown, origin: BridgeReplyOrigin = TRUSTED_ORIGIN) => {
      replyListener?.(rawReply, origin);
    },
    hasReplyListener: () => replyListener !== undefined,
  };
}

/** Observes a broker promise's settlement without ever `await`-blocking on it directly. */
function trackOutcome(promise: Promise<BrokerOutcome>) {
  let settled = false;
  let settleCount = 0;
  let value: BrokerOutcome | undefined;
  void promise.then((resolved) => {
    settled = true;
    settleCount += 1;
    value = resolved;
  });
  return {
    isSettled: () => settled,
    settleCount: () => settleCount,
    value: () => value,
  };
}

/** Lets already-queued microtasks (promise `.then` callbacks) run before an assertion. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

function okReply(requestId: string) {
  return {
    kind: 'response',
    requestId,
    status: 200,
    contentType: 'application/json',
    bodyText: '{}',
  };
}

describe('createWebviewBridgeBroker', () => {
  it('rule 1: does not send a second request until the first settles, and sends it in FIFO order once it does', async () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);

    const first = trackOutcome(broker.request(makeEnvelope('req-a'), 'https://a.example'));
    const second = trackOutcome(broker.request(makeEnvelope('req-b'), 'https://b.example'));

    // Second request must not have been handed to the transport at all yet.
    expect(harness.sendFetchCalls).toEqual(['req-a']);

    harness.fireReply(okReply('req-a'));
    await flushMicrotasks();

    expect(first.value()).toEqual({
      kind: 'response',
      status: 200,
      contentType: 'application/json',
      bodyText: '{}',
    });
    expect(harness.sendFetchCalls).toEqual(['req-a', 'req-b']);

    harness.fireReply(okReply('req-b'));
    await flushMicrotasks();
    expect(second.value()?.kind).toBe('response');
  });

  it('rule 2: does not send a queued request that went stale while it waited', async () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);

    const first = trackOutcome(broker.request(makeEnvelope('req-a'), 'https://a.example'));
    const second = trackOutcome(
      broker.request(makeEnvelope('req-b', { navigationEpoch: 0 }), 'https://b.example'),
    );

    // The user navigates while "req-a" is still in flight and "req-b" is
    // still waiting in the queue.
    harness.setContext({ serverRevision: 0, navigationEpoch: 1 });

    harness.fireReply(okReply('req-a'));
    await flushMicrotasks();

    // The navigation makes "req-a"'s own reply stale too (rule 2's other
    // half), but the point of this test is "req-b": it must resolve stale
    // without ever having been dispatched.
    expect(first.value()).toEqual({ kind: 'stale', status: 'stale_navigation_epoch' });
    expect(second.value()).toEqual({ kind: 'stale', status: 'stale_navigation_epoch' });
    // The staleness check must have short-circuited dispatch entirely.
    expect(harness.sendFetchCalls).toEqual(['req-a']);
  });

  it('rule 2: ignores a reply for a request that has since gone stale, rather than honouring it', async () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);

    const outcome = trackOutcome(broker.request(makeEnvelope('req-a'), 'https://a.example'));
    expect(harness.sendFetchCalls).toEqual(['req-a']);

    // The server's revision changes while the fetch is in flight, e.g. the
    // server was reconfigured mid-request.
    harness.setContext({ serverRevision: 1, navigationEpoch: 0 });
    harness.fireReply(okReply('req-a'));
    await flushMicrotasks();

    expect(outcome.value()).toEqual({ kind: 'stale', status: 'stale_server_revision' });
  });

  it('rule 3: resolves timeout immediately, without ever sending, when the deadline has already passed', async () => {
    const harness = createHarness();
    harness.setNow(1_000);
    const broker = createWebviewBridgeBroker(harness.deps);

    const outcome = trackOutcome(
      broker.request(makeEnvelope('req-a', { deadlineMs: 500 }), 'https://a.example'),
    );
    await flushMicrotasks();

    expect(outcome.value()).toEqual({ kind: 'timeout' });
    expect(harness.sendFetchCalls).toEqual([]);
  });

  it('rule 3: resolves timeout when the injected deadline elapses, sends a cancel command, and moves on to the next queued request', async () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);

    const first = trackOutcome(broker.request(makeEnvelope('req-a'), 'https://a.example'));
    const second = trackOutcome(broker.request(makeEnvelope('req-b'), 'https://b.example'));

    expect(harness.sendFetchCalls).toEqual(['req-a']);
    expect(harness.timers).toHaveLength(1);

    // Simulate the injected timer firing once the deadline elapses.
    harness.timers[0]?.fn();
    await flushMicrotasks();

    expect(first.value()).toEqual({ kind: 'timeout' });
    expect(harness.sendCancelCalls).toEqual(['req-a']);
    expect(harness.sendFetchCalls).toEqual(['req-a', 'req-b']);

    harness.fireReply(okReply('req-b'));
    await flushMicrotasks();
    expect(second.value()?.kind).toBe('response');
  });

  it('rule 4: ignores a forged reply carrying the correct requestId from an untrusted origin, leaving the request pending', async () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);

    const outcome = trackOutcome(broker.request(makeEnvelope('req-a'), 'https://a.example'));

    // Carries the exact requestId the broker is waiting for, but did not
    // arrive from the trusted AEM view's main frame - this is the case that a
    // registration-time-only identity check would have wrongly authorized.
    harness.fireReply(okReply('req-a'), { isTrustedView: false, isMainFrame: true });
    harness.fireReply(okReply('req-a'), { isTrustedView: true, isMainFrame: false });
    await flushMicrotasks();

    expect(outcome.isSettled()).toBe(false);

    // The legitimate sender can still complete it afterward.
    harness.fireReply(okReply('req-a'), TRUSTED_ORIGIN);
    await flushMicrotasks();
    expect(outcome.value()?.kind).toBe('response');
  });

  it('rule 5: ignores a reply that fails schema validation, exactly like an untrusted origin', async () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);

    const outcome = trackOutcome(broker.request(makeEnvelope('req-a'), 'https://a.example'));

    harness.fireReply({ kind: 'response', requestId: 'req-a', status: 'not-a-number' });
    await flushMicrotasks();
    expect(outcome.isSettled()).toBe(false);

    harness.fireReply(okReply('req-a'));
    await flushMicrotasks();
    expect(outcome.value()?.kind).toBe('response');
  });

  it('rule 6: ignores a well-formed reply whose requestId does not match the in-flight request', async () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);

    const outcome = trackOutcome(broker.request(makeEnvelope('req-a'), 'https://a.example'));

    harness.fireReply(okReply('req-does-not-exist'));
    await flushMicrotasks();
    expect(outcome.isSettled()).toBe(false);

    harness.fireReply(okReply('req-a'));
    await flushMicrotasks();
    expect(outcome.value()?.kind).toBe('response');
  });

  it('rule 6: a late reply for a request that already timed out cannot complete the next queued request', async () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);

    const first = trackOutcome(broker.request(makeEnvelope('req-a'), 'https://a.example'));
    const second = trackOutcome(broker.request(makeEnvelope('req-b'), 'https://b.example'));

    harness.timers[0]?.fn(); // req-a times out; req-b is dispatched next
    await flushMicrotasks();
    expect(first.value()).toEqual({ kind: 'timeout' });
    expect(harness.sendFetchCalls).toEqual(['req-a', 'req-b']);

    // A reply for the already-timed-out "req-a" arrives late.
    harness.fireReply(okReply('req-a'));
    await flushMicrotasks();
    expect(second.isSettled()).toBe(false);

    harness.fireReply(okReply('req-b'));
    await flushMicrotasks();
    expect(second.value()?.kind).toBe('response');
  });

  it('rule 7: cancelAll resolves the in-flight and every queued request as cancelled, sending a cancel command only for the in-flight one', async () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);

    const first = trackOutcome(broker.request(makeEnvelope('req-a'), 'https://a.example'));
    const second = trackOutcome(broker.request(makeEnvelope('req-b'), 'https://b.example'));

    broker.cancelAll();
    await flushMicrotasks();

    expect(first.value()).toEqual({ kind: 'cancelled' });
    expect(second.value()).toEqual({ kind: 'cancelled' });
    expect(harness.sendCancelCalls).toEqual(['req-a']);
    // "req-b" was never sent, so it needs no cancel command.
    expect(harness.sendFetchCalls).toEqual(['req-a']);
  });

  it('rule 7: a late reply after cancelAll changes nothing', async () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);

    const first = trackOutcome(broker.request(makeEnvelope('req-a'), 'https://a.example'));
    broker.cancelAll();
    await flushMicrotasks();
    expect(first.value()).toEqual({ kind: 'cancelled' });

    expect(() => harness.fireReply(okReply('req-a'))).not.toThrow();
    await flushMicrotasks();
    expect(first.settleCount()).toBe(1);
  });

  it('rule 8: resolves no_view and proceeds to the next queued request when there is no live view to send to', async () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);

    const blocker = trackOutcome(broker.request(makeEnvelope('req-blocker'), 'https://a.example'));
    harness.blockRequestId('req-a');
    const first = trackOutcome(broker.request(makeEnvelope('req-a'), 'https://a.example'));
    const second = trackOutcome(broker.request(makeEnvelope('req-b'), 'https://b.example'));

    harness.fireReply(okReply('req-blocker'));
    await flushMicrotasks();

    expect(blocker.value()?.kind).toBe('response');
    expect(first.value()).toEqual({ kind: 'no_view' });
    expect(harness.sendFetchCalls).toEqual(['req-blocker', 'req-a', 'req-b']);

    harness.fireReply(okReply('req-b'));
    await flushMicrotasks();
    expect(second.value()?.kind).toBe('response');
  });

  it('rule 13: resolves bridge_unavailable without sending when the view is live but its preload never announced ready', async () => {
    const harness = createHarness();
    harness.setReady(false);
    const broker = createWebviewBridgeBroker(harness.deps);

    const outcome = trackOutcome(broker.request(makeEnvelope('req-a'), 'https://a.example'));
    await flushMicrotasks();

    // Never sent, and settled immediately - not after the deadline. This is
    // what keeps a missing/broken preload from looking like an AEM timeout.
    expect(outcome.value()).toEqual({ kind: 'bridge_unavailable' });
    expect(harness.sendFetchCalls).toEqual([]);
    expect(harness.timers).toEqual([]);
  });

  it('rule 13: sends normally once the preload has announced ready', async () => {
    const harness = createHarness();
    harness.setReady(false);
    const broker = createWebviewBridgeBroker(harness.deps);

    harness.setReady(true);
    const outcome = trackOutcome(broker.request(makeEnvelope('req-a'), 'https://a.example'));

    expect(harness.sendFetchCalls).toEqual(['req-a']);
    harness.fireReply(okReply('req-a'));
    await flushMicrotasks();
    expect(outcome.value()?.kind).toBe('response');
  });

  it('rule 9: cancels the pending timer once a request settles via a reply', async () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);

    void broker.request(makeEnvelope('req-a'), 'https://a.example');
    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]?.cancelled).toBe(false);

    harness.fireReply(okReply('req-a'));
    await flushMicrotasks();

    expect(harness.timers[0]?.cancelled).toBe(true);
  });

  it('rule 10: dispose unsubscribes the reply listener and cancels the in-flight and queued requests', async () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);

    const first = trackOutcome(broker.request(makeEnvelope('req-a'), 'https://a.example'));
    const second = trackOutcome(broker.request(makeEnvelope('req-b'), 'https://b.example'));
    expect(harness.hasReplyListener()).toBe(true);

    broker.dispose();
    await flushMicrotasks();

    expect(harness.hasReplyListener()).toBe(false);
    expect(first.value()).toEqual({ kind: 'cancelled' });
    expect(second.value()).toEqual({ kind: 'cancelled' });
  });

  it("rule 11: passes the envelope's requestId through to the transport as-is, never inventing one", () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);

    void broker.request(makeEnvelope('my-exact-request-id'), 'https://a.example');
    expect(harness.sendFetchCalls).toEqual(['my-exact-request-id']);

    harness.timers[0]?.fn();
    expect(harness.sendCancelCalls).toEqual(['my-exact-request-id']);
  });

  it('rule 12: settles once and emits no spurious cancel when a reply, a duplicate reply, and a late timeout callback all arrive for the same request', async () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);

    const outcome = trackOutcome(broker.request(makeEnvelope('req-a'), 'https://a.example'));
    const timer = harness.timers[0];

    harness.fireReply(okReply('req-a'));
    harness.fireReply(okReply('req-a'));
    expect(() => timer?.fn()).not.toThrow();
    await flushMicrotasks();

    // `settleCount` is bounded by the promise's own semantics rather than by
    // anything this module does, so the load-bearing assertion here is the one
    // below: the late timer must not emit a cancel command for a request that
    // already has an outcome.
    expect(outcome.settleCount()).toBe(1);
    expect(outcome.value()).toEqual({
      kind: 'response',
      status: 200,
      contentType: 'application/json',
      bodyText: '{}',
    });
    // The stale timer callback must not have sent a second, pointless cancel.
    expect(harness.sendCancelCalls).toEqual([]);
  });
});

describe('createWebviewBridgeBroker - concurrency', () => {
  /** A two-slot broker with three requests issued, so the third waits in the queue. */
  function twoSlotBroker() {
    const harness = createHarness({ maxConcurrentRequests: 2 });
    const broker = createWebviewBridgeBroker(harness.deps);
    const a = trackOutcome(broker.request(makeEnvelope('req-a'), 'https://a.example'));
    const b = trackOutcome(broker.request(makeEnvelope('req-b'), 'https://b.example'));
    const c = trackOutcome(broker.request(makeEnvelope('req-c'), 'https://c.example'));
    return { harness, broker, a, b, c };
  }

  it('sends up to the concurrency limit at once, and dispatches the next as a slot frees', async () => {
    const { harness, a, b, c } = twoSlotBroker();

    // Two requests in flight at once; the third waits, so dispatch stays FIFO.
    expect(harness.sendFetchCalls).toEqual(['req-a', 'req-b']);

    harness.fireReply(okReply('req-a'));
    await flushMicrotasks();
    expect(a.value()?.kind).toBe('response');
    // A slot freed: the queued request is sent while req-b is still in flight.
    expect(harness.sendFetchCalls).toEqual(['req-a', 'req-b', 'req-c']);
    expect(b.isSettled()).toBe(false);

    // A reply for one in-flight request never settles another.
    harness.fireReply(okReply('req-b'));
    await flushMicrotasks();
    expect(b.value()?.kind).toBe('response');
    expect(c.isSettled()).toBe(false);

    harness.fireReply(okReply('req-c'));
    await flushMicrotasks();
    expect(c.value()?.kind).toBe('response');
  });

  it('cancelAll cancels every in-flight request and every queued one', async () => {
    const { harness, broker, a, b, c } = twoSlotBroker();

    broker.cancelAll();
    await flushMicrotasks();

    expect(a.value()).toEqual({ kind: 'cancelled' });
    expect(b.value()).toEqual({ kind: 'cancelled' });
    expect(c.value()).toEqual({ kind: 'cancelled' });
    // A cancel command for each in-flight request; none for the queued one.
    expect(harness.sendCancelCalls).toEqual(['req-a', 'req-b']);
  });
});

describe('createWebviewBridgeBroker - request diagnostics', () => {
  it('logs WEBVIEW_REQUEST_STARTED on send and WEBVIEW_REQUEST_COMPLETED with status/outcome/duration on reply', async () => {
    const harness = createHarness();
    const { logger, lines } = recordingLogger();
    const broker = createWebviewBridgeBroker({ ...harness.deps, logger });

    harness.setNow(1000);
    trackOutcome(
      broker.request(makeEnvelope('req-1'), 'https://aem.example.com/bin/querybuilder.json'),
    );
    expect(lines.map((line) => line.code)).toEqual(['WEBVIEW_REQUEST_STARTED']);

    harness.setNow(1250);
    harness.fireReply(okReply('req-1'));
    await flushMicrotasks();

    expect(lines.map((line) => line.code)).toEqual([
      'WEBVIEW_REQUEST_STARTED',
      'WEBVIEW_REQUEST_COMPLETED',
    ]);
    expect(lines[1]?.fields).toMatchObject({
      durationMs: 250,
      outcome: 'success',
      statusCode: 200,
    });
  });

  it('reports a non-2xx response as outcome failure, with its status', async () => {
    const harness = createHarness();
    const { logger, lines } = recordingLogger();
    const broker = createWebviewBridgeBroker({ ...harness.deps, logger });

    trackOutcome(broker.request(makeEnvelope('req-1'), 'https://aem.example.com/x'));
    harness.fireReply({
      kind: 'response',
      requestId: 'req-1',
      status: 404,
      contentType: null,
      bodyText: '',
    });
    await flushMicrotasks();

    expect(lines.at(-1)?.fields).toMatchObject({ outcome: 'failure', statusCode: 404 });
  });

  it('reports a deadline expiry as outcome timeout', async () => {
    const harness = createHarness();
    const { logger, lines } = recordingLogger();
    const broker = createWebviewBridgeBroker({ ...harness.deps, logger });

    trackOutcome(broker.request(makeEnvelope('req-1'), 'https://aem.example.com/x'));
    harness.setNow(100_000);
    harness.timers[0]?.fn();
    await flushMicrotasks();

    expect(lines.at(-1)?.fields).toMatchObject({ outcome: 'timeout' });
  });

  it('reports an unavailable bridge as outcome failure, and never logs WEBVIEW_REQUEST_STARTED', async () => {
    const harness = createHarness();
    harness.setReady(false);
    const { logger, lines } = recordingLogger();
    const broker = createWebviewBridgeBroker({ ...harness.deps, logger });

    trackOutcome(broker.request(makeEnvelope('req-1'), 'https://aem.example.com/x'));
    await flushMicrotasks();

    expect(lines.map((line) => line.code)).toEqual(['WEBVIEW_REQUEST_COMPLETED']);
    expect(lines[0]?.fields).toMatchObject({ outcome: 'failure' });
  });

  it('reports a cancelled request as outcome cancelled', async () => {
    const harness = createHarness();
    const { logger, lines } = recordingLogger();
    const broker = createWebviewBridgeBroker({ ...harness.deps, logger });

    trackOutcome(broker.request(makeEnvelope('req-1'), 'https://aem.example.com/x'));
    broker.cancelAll();
    await flushMicrotasks();

    expect(lines.at(-1)?.fields).toMatchObject({ outcome: 'cancelled' });
  });

  it('does not log when no logger is supplied', () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);
    expect(() => broker.request(makeEnvelope('req-1'), 'https://aem.example.com/x')).not.toThrow();
  });
});

describe('createWebviewBridgeBroker - tool HTTP log', () => {
  it('logs the full request URL with its headers on send, and the response with headers on reply', async () => {
    const harness = createHarness();
    const { toolLogger, requests, responses } = recordingToolLogger();
    const broker = createWebviewBridgeBroker({ ...harness.deps, toolLogger });
    const url = 'https://aem.example.com/bin/querybuilder.json?path=/content/foo&type=cq:Page';

    harness.setNow(1000);
    trackOutcome(broker.request(makeEnvelope('req-1'), url));

    // The query string is exactly what app.log strips and this log exists to keep.
    expect(requests).toEqual([
      {
        requestId: 'req-1',
        method: 'GET',
        url,
        headers: [{ name: 'Accept', value: 'application/json' }],
      },
    ]);
    expect(responses).toEqual([]);

    harness.setNow(1250);
    harness.fireReply({
      ...okReply('req-1'),
      headers: [{ name: 'content-type', value: 'application/json' }],
    });
    await flushMicrotasks();

    expect(responses).toEqual([
      {
        requestId: 'req-1',
        status: 200,
        outcome: 'success',
        durationMs: 250,
        headers: [{ name: 'content-type', value: 'application/json' }],
      },
    ]);
  });

  it('logs a deadline expiry with a null status and no headers', async () => {
    const harness = createHarness();
    const { toolLogger, responses } = recordingToolLogger();
    const broker = createWebviewBridgeBroker({ ...harness.deps, toolLogger });

    trackOutcome(broker.request(makeEnvelope('req-1'), 'https://aem.example.com/x'));
    harness.setNow(100_000);
    harness.timers[0]?.fn();
    await flushMicrotasks();

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      requestId: 'req-1',
      status: null,
      outcome: 'timeout',
      headers: [],
    });
  });

  it('does not require a tool logger', () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);
    expect(() => broker.request(makeEnvelope('req-1'), 'https://aem.example.com/x')).not.toThrow();
  });
});

describe('createWebviewBridgeBroker - authentication loss', () => {
  const unauthorizedReply = (requestId: string) => ({
    kind: 'response',
    requestId,
    status: 401,
    contentType: 'text/plain',
    bodyText: '',
  });
  const loginPageReply = (requestId: string, bodyText: string) => ({
    kind: 'response',
    requestId,
    status: 200,
    contentType: 'text/html;charset=utf-8',
    bodyText,
  });
  const blockedReply = (requestId: string) => ({
    kind: 'blocked',
    requestId,
    reason: 'redirect_blocked',
  });
  const SERVER_ID = makeEnvelope('probe').serverId;

  function createAuthHarness() {
    const harness = createHarness();
    const incidents: { serverId: string; severity: string }[] = [];
    const recoveries: string[] = [];
    const broker = createWebviewBridgeBroker({
      ...harness.deps,
      authWatch: {
        incident: (event) => incidents.push(event),
        recovered: (event) => recoveries.push(event.serverId),
      },
    });
    return { harness, broker, incidents, recoveries };
  }

  async function settleWith(
    harness: ReturnType<typeof createHarness>,
    broker: ReturnType<typeof createWebviewBridgeBroker>,
    requestId: string,
    reply: (id: string) => unknown,
  ): Promise<void> {
    void broker.request(makeEnvelope(requestId), 'https://aem.example.com/x');
    harness.fireReply(reply(requestId));
    await flushMicrotasks();
  }

  it('reports a 401 once, and latches the host so the next read never reaches it', async () => {
    const { harness, broker, incidents } = createAuthHarness();

    await settleWith(harness, broker, 'req-a', unauthorizedReply);
    expect(incidents).toEqual([{ serverId: SERVER_ID, severity: 'certain' }]);

    const latched = trackOutcome(
      broker.request(makeEnvelope('req-b'), 'https://aem.example.com/y'),
    );
    await flushMicrotasks();

    expect(latched.value()).toEqual({ kind: 'blocked', reason: 'redirect_blocked' });
    expect(harness.sendFetchCalls).toEqual(['req-a']);
    expect(incidents).toHaveLength(1);
  });

  it('treats a blocked redirect as certain evidence', async () => {
    const { harness, broker, incidents } = createAuthHarness();
    await settleWith(harness, broker, 'req-a', blockedReply);
    expect(incidents).toEqual([{ serverId: SERVER_ID, severity: 'certain' }]);
  });

  it('reports a weak login hint as suspected without latching, then escalates once on certain evidence', async () => {
    const { harness, broker, incidents } = createAuthHarness();

    // noinspection HtmlRequiredLangAttribute
    await settleWith(harness, broker, 'req-a', (id) =>
      loginPageReply(id, '<html><body>Please sign in</body></html>'),
    );
    expect(incidents).toEqual([{ serverId: SERVER_ID, severity: 'suspected' }]);

    // A merely suspected host is still read.
    // noinspection HtmlRequiredLangAttribute
    await settleWith(harness, broker, 'req-b', (id) =>
      loginPageReply(id, '<html><body>Please sign in</body></html>'),
    );
    expect(harness.sendFetchCalls).toEqual(['req-a', 'req-b']);
    expect(incidents).toHaveLength(1);

    await settleWith(harness, broker, 'req-c', unauthorizedReply);
    expect(incidents.map((incident) => incident.severity)).toEqual(['suspected', 'certain']);
  });

  it('ends the episode and reports recovery when a read succeeds with JSON', async () => {
    const { harness, broker, incidents, recoveries } = createAuthHarness();

    // noinspection HtmlRequiredLangAttribute
    await settleWith(harness, broker, 'req-a', (id) =>
      loginPageReply(id, '<html><body>Please sign in</body></html>'),
    );
    await settleWith(harness, broker, 'req-b', okReply);

    expect(recoveries).toEqual([SERVER_ID]);

    // A fresh failure after recovery is a new episode.
    await settleWith(harness, broker, 'req-c', unauthorizedReply);
    expect(incidents).toHaveLength(2);
  });

  it('does not report recovery for an unrelated success when no episode is open', async () => {
    const { harness, broker, recoveries } = createAuthHarness();
    await settleWith(harness, broker, 'req-a', okReply);
    expect(recoveries).toEqual([]);
  });

  it('resetAuthIncidents lifts the latch and reports recovery for the host', async () => {
    const { harness, broker, recoveries } = createAuthHarness();
    await settleWith(harness, broker, 'req-a', unauthorizedReply);

    broker.resetAuthIncidents();
    expect(recoveries).toEqual([SERVER_ID]);

    void broker.request(makeEnvelope('req-b'), 'https://aem.example.com/y');
    expect(harness.sendFetchCalls).toEqual(['req-a', 'req-b']);
  });

  it('works without an auth watch', async () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);
    await settleWith(harness, broker, 'req-a', unauthorizedReply);
    expect(() => broker.resetAuthIncidents()).not.toThrow();
  });
});

describe('createWebviewBridgeBroker - request method and accept', () => {
  const redirectReply = (requestId: string) => ({
    kind: 'blocked',
    requestId,
    reason: 'redirect_blocked',
  });

  function createWatchedHarness() {
    const harness = createHarness();
    const incidents: string[] = [];
    const broker = createWebviewBridgeBroker({
      ...harness.deps,
      authWatch: {
        incident: (event) => incidents.push(event.severity),
        recovered: () => undefined,
      },
    });
    return { harness, broker, incidents };
  }

  it('sends a plain GET with no method or accept on the wire', () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);

    void broker.request(makeEnvelope('req-a'), 'https://aem.example.com/x');

    expect(harness.sendFetchCommands[0]).toEqual({
      requestId: 'req-a',
      url: 'https://aem.example.com/x',
    });
  });

  it('hands a HEAD method and an accept header on to the transport', () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);

    void broker.request(makeEnvelope('req-a'), 'https://aem.example.com/x', {
      method: 'HEAD',
      accept: 'text/html',
    });

    expect(harness.sendFetchCommands[0]).toMatchObject({ method: 'HEAD', accept: 'text/html' });
  });

  it('does not take a redirect met by a HEAD probe for a lost session', async () => {
    const { harness, broker, incidents } = createWatchedHarness();

    void broker.request(makeEnvelope('req-a'), 'https://aem.example.com/x', { method: 'HEAD' });
    harness.fireReply(redirectReply('req-a'));
    await flushMicrotasks();

    expect(incidents).toEqual([]);
  });

  it('does not take a redirect met by an HTML read for a lost session', async () => {
    const { harness, broker, incidents } = createWatchedHarness();

    void broker.request(makeEnvelope('req-a'), 'https://aem.example.com/x', {
      accept: 'text/html',
    });
    harness.fireReply(redirectReply('req-a'));
    await flushMicrotasks();

    expect(incidents).toEqual([]);
  });

  it('still takes a redirect met by a JSON read for a lost session', async () => {
    const { harness, broker, incidents } = createWatchedHarness();

    void broker.request(makeEnvelope('req-a'), 'https://aem.example.com/x', {
      accept: 'application/json',
    });
    harness.fireReply(redirectReply('req-a'));
    await flushMicrotasks();

    expect(incidents).toEqual(['certain']);
  });
});

describe('createWebviewBridgeBroker - DOM reads', () => {
  const SPEC = { selector: 'a', limit: 20 } as const;
  const domResult = {
    status: 'ok',
    url: 'https://x.example/',
    title: 'T',
    matched: 0,
    items: [],
    truncated: false,
  };

  function domReply(requestId: string, result: unknown = domResult) {
    return { kind: 'dom', requestId, result };
  }

  it('hands the read to the transport as a read command, not a fetch', () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);

    void broker.readDom(makeEnvelope('req-a'), SPEC);

    expect(harness.sendReadCommands).toEqual([{ requestId: 'req-a', ...SPEC }]);
    expect(harness.sendFetchCalls).toEqual([]);
  });

  it('settles a dom reply as a JSON response carrying the result', async () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);

    const outcome = trackOutcome(broker.readDom(makeEnvelope('req-a'), SPEC));
    harness.fireReply(domReply('req-a'));
    await flushMicrotasks();

    expect(outcome.value()).toEqual({
      kind: 'response',
      status: 200,
      contentType: 'application/json',
      bodyText: JSON.stringify(domResult),
    });
  });

  it('settles no_view when the transport cannot deliver the read', async () => {
    const harness = createHarness();
    harness.blockRequestId('req-a');
    const broker = createWebviewBridgeBroker(harness.deps);

    const outcome = trackOutcome(broker.readDom(makeEnvelope('req-a'), SPEC));
    await flushMicrotasks();

    expect(outcome.value()).toEqual({ kind: 'no_view' });
  });

  it('shares the request queue with fetches, in order', async () => {
    const harness = createHarness();
    const broker = createWebviewBridgeBroker(harness.deps);

    void broker.request(makeEnvelope('req-a'), 'https://aem.example.com/x');
    void broker.readDom(makeEnvelope('req-b'), SPEC);
    expect(harness.sendReadCommands).toEqual([]);

    harness.fireReply(okReply('req-a'));
    await flushMicrotasks();

    expect(harness.sendReadCommands.map((command) => command.requestId)).toEqual(['req-b']);
  });

  it('is not refused by a lost-session latch, and does not feed it', async () => {
    const harness = createHarness();
    const incidents: string[] = [];
    const broker = createWebviewBridgeBroker({
      ...harness.deps,
      authWatch: {
        incident: (event) => incidents.push(event.severity),
        recovered: () => undefined,
      },
    });
    void broker.request(makeEnvelope('req-a'), 'https://aem.example.com/x');
    harness.fireReply({ kind: 'blocked', requestId: 'req-a', reason: 'redirect_blocked' });
    await flushMicrotasks();
    expect(incidents).toEqual(['certain']);

    void broker.readDom(makeEnvelope('req-b'), SPEC);
    expect(harness.sendReadCommands.map((command) => command.requestId)).toEqual(['req-b']);

    harness.fireReply({ kind: 'blocked', requestId: 'req-b', reason: 'redirect_blocked' });
    await flushMicrotasks();
    expect(incidents).toEqual(['certain']);
  });

  it('logs the read with the READ method and its selector', () => {
    const harness = createHarness();
    const { toolLogger, requests } = recordingToolLogger();
    const broker = createWebviewBridgeBroker({ ...harness.deps, toolLogger });

    void broker.readDom(makeEnvelope('req-a'), SPEC);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ requestId: 'req-a', method: 'READ' });
    expect(requests[0]?.url).toContain(SPEC.selector);
  });
});
