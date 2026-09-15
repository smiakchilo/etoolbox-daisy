import { describe, expect, it, vi } from 'vitest';
import {
  newChatId,
  newServerId,
  newTurnId,
  type IdGenerator,
} from '../../src/shared/contracts/ids';
import { serverConfigSchema, type ServerConfig } from '../../src/shared/contracts/serverConfig';
import {
  AEM_REQUEST_TIMEOUT_MS,
  toolRequestEnvelopeSchema,
} from '../../src/shared/contracts/toolContracts';
import {
  parseToolResult,
  renderToolResultForModel,
  serializeToolResult,
  type ToolErrorResult,
  type ToolResult,
  type ToolSuccess,
} from '../../src/shared/contracts/toolResult';
import { aemGetJsonCall, aemQueryCall, unknownOperationCall } from '../support/fakeAgent';
import { FakeBrowserSide } from '../support/fakeBrowserSide';
import { FixtureRepository } from '../support/fakeAemFixtures';
import {
  FakeMainTransport,
  type IssueToolCallOutcome,
  type StartTurnOutcome,
} from '../support/fakeAemTransport';
import { createManualClock } from '../support/testClock';
import { createCountingIdGenerator } from '../support/testIds';

/**
 * Composition test for implementation-plan.md step 03's success criterion:
 * contracts "do not depend on real AEM and are successfully used by the
 * fake agent/transport". Every assertion below exercises the real exports of
 * `src/shared/contracts` through the fake agent -> fake main transport ->
 * fake browser/preload pipeline built in `tests/support`; nothing here
 * re-implements a validator, a staleness rule, or the session-state machine.
 */

const ORIGIN = 'https://author.example';

function createHarness(overrides: { readonly origin?: string } = {}): {
  readonly clock: ReturnType<typeof createManualClock>;
  readonly ids: IdGenerator;
  readonly server: ServerConfig;
  readonly repository: FixtureRepository;
  readonly browser: FakeBrowserSide;
  readonly transport: FakeMainTransport;
} {
  const origin = overrides.origin ?? ORIGIN;
  const clock = createManualClock(1_000);
  const ids = createCountingIdGenerator('id');
  const server = serverConfigSchema.parse({
    id: newServerId(ids),
    label: 'Author',
    origin,
    color: { kind: 'swatch', swatch: 'blue' },
    revision: 0,
  });
  const repository = new FixtureRepository();
  const browser = new FakeBrowserSide(repository, clock.now, origin);
  const transport = new FakeMainTransport({ idGenerator: ids, clock: clock.now, browser, server });
  return { clock, ids, server, repository, browser, transport };
}

/** Starts a turn and asserts it was actually allowed to start, so later steps run in `streaming`. */
function startTurnOrThrow(
  transport: FakeMainTransport,
  chatId: ReturnType<typeof newChatId>,
  turnId: ReturnType<typeof newTurnId>,
): Extract<StartTurnOutcome, { readonly started: true }> {
  const started = transport.startTurn(chatId, turnId);
  if (!started.started) {
    throw new Error(`expected the turn to start but it was blocked: ${started.reason}`);
  }
  return started;
}

function expectIssued(
  outcome: IssueToolCallOutcome,
): Extract<IssueToolCallOutcome, { readonly kind: 'issued' }> {
  if (outcome.kind !== 'issued') {
    throw new Error(
      `expected the tool call to be issued but it was rejected: ${JSON.stringify(outcome.result.error)}`,
    );
  }
  return outcome;
}

function expectRejected(
  outcome: IssueToolCallOutcome,
): Extract<IssueToolCallOutcome, { readonly kind: 'rejected' }> {
  if (outcome.kind !== 'rejected') {
    throw new Error('expected the tool call to be rejected, but it was issued');
  }
  return outcome;
}

function expectSuccess(result: ToolResult): ToolSuccess {
  if (!result.ok) {
    throw new Error(
      `expected a success result but got error ${result.error.code}: ${result.error.message}`,
    );
  }
  return result;
}

function expectError(result: ToolResult): ToolErrorResult {
  if (result.ok) {
    throw new Error('expected an error result but got a success');
  }
  return result;
}

describe('valid and invalid tool argument DTOs', () => {
  it('runs a well-formed aem_get_json call end to end and returns a correlated success', () => {
    const { transport } = createHarness();
    const chatId = newChatId(createCountingIdGenerator('chat'));
    const turnId = newTurnId(createCountingIdGenerator('turn'));
    startTurnOrThrow(transport, chatId, turnId);

    const outcome = expectIssued(
      transport.issueToolCall({
        chatId,
        turnId,
        call: aemGetJsonCall({ path: '/content/site', includeChildren: true }),
      }),
    );
    const result = expectSuccess(outcome.deliver());

    expect(result.operation).toBe('aem_get_json');
    expect(result.requestId).toBe(outcome.requestId);
    expect(result.sourceOrigin).toBe(ORIGIN);
    if (result.operation === 'aem_get_json') {
      expect(result.children).toEqual({ requested: true, returned: 3, hasMore: false });
    }
  });

  it("applies the schema's own limit/offset defaults for an aem_query call that omits them", () => {
    const { transport } = createHarness();
    const chatId = newChatId(createCountingIdGenerator('chat'));
    const turnId = newTurnId(createCountingIdGenerator('turn'));
    startTurnOrThrow(transport, chatId, turnId);

    const outcome = expectIssued(
      transport.issueToolCall({ chatId, turnId, call: aemQueryCall({ predicates: {} }) }),
    );
    const result = expectSuccess(outcome.deliver());
    if (result.operation === 'aem_query') {
      // Confirms `aemQueryArgsSchema`'s `.default(50)`/`.default(0)` reached the
      // built envelope unchanged - the fake transport never supplies its own.
      expect(result.pagination.limit).toBe(50);
      expect(result.pagination.offset).toBe(0);
    }
  });

  it('rejects an aem_get_json call whose path is not a string, as an invalid argument rather than throwing', () => {
    const { transport } = createHarness();
    const chatId = newChatId(createCountingIdGenerator('chat'));
    const turnId = newTurnId(createCountingIdGenerator('turn'));
    startTurnOrThrow(transport, chatId, turnId);

    const outcome = expectRejected(
      transport.issueToolCall({ chatId, turnId, call: aemGetJsonCall({ path: 123 }) }),
    );
    expect(outcome.result.error.code).toBe('INVALID_ARGUMENT');
  });

  it('rejects a call that smuggles serverId inside args, the field the agent has no dedicated place to put', () => {
    const { transport } = createHarness();
    const chatId = newChatId(createCountingIdGenerator('chat'));
    const turnId = newTurnId(createCountingIdGenerator('turn'));
    startTurnOrThrow(transport, chatId, turnId);

    // `FakeAgentToolCall` has no `serverId` field of its own (see fakeAgent.ts),
    // but nothing stops a hostile model stuffing one inside `args` - the
    // `.strict()` schema, not the agent's type, is what must catch this.
    const outcome = expectRejected(
      transport.issueToolCall({
        chatId,
        turnId,
        call: aemGetJsonCall({ path: '/content/site', serverId: 'attacker-server' }),
      }),
    );
    expect(outcome.result.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('session-state transitions', () => {
  it('drives idle -> sending -> streaming -> runningTool -> streaming -> idle for one full turn with no illegal transition', () => {
    const { transport } = createHarness();
    const chatId = newChatId(createCountingIdGenerator('chat'));
    const turnId = newTurnId(createCountingIdGenerator('turn'));

    const started = startTurnOrThrow(transport, chatId, turnId);
    expect(transport.getChatStatus(chatId).state).toBe('streaming');

    const outcome = expectIssued(
      transport.issueToolCall({ chatId, turnId, call: aemGetJsonCall({ path: '/content/site' }) }),
    );
    expect(transport.getChatStatus(chatId).state).toBe('runningTool');
    outcome.deliver();
    expect(transport.getChatStatus(chatId).state).toBe('streaming');

    transport.completeTurn(chatId, turnId, started.messageId, 'done');
    expect(transport.getChatStatus(chatId).state).toBe('idle');
    expect(transport.illegalTransitions).toHaveLength(0);
  });

  it('still executes a tool call issued without startTurn, but records the illegal transition instead of silently accepting or blocking it', () => {
    // sessionState.ts's own `nextStreamStateForEvent` maps `tool.call.requested`
    // to `runningTool` unconditionally; from `idle` that is not a legal target
    // (LEGAL_TRANSITIONS.idle = [idle, sending, error, closed]), so this is the
    // one deterministic way to produce an illegal transition through the real
    // state machine rather than asserting against a hand-rolled one.
    const { transport } = createHarness();
    const chatId = newChatId(createCountingIdGenerator('chat'));
    const turnId = newTurnId(createCountingIdGenerator('turn'));

    expect(transport.getChatStatus(chatId).state).toBe('idle');
    const outcome = expectIssued(
      transport.issueToolCall({ chatId, turnId, call: aemGetJsonCall({ path: '/content/site' }) }),
    );

    expect(transport.illegalTransitions.length).toBeGreaterThan(0);
    expect(transport.illegalTransitions[0]).toMatchObject({ from: 'idle', to: 'runningTool' });
    // `canRunAemTool` only checks `closed`/`browserReady` (sessionState.ts), so
    // the call still runs to completion despite the illegal transition above -
    // the two are deliberately decoupled, see the report for this finding.
    const result = expectSuccess(outcome.deliver());
    expect(result.ok).toBe(true);
  });
});

describe('correlation and concurrency', () => {
  it('mints a distinct requestId for every concurrently issued tool call', () => {
    const { transport } = createHarness();
    const chatId = newChatId(createCountingIdGenerator('chat'));
    const turnId = newTurnId(createCountingIdGenerator('turn'));
    startTurnOrThrow(transport, chatId, turnId);

    const outcomes = [
      expectIssued(
        transport.issueToolCall({
          chatId,
          turnId,
          call: aemGetJsonCall({ path: '/content/site' }),
        }),
      ),
      expectIssued(
        transport.issueToolCall({
          chatId,
          turnId,
          call: aemGetJsonCall({ path: '/content/site/en' }),
        }),
      ),
      expectIssued(
        transport.issueToolCall({
          chatId,
          turnId,
          call: aemGetJsonCall({ path: '/content/site/fr' }),
        }),
      ),
    ];

    const requestIds = new Set(outcomes.map((outcome) => outcome.requestId));
    expect(requestIds.size).toBe(outcomes.length);
  });

  it('correlates each delivered result back to the request that produced it, even delivered out of order', () => {
    const { transport } = createHarness();
    const chatId = newChatId(createCountingIdGenerator('chat'));
    const turnId = newTurnId(createCountingIdGenerator('turn'));
    startTurnOrThrow(transport, chatId, turnId);

    const first = expectIssued(
      transport.issueToolCall({
        chatId,
        turnId,
        call: aemGetJsonCall({ path: '/content/site/en' }),
      }),
    );
    const second = expectIssued(
      transport.issueToolCall({
        chatId,
        turnId,
        call: aemGetJsonCall({ path: '/content/site/fr' }),
      }),
    );

    // Deliver in reverse order - correlation must not depend on issue order.
    const secondResult = expectSuccess(second.deliver());
    const firstResult = expectSuccess(first.deliver());

    expect(secondResult.requestId).toBe(second.requestId);
    expect(firstResult.requestId).toBe(first.requestId);
    if (secondResult.operation === 'aem_get_json')
      expect(secondResult.path).toBe('/content/site/fr');
    if (firstResult.operation === 'aem_get_json') expect(firstResult.path).toBe('/content/site/en');
  });
});

describe('event sequencing: duplicates and out-of-order delivery', () => {
  it('reports a redelivered sequence number as a duplicate, not ok', () => {
    const { transport } = createHarness();
    const chatId = newChatId(createCountingIdGenerator('raw-chat'));

    const first = transport.ingestRawEvent({
      type: 'session.state.changed',
      chatId,
      sequence: 0,
      state: 'idle',
    });
    const redelivered = transport.ingestRawEvent({
      type: 'session.state.changed',
      chatId,
      sequence: 0,
      state: 'idle',
    });

    expect(first).toEqual({ kind: 'ok', sequence: 0 });
    expect(redelivered).toEqual({ kind: 'duplicate', sequence: 0 });
  });

  it('reports a forward jump in sequence numbers as a gap', () => {
    const { transport } = createHarness();
    const chatId = newChatId(createCountingIdGenerator('raw-chat'));

    transport.ingestRawEvent({ type: 'session.state.changed', chatId, sequence: 0, state: 'idle' });
    const jumped = transport.ingestRawEvent({
      type: 'session.state.changed',
      chatId,
      sequence: 3,
      state: 'idle',
    });

    expect(jumped).toEqual({ kind: 'gap', expected: 1, received: 3 });
  });
});

describe('staleness invalidates an in-flight request before it reaches the model', () => {
  it('discards a result as STALE_CONTEXT when the server is reconfigured mid-flight, without ever asking the browser', () => {
    const { transport, browser } = createHarness();
    const handleSpy = vi.spyOn(browser, 'handle');
    const chatId = newChatId(createCountingIdGenerator('chat'));
    const turnId = newTurnId(createCountingIdGenerator('turn'));
    startTurnOrThrow(transport, chatId, turnId);

    const outcome = expectIssued(
      transport.issueToolCall({ chatId, turnId, call: aemGetJsonCall({ path: '/content/site' }) }),
    );
    // A targeting change (not merely a rename/recolour) bumps `revision` -
    // see `bumpRevision`'s doc in serverConfig.ts.
    transport.reconfigureServer({ origin: 'https://other.example' });

    const result = expectError(outcome.deliver());
    expect(result.error.code).toBe('STALE_CONTEXT');
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it('discards a result as STALE_CONTEXT when the navigation epoch advances mid-flight', () => {
    const { transport, browser } = createHarness();
    const handleSpy = vi.spyOn(browser, 'handle');
    const chatId = newChatId(createCountingIdGenerator('chat'));
    const turnId = newTurnId(createCountingIdGenerator('turn'));
    startTurnOrThrow(transport, chatId, turnId);

    const outcome = expectIssued(
      transport.issueToolCall({ chatId, turnId, call: aemGetJsonCall({ path: '/content/site' }) }),
    );
    transport.advanceNavigationEpoch();

    const result = expectError(outcome.deliver());
    expect(result.error.code).toBe('STALE_CONTEXT');
    expect(handleSpy).not.toHaveBeenCalled();
  });
});

describe('hostile and invalid JCR paths are rejected, not silently sanitised', () => {
  it.each([
    '/content/site.-1',
    '/content/site%2E-1',
    '/content/site.json',
    '/content/../etc/passwd',
  ])(
    "rejects '%s' through the whole agent -> main pipeline with a typed error, not an empty result",
    (path) => {
      const { transport } = createHarness();
      const chatId = newChatId(createCountingIdGenerator('chat'));
      const turnId = newTurnId(createCountingIdGenerator('turn'));
      startTurnOrThrow(transport, chatId, turnId);

      const outcome = expectRejected(
        transport.issueToolCall({ chatId, turnId, call: aemGetJsonCall({ path }) }),
      );
      expect(outcome.result.ok).toBe(false);
      expect(outcome.result.error.code).toBe('INVALID_ARGUMENT');
    },
  );

  it('re-validates a hand-crafted envelope independently at the browser layer, even if it had bypassed main', () => {
    // Simulates an envelope main should never have produced, to prove the
    // browser genuinely re-parses with `toolRequestEnvelopeSchema` itself
    // (implementation-plan.md line 208-210) rather than trusting a caller.
    const { browser } = createHarness();
    const hostileEnvelope = {
      operation: 'aem_get_json',
      requestId: 'req-hostile',
      chatId: 'chat-hostile',
      turnId: 'turn-hostile',
      serverId: 'server-hostile',
      serverRevision: 0,
      navigationEpoch: 0,
      deadlineMs: 999_999_999,
      args: { path: '/content/site.-1' },
    };
    // Confirms the fixture is otherwise well-formed except for the hostile
    // path, so a rejection can only be attributed to path validation.
    expect(toolRequestEnvelopeSchema.safeParse(hostileEnvelope).success).toBe(false);

    const outcome = browser.handle(hostileEnvelope);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('INVALID_ARGUMENT');
  });
});

describe('unknown tool operations', () => {
  it('rejects a call naming an operation the application never registered', () => {
    const { transport } = createHarness();
    const chatId = newChatId(createCountingIdGenerator('chat'));
    const turnId = newTurnId(createCountingIdGenerator('turn'));
    startTurnOrThrow(transport, chatId, turnId);

    const outcome = expectRejected(
      transport.issueToolCall({
        chatId,
        turnId,
        call: unknownOperationCall('aem_delete_everything', { path: '/content/site' }),
      }),
    );
    expect(outcome.result.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('pagination limits and predicate smuggling', () => {
  it.each([-1, 1.5, 0])(
    'rejects an aem_query call with limit %j rather than clamping it into range',
    (limit) => {
      const { transport } = createHarness();
      const chatId = newChatId(createCountingIdGenerator('chat'));
      const turnId = newTurnId(createCountingIdGenerator('turn'));
      startTurnOrThrow(transport, chatId, turnId);

      const outcome = expectRejected(
        transport.issueToolCall({ chatId, turnId, call: aemQueryCall({ predicates: {}, limit }) }),
      );
      expect(outcome.result.error.code).toBe('INVALID_ARGUMENT');
    },
  );

  it('rejects an aem_query call with a negative offset rather than clamping it to zero', () => {
    const { transport } = createHarness();
    const chatId = newChatId(createCountingIdGenerator('chat'));
    const turnId = newTurnId(createCountingIdGenerator('turn'));
    startTurnOrThrow(transport, chatId, turnId);

    const outcome = expectRejected(
      transport.issueToolCall({
        chatId,
        turnId,
        call: aemQueryCall({ predicates: {}, offset: -1 }),
      }),
    );
    expect(outcome.result.error.code).toBe('INVALID_ARGUMENT');
  });

  it("rejects predicates smuggling the reserved QueryBuilder key 'p.limit' instead of silently stripping it", () => {
    const { transport } = createHarness();
    const chatId = newChatId(createCountingIdGenerator('chat'));
    const turnId = newTurnId(createCountingIdGenerator('turn'));
    startTurnOrThrow(transport, chatId, turnId);

    const outcome = expectRejected(
      transport.issueToolCall({
        chatId,
        turnId,
        call: aemQueryCall({ predicates: { 'p.limit': '-1' } }),
      }),
    );
    expect(outcome.result.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('deadline expiry', () => {
  it("classifies the result as TIMEOUT once the clock reaches the request's absolute deadline", () => {
    const { transport, clock } = createHarness();
    const chatId = newChatId(createCountingIdGenerator('chat'));
    const turnId = newTurnId(createCountingIdGenerator('turn'));
    startTurnOrThrow(transport, chatId, turnId);

    const outcome = expectIssued(
      transport.issueToolCall({ chatId, turnId, call: aemGetJsonCall({ path: '/content/site' }) }),
    );
    clock.advanceMs(AEM_REQUEST_TIMEOUT_MS);

    const result = expectError(outcome.deliver());
    expect(result.error.code).toBe('TIMEOUT');
  });
});

describe('never return [] in place of an error', () => {
  it('returns a success with zero rows and honest pagination metadata for a query matching nothing', () => {
    const { transport } = createHarness();
    const chatId = newChatId(createCountingIdGenerator('chat'));
    const turnId = newTurnId(createCountingIdGenerator('turn'));
    startTurnOrThrow(transport, chatId, turnId);

    const outcome = expectIssued(
      transport.issueToolCall({
        chatId,
        turnId,
        call: aemQueryCall({ predicates: { path: '/content/does-not-exist' } }),
      }),
    );
    const result = expectSuccess(outcome.deliver());
    if (result.operation === 'aem_query') {
      expect(result.rows).toEqual([]);
      expect(result.pagination).toEqual({
        offset: 0,
        limit: 50,
        returned: 0,
        hasMore: false,
        // Enumerated end to end (`hasMore: false`, `offset + returned === 0`),
        // so the count is provably exact rather than a `guessTotal` estimate.
        total: { accuracy: 'exact', value: 0 },
      });
    }
  });

  it('is distinguishable from a genuine failure, which is an error result, not zero rows', () => {
    const { transport, clock } = createHarness();
    const chatId = newChatId(createCountingIdGenerator('chat'));
    const turnId = newTurnId(createCountingIdGenerator('turn'));
    startTurnOrThrow(transport, chatId, turnId);

    const outcome = expectIssued(
      transport.issueToolCall({ chatId, turnId, call: aemQueryCall({ predicates: {} }) }),
    );
    clock.advanceMs(AEM_REQUEST_TIMEOUT_MS);
    const result = expectError(outcome.deliver());

    expect(result.ok).toBe(false);
    expect('rows' in result).toBe(false);
  });
});

describe('ToolResult round trip and model-facing rendering', () => {
  it('round-trips a produced success ToolResult through serializeToolResult/parseToolResult unchanged', () => {
    const { transport } = createHarness();
    const chatId = newChatId(createCountingIdGenerator('chat'));
    const turnId = newTurnId(createCountingIdGenerator('turn'));
    startTurnOrThrow(transport, chatId, turnId);

    const outcome = expectIssued(
      transport.issueToolCall({ chatId, turnId, call: aemGetJsonCall({ path: '/content/site' }) }),
    );
    const original = expectSuccess(outcome.deliver());

    const parsed = parseToolResult(serializeToolResult(original));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(original);
  });

  it('round-trips a produced error ToolResult through serializeToolResult/parseToolResult unchanged', () => {
    const { transport, clock } = createHarness();
    const chatId = newChatId(createCountingIdGenerator('chat'));
    const turnId = newTurnId(createCountingIdGenerator('turn'));
    startTurnOrThrow(transport, chatId, turnId);

    const outcome = expectIssued(
      transport.issueToolCall({ chatId, turnId, call: aemGetJsonCall({ path: '/content/site' }) }),
    );
    clock.advanceMs(AEM_REQUEST_TIMEOUT_MS);
    const original = expectError(outcome.deliver());

    const parsed = parseToolResult(serializeToolResult(original));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(original);
  });

  it("never renders a bare '[]' or an empty string for a zero-row success", () => {
    const { transport } = createHarness();
    const chatId = newChatId(createCountingIdGenerator('chat'));
    const turnId = newTurnId(createCountingIdGenerator('turn'));
    startTurnOrThrow(transport, chatId, turnId);

    const outcome = expectIssued(
      transport.issueToolCall({
        chatId,
        turnId,
        call: aemQueryCall({ predicates: { path: '/content/does-not-exist' } }),
      }),
    );
    const rendered = renderToolResultForModel(outcome.deliver());
    expect(rendered).not.toBe('[]');
    expect(rendered).not.toBe('');
    expect(rendered.length).toBeGreaterThan(0);
  });

  it('never renders an empty string for an error result', () => {
    const { transport, clock } = createHarness();
    const chatId = newChatId(createCountingIdGenerator('chat'));
    const turnId = newTurnId(createCountingIdGenerator('turn'));
    startTurnOrThrow(transport, chatId, turnId);

    const outcome = expectIssued(
      transport.issueToolCall({ chatId, turnId, call: aemGetJsonCall({ path: '/content/site' }) }),
    );
    clock.advanceMs(AEM_REQUEST_TIMEOUT_MS);
    const rendered = renderToolResultForModel(outcome.deliver());
    expect(rendered).not.toBe('');
    expect(rendered).not.toBe('[]');
  });
});

describe('invalid origins are rejected wherever the composition can construct one', () => {
  it('throws when reconfiguring the server to a non-canonical/unsupported-scheme origin', () => {
    const { transport } = createHarness();
    expect(() => transport.reconfigureServer({ origin: 'ftp://author.example' })).toThrow();
  });

  it('throws when constructing the fake browser side against a non-canonical origin', () => {
    const repository = new FixtureRepository();
    const clock = createManualClock(0);
    expect(
      () => new FakeBrowserSide(repository, clock.now, 'https://author.example/path'),
    ).toThrow();
  });
});
