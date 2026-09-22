import { describe, expect, it } from 'vitest';
import {
  createAemBridgeBroker,
  type BridgeReplyOrigin,
  type BridgeTransport,
  type BrokerDeps,
  type BrokerOutcome,
} from '../../../../src/main/aem/bridgeBroker';
import {
  toolRequestEnvelopeSchema,
  type CurrentAemContext,
  type ToolRequestEnvelope,
} from '../../../../src/shared';
import type { Logger } from '../../../../src/main/logger';

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

const TRUSTED_ORIGIN: BridgeReplyOrigin = { isTrustedAemView: true, isMainFrame: true };

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
function createHarness() {
  const sendFetchCalls: string[] = [];
  const sendCancelCalls: string[] = [];
  const timers: FakeTimer[] = [];
  let replyListener: ((rawReply: unknown, origin: BridgeReplyOrigin) => void) | undefined;
  let now = 0;
  let context: CurrentAemContext = { serverRevision: 0, navigationEpoch: 0 };
  const blockedRequestIds = new Set<string>();

  const transport: BridgeTransport = {
    sendFetch(command) {
      sendFetchCalls.push(command.requestId);
      return !blockedRequestIds.has(command.requestId);
    },
    sendCancel(command) {
      sendCancelCalls.push(command.requestId);
    },
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
  };

  return {
    deps,
    sendFetchCalls,
    sendCancelCalls,
    timers,
    setNow: (value: number) => {
      now = value;
    },
    setContext: (next: CurrentAemContext) => {
      context = next;
    },
    blockRequestId: (requestId: string) => {
      blockedRequestIds.add(requestId);
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

describe('createAemBridgeBroker', () => {
  it('rule 1: does not send a second request until the first settles, and sends it in FIFO order once it does', async () => {
    const harness = createHarness();
    const broker = createAemBridgeBroker(harness.deps);

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
    const broker = createAemBridgeBroker(harness.deps);

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
    const broker = createAemBridgeBroker(harness.deps);

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
    const broker = createAemBridgeBroker(harness.deps);

    const outcome = trackOutcome(
      broker.request(makeEnvelope('req-a', { deadlineMs: 500 }), 'https://a.example'),
    );
    await flushMicrotasks();

    expect(outcome.value()).toEqual({ kind: 'timeout' });
    expect(harness.sendFetchCalls).toEqual([]);
  });

  it('rule 3: resolves timeout when the injected deadline elapses, sends a cancel command, and moves on to the next queued request', async () => {
    const harness = createHarness();
    const broker = createAemBridgeBroker(harness.deps);

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
    const broker = createAemBridgeBroker(harness.deps);

    const outcome = trackOutcome(broker.request(makeEnvelope('req-a'), 'https://a.example'));

    // Carries the exact requestId the broker is waiting for, but did not
    // arrive from the trusted AEM view's main frame - this is the case that a
    // registration-time-only identity check would have wrongly authorized.
    harness.fireReply(okReply('req-a'), { isTrustedAemView: false, isMainFrame: true });
    harness.fireReply(okReply('req-a'), { isTrustedAemView: true, isMainFrame: false });
    await flushMicrotasks();

    expect(outcome.isSettled()).toBe(false);

    // The legitimate sender can still complete it afterward.
    harness.fireReply(okReply('req-a'), TRUSTED_ORIGIN);
    await flushMicrotasks();
    expect(outcome.value()?.kind).toBe('response');
  });

  it('rule 5: ignores a reply that fails schema validation, exactly like an untrusted origin', async () => {
    const harness = createHarness();
    const broker = createAemBridgeBroker(harness.deps);

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
    const broker = createAemBridgeBroker(harness.deps);

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
    const broker = createAemBridgeBroker(harness.deps);

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
    const broker = createAemBridgeBroker(harness.deps);

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
    const broker = createAemBridgeBroker(harness.deps);

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
    const broker = createAemBridgeBroker(harness.deps);

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

  it('rule 9: cancels the pending timer once a request settles via a reply', async () => {
    const harness = createHarness();
    const broker = createAemBridgeBroker(harness.deps);

    void broker.request(makeEnvelope('req-a'), 'https://a.example');
    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]?.cancelled).toBe(false);

    harness.fireReply(okReply('req-a'));
    await flushMicrotasks();

    expect(harness.timers[0]?.cancelled).toBe(true);
  });

  it('rule 10: dispose unsubscribes the reply listener and cancels the in-flight and queued requests', async () => {
    const harness = createHarness();
    const broker = createAemBridgeBroker(harness.deps);

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
    const broker = createAemBridgeBroker(harness.deps);

    void broker.request(makeEnvelope('my-exact-request-id'), 'https://a.example');
    expect(harness.sendFetchCalls).toEqual(['my-exact-request-id']);

    harness.timers[0]?.fn();
    expect(harness.sendCancelCalls).toEqual(['my-exact-request-id']);
  });

  it('rule 12: settles once and emits no spurious cancel when a reply, a duplicate reply, and a late timeout callback all arrive for the same request', async () => {
    const harness = createHarness();
    const broker = createAemBridgeBroker(harness.deps);

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

describe('createAemBridgeBroker - request diagnostics', () => {
  it('logs AEM_REQUEST_STARTED on send and AEM_REQUEST_COMPLETED with status/outcome/duration on reply', async () => {
    const harness = createHarness();
    const { logger, lines } = recordingLogger();
    const broker = createAemBridgeBroker({ ...harness.deps, logger });

    harness.setNow(1000);
    trackOutcome(
      broker.request(makeEnvelope('req-1'), 'https://aem.example.com/bin/querybuilder.json'),
    );
    expect(lines.map((line) => line.code)).toEqual(['AEM_REQUEST_STARTED']);

    harness.setNow(1250);
    harness.fireReply(okReply('req-1'));
    await flushMicrotasks();

    expect(lines.map((line) => line.code)).toEqual([
      'AEM_REQUEST_STARTED',
      'AEM_REQUEST_COMPLETED',
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
    const broker = createAemBridgeBroker({ ...harness.deps, logger });

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
    const broker = createAemBridgeBroker({ ...harness.deps, logger });

    trackOutcome(broker.request(makeEnvelope('req-1'), 'https://aem.example.com/x'));
    harness.setNow(100_000);
    harness.timers[0]?.fn();
    await flushMicrotasks();

    expect(lines.at(-1)?.fields).toMatchObject({ outcome: 'timeout' });
  });

  it('reports a cancelled request as outcome cancelled', async () => {
    const harness = createHarness();
    const { logger, lines } = recordingLogger();
    const broker = createAemBridgeBroker({ ...harness.deps, logger });

    trackOutcome(broker.request(makeEnvelope('req-1'), 'https://aem.example.com/x'));
    broker.cancelAll();
    await flushMicrotasks();

    expect(lines.at(-1)?.fields).toMatchObject({ outcome: 'cancelled' });
  });

  it('does not log when no logger is supplied', () => {
    const harness = createHarness();
    const broker = createAemBridgeBroker(harness.deps);
    expect(() => broker.request(makeEnvelope('req-1'), 'https://aem.example.com/x')).not.toThrow();
  });
});
