import { describe, expect, it, vi } from 'vitest';

import {
  createSdkAgentService,
  type AemToolExecutor,
  type AgentAuthStatusSource,
} from '../../../../src/agents/copilot/sdkAgentService';
import type {
  HardenedSessionClient,
  HardenedToolPolicy,
} from '../../../../src/agents/copilot/toolPolicy';
import type { AgentEvent, ModelPreference } from '../../../../src/shared';
import { createToolError, type ToolError } from '../../../../src/shared';
import {
  newChatId,
  newRequestId,
  newTurnId,
  sdkSessionIdSchema,
  type IdGenerator,
} from '../../../../src/shared';
import { applyAgentEvent, type SessionStatus } from '../../../../src/shared';
import { err, ok } from '../../../../src/shared';
import type { AuthStatus } from '../../../../src/shared';

/** Mints reproducible `ChatId`/`TurnId` values - never SDK-facing ids, which the adapter adopts instead. */
function counterIdGenerator(): IdGenerator {
  let counter = 0;
  return () => `test-id-${String(counter++)}`;
}

function idleStatus(): SessionStatus {
  return { state: 'idle', authenticated: true, browserReady: true };
}

/** Same outside-in legality check `fakeAgentService.test.ts` uses, applied independently of the adapter's own self-check. */
function assertLegalSequence(events: readonly AgentEvent[]): SessionStatus {
  let status = idleStatus();
  for (const event of events) {
    const applied = applyAgentEvent(status, event);
    expect(
      applied.ok,
      `event ${JSON.stringify(event)} was rejected: ${JSON.stringify(applied)}`,
    ).toBe(true);
    if (applied.ok) status = applied.value;
  }
  return status;
}

// `Awaited<ReturnType<HardenedSessionClient["createSession"]>>` is `CopilotSession`
// (a real-SDK type). Derived structurally rather than imported directly - only
// `src/agent/**` may import `@github/copilot-sdk`, even for types (see
// `toolPolicy.test.ts`'s identical rationale).
type FakeSession = Awaited<ReturnType<HardenedSessionClient['createSession']>>;

/**
 * Minimal local stand-in for the SDK's `SessionEvent` union member the test
 * needs to construct by hand. Deliberately untyped against the real SDK
 * union (see the `FakeSession` comment above) - each test builds exactly the
 * fields `sdkAgentService.ts` reads for that event `type`.
 */
interface FakeSdkEvent {
  readonly type: string;
  readonly agentId?: string;
  readonly data: Record<string, unknown>;
}

interface FakeSessionHandle {
  readonly session: FakeSession;
  readonly send: ReturnType<typeof vi.fn<(options: { prompt: string }) => Promise<string>>>;
  readonly abort: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly disconnect: ReturnType<typeof vi.fn<() => Promise<void>>>;
  /** Step 09's in-place model switch. See `sdkAgentService.ts`'s `sendPrompt`. */
  readonly setModel: ReturnType<
    typeof vi.fn<(model: string, options: { reasoningEffort?: string }) => Promise<void>>
  >;
  /** Fires `event` on whichever handler is currently registered via `session.on(...)`, if any. */
  emit(event: FakeSdkEvent): void;
}

function makeFakeSession(): FakeSessionHandle {
  let handler: ((event: FakeSdkEvent) => void) | undefined;
  const send = vi.fn<(options: { prompt: string }) => Promise<string>>(() =>
    Promise.resolve('sdk-message-id'),
  );
  const abort = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const disconnect = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const setModel = vi.fn<(model: string, options: { reasoningEffort?: string }) => Promise<void>>(
    () => Promise.resolve(),
  );
  const on = vi.fn((h: (event: FakeSdkEvent) => void) => {
    handler = h;
    return () => {
      if (handler === h) handler = undefined;
    };
  });
  // `createHardenedSession`/`resumeHardenedSession` (toolPolicy.ts) always
  // apply a post-create options patch via this RPC - see
  // `toolPolicy.test.ts`'s identical fixture for why it must be present.
  const update = vi.fn(() => Promise.resolve({ success: true }));
  const session = {
    sessionId: 'fake-session-id',
    on,
    send,
    abort,
    disconnect,
    setModel,
    rpc: { options: { update } },
  } as unknown as FakeSession;
  return {
    session,
    send,
    abort,
    disconnect,
    setModel,
    emit: (event) => handler?.(event),
  };
}

// `Parameters<HardenedSessionClient["createSession"]>[0]` is `SessionConfig`
// (a real-SDK type); `["tools"]`/`["handler"]`/second handler parameter are
// derived structurally the same way, so this file never names an SDK type -
// see the `FakeSession` comment above for the rule this follows.
type FakeSessionConfig = Parameters<HardenedSessionClient['createSession']>[0];
type FakeTool = NonNullable<FakeSessionConfig['tools']>[number];
type FakeToolHandler = NonNullable<FakeTool['handler']>;
type FakeToolInvocation = Parameters<FakeToolHandler>[1];

function makeFakeClient(session: FakeSession): {
  client: HardenedSessionClient;
  createSession: ReturnType<typeof vi.fn<HardenedSessionClient['createSession']>>;
  resumeSession: ReturnType<typeof vi.fn<HardenedSessionClient['resumeSession']>>;
} {
  const createSession = vi.fn<HardenedSessionClient['createSession']>(() =>
    Promise.resolve(session),
  );
  const resumeSession = vi.fn<HardenedSessionClient['resumeSession']>(() =>
    Promise.resolve(session),
  );
  return { client: { createSession, resumeSession }, createSession, resumeSession };
}

/**
 * Finds the SDK `Tool.handler` this adapter registered for `toolName` on the
 * config it passed to `createSession`, so a test can call it exactly the way
 * the real SDK would - directly, with no `tool.execution_complete` round
 * trip involved (see finding 3).
 */
function findRegisteredToolHandler(
  createSession: ReturnType<typeof vi.fn<HardenedSessionClient['createSession']>>,
  toolName: string,
): FakeToolHandler {
  const config = createSession.mock.calls[0]?.[0];
  const tool = config?.tools?.find((candidate) => candidate.name === toolName);
  if (tool?.handler === undefined) {
    throw new Error(`test setup: tool "${toolName}" was not registered on session creation.`);
  }
  return tool.handler;
}

function makeAuthSource(initial: AuthStatus = { apiVersion: 1, isAuthenticated: true }): {
  source: AgentAuthStatusSource;
  set: (next: AuthStatus) => void;
} {
  let current: AuthStatus = initial;
  return {
    source: { getAuthStatus: () => Promise.resolve(current) },
    set: (next: AuthStatus) => {
      current = next;
    },
  };
}

const POLICY: HardenedToolPolicy = { availableTools: [] };

/** Builds a service already wired to `sessionHandle` and past `initialize()`/`openConversation()`. */
async function setUpOpenConversation(
  sessionHandle: FakeSessionHandle,
  ids: IdGenerator,
  authInitial?: AuthStatus,
  toolHandlers?: Readonly<Record<string, AemToolExecutor>>,
) {
  const { client, createSession, resumeSession } = makeFakeClient(sessionHandle.session);
  const { source: authSource, set: setAuth } = makeAuthSource(authInitial);
  const service = createSdkAgentService({
    client,
    policy: POLICY,
    authSource,
    idGenerator: ids,
    ...(toolHandlers !== undefined ? { toolHandlers } : {}),
  });
  const events: AgentEvent[] = [];
  service.onEvent((event) => events.push(event));

  expect((await service.initialize()).ok).toBe(true);
  const chatId = newChatId(ids);
  expect((await service.openConversation({ chatId })).ok).toBe(true);

  return { service, chatId, events, setAuth, createSession, resumeSession };
}

describe('sdkAgentService - delta accumulation and completion', () => {
  it("accumulates streamed deltas, then REPLACES them with the completed message's content (no duplication)", async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const { service, chatId, events } = await setUpOpenConversation(sessionHandle, ids);

    const turnId = newTurnId(ids);
    const sent = await service.sendPrompt({ chatId, turnId, prompt: 'hi' });
    expect(sent.ok).toBe(true);

    sessionHandle.emit({
      type: 'assistant.message_start',
      data: { messageId: 'msg-1' },
    });
    sessionHandle.emit({
      type: 'assistant.message_delta',
      data: { messageId: 'msg-1', deltaContent: 'Hello, ' },
    });
    sessionHandle.emit({
      type: 'assistant.message_delta',
      data: { messageId: 'msg-1', deltaContent: 'world!' },
    });
    sessionHandle.emit({
      type: 'assistant.message',
      data: { messageId: 'msg-1', content: 'Hello, world!' },
    });
    sessionHandle.emit({ type: 'session.idle', data: {} });

    const deltas = events.filter((event) => event.type === 'assistant.text.delta');
    expect(deltas.map((event) => (event as { delta: string }).delta)).toEqual([
      'Hello, ',
      'world!',
    ]);

    const completed = events.find((event) => event.type === 'assistant.message.completed');
    expect(completed).toMatchObject({ content: 'Hello, world!' });

    assertLegalSequence(events);
  });

  it("does not duplicate content when the SDK's final message legitimately differs from the streamed deltas", async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const { service, chatId, events } = await setUpOpenConversation(sessionHandle, ids);
    const turnId = newTurnId(ids);
    await service.sendPrompt({ chatId, turnId, prompt: 'hi' });

    sessionHandle.emit({ type: 'assistant.message_start', data: { messageId: 'msg-1' } });
    sessionHandle.emit({
      type: 'assistant.message_delta',
      data: { messageId: 'msg-1', deltaContent: 'draft' },
    });
    sessionHandle.emit({
      type: 'assistant.message',
      data: { messageId: 'msg-1', content: 'post-processed final' },
    });

    const completed = events.find((event) => event.type === 'assistant.message.completed');
    // The completed content is exactly the SDK's final content - never
    // "draft" and never "draftpost-processed final".
    expect(completed).toMatchObject({ content: 'post-processed final' });
  });
});

describe('sdkAgentService - reasoning projection', () => {
  it('maps reasoning deltas and the completed block, keyed by reasoningId and turn', async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const { service, chatId, events } = await setUpOpenConversation(sessionHandle, ids);
    const turnId = newTurnId(ids);
    await service.sendPrompt({ chatId, turnId, prompt: 'hi' });

    sessionHandle.emit({ type: 'assistant.message_start', data: { messageId: 'msg-1' } });
    sessionHandle.emit({
      type: 'assistant.reasoning_delta',
      data: { reasoningId: 'reason-1', deltaContent: 'Let me think' },
    });
    // An empty chunk carries nothing and must not be forwarded.
    sessionHandle.emit({
      type: 'assistant.reasoning_delta',
      data: { reasoningId: 'reason-1', deltaContent: '' },
    });
    sessionHandle.emit({
      type: 'assistant.reasoning_delta',
      data: { reasoningId: 'reason-1', deltaContent: ' about it.' },
    });
    sessionHandle.emit({
      type: 'assistant.reasoning',
      data: { reasoningId: 'reason-1', content: 'Let me think about it.' },
    });
    sessionHandle.emit({
      type: 'assistant.message',
      data: { messageId: 'msg-1', content: 'Done' },
    });

    const deltas = events.filter((event) => event.type === 'assistant.reasoning.delta');
    expect(deltas.map((event) => (event as { delta: string }).delta)).toEqual([
      'Let me think',
      ' about it.',
    ]);
    expect(deltas[0]).toMatchObject({ reasoningId: 'reason-1', turnId });

    const completed = events.find((event) => event.type === 'assistant.reasoning.completed');
    expect(completed).toMatchObject({
      reasoningId: 'reason-1',
      content: 'Let me think about it.',
      turnId,
    });

    assertLegalSequence(events);
  });

  it('drops reasoning that arrives with no turn in flight', async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const { events } = await setUpOpenConversation(sessionHandle, ids);

    sessionHandle.emit({
      type: 'assistant.reasoning_delta',
      data: { reasoningId: 'reason-1', deltaContent: 'stray' },
    });

    expect(events.some((event) => event.type.startsWith('assistant.reasoning'))).toBe(false);
  });
});

describe('sdkAgentService - sub-agent event filtering', () => {
  it('drops every event carrying a defined agentId', async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const { service, chatId, events } = await setUpOpenConversation(sessionHandle, ids);
    const turnId = newTurnId(ids);
    await service.sendPrompt({ chatId, turnId, prompt: 'hi' });

    sessionHandle.emit({ type: 'assistant.message_start', data: { messageId: 'msg-1' } });
    // A sub-agent event using the SAME messageId/content a naive accumulator
    // would happily fold in - it must never reach a listener.
    sessionHandle.emit({
      type: 'assistant.message_delta',
      agentId: 'sub-agent-1',
      data: { messageId: 'msg-1', deltaContent: 'from another agent' },
    });
    sessionHandle.emit({
      type: 'assistant.message_delta',
      data: { messageId: 'msg-1', deltaContent: 'top-level text' },
    });

    const deltas = events.filter((event) => event.type === 'assistant.text.delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ delta: 'top-level text' });
  });

  /**
   * The delta test above exercises a case the SDK's own config-level
   * `includeSubAgentStreamingEvents: false` (toolPolicy.ts) already
   * suppresses upstream in a real session - so on its own it does not prove
   * this adapter's `agentId` filter earns its place; a fake SDK is free to
   * emit an event a real, correctly-configured session never would.
   *
   * Per the SDK's own doc comment, that config flag suppresses sub-agent
   * *streaming deltas* only - a non-streaming sub-agent event (e.g. a
   * completed message) is still forwarded regardless. This test emits
   * exactly that: a sub-agent's own `assistant.message` for the SAME
   * `messageId` the top-level turn is using, sent before the real one
   * arrives. Without the adapter's own filter, this would complete
   * "msg-1" early with the sub-agent's leaked content; the filter is the
   * only thing standing between the two.
   */
  it('drops a non-streaming sub-agent event too, which the config-level suppression does not cover', async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const { service, chatId, events } = await setUpOpenConversation(sessionHandle, ids);
    const turnId = newTurnId(ids);
    await service.sendPrompt({ chatId, turnId, prompt: 'hi' });

    sessionHandle.emit({ type: 'assistant.message_start', data: { messageId: 'msg-1' } });
    sessionHandle.emit({
      type: 'assistant.message',
      agentId: 'sub-agent-1',
      data: { messageId: 'msg-1', content: 'leaked sub-agent content' },
    });
    sessionHandle.emit({
      type: 'assistant.message',
      data: { messageId: 'msg-1', content: 'real answer' },
    });

    const completed = events.filter((event) => event.type === 'assistant.message.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ content: 'real answer' });
  });
});

describe('sdkAgentService - tool lifecycle', () => {
  it("maps the guaranteed external_tool.requested pair, then emits tool.result from the registered executor's own resolution (not from any SDK round trip)", async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const executor = vi.fn<AemToolExecutor>(() => Promise.resolve(ok({ ok: true })));
    const { service, chatId, events, createSession } = await setUpOpenConversation(
      sessionHandle,
      ids,
      undefined,
      { aem_get_json: executor },
    );
    const turnId = newTurnId(ids);
    await service.sendPrompt({ chatId, turnId, prompt: 'hi' });
    // An assistant message starts first here to exercise the
    // `streaming` -> `runningTool` path; the tool-first path (no message
    // start) is covered separately below.
    sessionHandle.emit({ type: 'assistant.message_start', data: { messageId: 'msg-1' } });

    sessionHandle.emit({
      type: 'external_tool.requested',
      data: {
        requestId: 'req-1',
        toolCallId: 'tool-1',
        toolName: 'aem_get_json',
        arguments: { path: '/content/foo.json' },
      },
    });

    // Drives the registered handler directly, exactly the way the real SDK's
    // own `_executeToolAndRespond` would - see finding 3.
    const handler = findRegisteredToolHandler(createSession, 'aem_get_json');
    const controller = new AbortController();
    const invocation: FakeToolInvocation = {
      sessionId: 'fake-session-id',
      toolCallId: 'tool-1',
      toolName: 'aem_get_json',
      arguments: { path: '/content/foo.json' },
      signal: controller.signal,
    };
    await handler({ path: '/content/foo.json' }, invocation);

    expect(events.find((event) => event.type === 'tool.call.requested')).toMatchObject({
      toolName: 'aem_get_json',
      arguments: { path: '/content/foo.json' },
    });
    expect(events.some((event) => event.type === 'tool.call.approved')).toBe(true);
    expect(events.find((event) => event.type === 'tool.result')).toMatchObject({
      outcome: { ok: true, data: { ok: true } },
    });
    // Requirement 5: the SDK-supplied signal reaches the executor unchanged.
    expect(executor).toHaveBeenCalledWith(
      { path: '/content/foo.json' },
      expect.objectContaining({ toolCallId: 'tool-1', signal: controller.signal }),
    );

    assertLegalSequence(events);
  });

  it("accepts a tool call that is the turn's first activity, with no preceding assistant.message_start (the live sending -> runningTool case)", async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const executor = vi.fn<AemToolExecutor>(() => Promise.resolve(ok({ ok: true })));
    const { service, chatId, events } = await setUpOpenConversation(sessionHandle, ids, undefined, {
      aem_get_json: executor,
    });
    const turnId = newTurnId(ids);
    await service.sendPrompt({ chatId, turnId, prompt: 'hi' });

    // The model's first action is the tool call - no assistant message start.
    sessionHandle.emit({
      type: 'external_tool.requested',
      data: {
        requestId: 'req-1',
        toolCallId: 'tool-1',
        toolName: 'aem_get_json',
        arguments: { path: '/content/foo.json' },
      },
    });

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.find((event) => event.type === 'tool.call.requested')).toBeDefined();
    expect(assertLegalSequence(events).state).toBe('runningTool');
  });

  it("maps a rejected executor to a tool.result with ok: false, carrying the executor's own ToolError, and renders that same failure back to the SDK instead of throwing", async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const toolError: ToolError = createToolError('UNEXPECTED_RESPONSE', 'boom', newRequestId(ids));
    const executor = vi.fn<AemToolExecutor>(() => Promise.resolve(err(toolError)));
    const { service, chatId, events, createSession } = await setUpOpenConversation(
      sessionHandle,
      ids,
      undefined,
      { aem_get_json: executor },
    );
    const turnId = newTurnId(ids);
    await service.sendPrompt({ chatId, turnId, prompt: 'hi' });
    sessionHandle.emit({ type: 'assistant.message_start', data: { messageId: 'msg-1' } });

    sessionHandle.emit({
      type: 'external_tool.requested',
      data: { requestId: 'req-1', toolCallId: 'tool-1', toolName: 'aem_get_json', arguments: {} },
    });

    const handler = findRegisteredToolHandler(createSession, 'aem_get_json');
    const invocation: FakeToolInvocation = {
      sessionId: 'fake-session-id',
      toolCallId: 'tool-1',
      toolName: 'aem_get_json',
      arguments: {},
    };
    // A failure is a designed outcome now, not an exception: the wrapper
    // renders it and returns normally (never throws), so the model still
    // reads the error text/code/requiredAction the same way the UI's own
    // `tool.result` below carries it.
    const handled = (await handler({}, invocation)) as {
      textResultForLlm: string;
      resultType: string;
    };
    expect(handled.resultType).toBe('failure');
    expect(handled.textResultForLlm).toContain('boom');
    expect(handled.textResultForLlm).toContain('UNEXPECTED_RESPONSE');

    const result = events.find((event) => event.type === 'tool.result');
    expect(result).toMatchObject({ outcome: { ok: false, error: toolError } });
    assertLegalSequence(events);
  });

  it('emits no tool.result when the turn was aborted before the executor settled', async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    let resolveExecutor: (() => void) | undefined;
    const executor = vi.fn<AemToolExecutor>(
      () =>
        new Promise((resolve) => {
          resolveExecutor = () => resolve(ok({ ok: true }));
        }),
    );
    const { service, chatId, events, createSession } = await setUpOpenConversation(
      sessionHandle,
      ids,
      undefined,
      { aem_get_json: executor },
    );
    const turnId = newTurnId(ids);
    await service.sendPrompt({ chatId, turnId, prompt: 'hi' });
    sessionHandle.emit({ type: 'assistant.message_start', data: { messageId: 'msg-1' } });
    sessionHandle.emit({
      type: 'external_tool.requested',
      data: { requestId: 'req-1', toolCallId: 'tool-1', toolName: 'aem_get_json', arguments: {} },
    });

    const handler = findRegisteredToolHandler(createSession, 'aem_get_json');
    const invocation: FakeToolInvocation = {
      sessionId: 'fake-session-id',
      toolCallId: 'tool-1',
      toolName: 'aem_get_json',
      arguments: {},
    };
    const pending = handler({}, invocation);

    // Abort while the executor is still "running" - `performAbort` clears
    // `currentTurn` synchronously, before this promise ever settles.
    const aborted = await service.abort(chatId);
    expect(aborted.ok).toBe(true);
    expect(
      events.some(
        (event) => event.type === 'session.state.changed' && event.state === 'cancelling',
      ),
    ).toBe(true);

    resolveExecutor?.();
    await pending;

    expect(events.some((event) => event.type === 'tool.result')).toBe(false);
    assertLegalSequence(events);
  });
});

describe('sdkAgentService - abort', () => {
  interface AbortOrigin {
    readonly name: 'sending' | 'streaming' | 'runningTool';
    readonly advance: (sessionHandle: FakeSessionHandle) => void;
  }

  const origins: readonly AbortOrigin[] = [
    { name: 'sending', advance: () => {} },
    {
      name: 'streaming',
      advance: (sessionHandle) => {
        sessionHandle.emit({ type: 'assistant.message_start', data: { messageId: 'msg-1' } });
      },
    },
    {
      name: 'runningTool',
      advance: (sessionHandle) => {
        sessionHandle.emit({ type: 'assistant.message_start', data: { messageId: 'msg-1' } });
        sessionHandle.emit({
          type: 'external_tool.requested',
          data: {
            requestId: 'req-1',
            toolCallId: 'tool-1',
            toolName: 'aem_get_json',
            arguments: {},
          },
        });
      },
    },
  ];

  for (const origin of origins) {
    it(`aborting while ${origin.name} emits "cancelling" then "idle" (never "error")`, async () => {
      const ids = counterIdGenerator();
      const sessionHandle = makeFakeSession();
      const { service, chatId, events } = await setUpOpenConversation(sessionHandle, ids);
      const turnId = newTurnId(ids);
      await service.sendPrompt({ chatId, turnId, prompt: 'hi' });
      origin.advance(sessionHandle);

      const eventsBeforeAbort = events.length;
      const aborted = await service.abort(chatId);
      expect(aborted.ok).toBe(true);
      expect(sessionHandle.abort).toHaveBeenCalledTimes(1);

      const afterAbort = events.slice(eventsBeforeAbort);
      expect(afterAbort).toHaveLength(2);
      expect(afterAbort[0]).toMatchObject({ type: 'session.state.changed', state: 'cancelling' });
      expect(afterAbort[1]).toMatchObject({ type: 'session.state.changed', state: 'idle' });
      expect(events.some((event) => event.type === 'error')).toBe(false);

      const finalStatus = assertLegalSequence(events);
      expect(finalStatus.state).toBe('idle');
    });
  }

  it('suppresses further events for the aborted turn even if the SDK emits them late', async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const { service, chatId, events } = await setUpOpenConversation(sessionHandle, ids);
    const turnId = newTurnId(ids);
    await service.sendPrompt({ chatId, turnId, prompt: 'hi' });
    sessionHandle.emit({ type: 'assistant.message_start', data: { messageId: 'msg-1' } });

    await service.abort(chatId);
    const countAfterAbort = events.length;

    // The real SDK genuinely can emit further events for the aborted turn;
    // simulate one arriving late.
    sessionHandle.emit({
      type: 'assistant.message_delta',
      data: { messageId: 'msg-1', deltaContent: 'too late' },
    });
    sessionHandle.emit({
      type: 'assistant.message',
      data: { messageId: 'msg-1', content: 'too late, complete' },
    });

    expect(events).toHaveLength(countAfterAbort);
  });

  it('aborting with nothing in flight is a no-op success', async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const { service, chatId, events } = await setUpOpenConversation(sessionHandle, ids);

    const result = await service.abort(chatId);
    expect(result.ok).toBe(true);
    expect(events).toHaveLength(0);
    expect(sessionHandle.abort).not.toHaveBeenCalled();
  });
});

describe('sdkAgentService - one turn at a time', () => {
  it('a second sendPrompt over an unfinished turn is refused immediately', async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const { service, chatId } = await setUpOpenConversation(sessionHandle, ids);

    const first = await service.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'first' });
    expect(first.ok).toBe(true);

    const second = await service.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'second' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('PRECONDITION_FAILED');
  });
});

describe('sdkAgentService - unsubscribe', () => {
  it("onEvent's returned Unsubscribe actually stops delivery", async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const { client } = makeFakeClient(sessionHandle.session);
    const { source: authSource } = makeAuthSource();
    const service = createSdkAgentService({ client, policy: POLICY, authSource, idGenerator: ids });
    await service.initialize();
    const chatId = newChatId(ids);
    await service.openConversation({ chatId });

    const events: AgentEvent[] = [];
    const unsubscribe = service.onEvent((event) => events.push(event));

    await service.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'hi' });
    sessionHandle.emit({ type: 'assistant.message_start', data: { messageId: 'msg-1' } });
    const countBeforeUnsubscribe = events.length;
    expect(countBeforeUnsubscribe).toBeGreaterThan(0);

    unsubscribe();

    sessionHandle.emit({
      type: 'assistant.message_delta',
      data: { messageId: 'msg-1', deltaContent: 'after unsubscribe' },
    });

    expect(events).toHaveLength(countBeforeUnsubscribe);
  });
});

describe('sdkAgentService - one active conversation', () => {
  it('opening a different chat implicitly aborts and closes the previous one first', async () => {
    const ids = counterIdGenerator();
    const sessionHandleA = makeFakeSession();
    const sessionHandleB = makeFakeSession();
    const { source: authSource } = makeAuthSource();

    const createSession = vi
      .fn<HardenedSessionClient['createSession']>()
      .mockResolvedValueOnce(sessionHandleA.session)
      .mockResolvedValueOnce(sessionHandleB.session);
    const client: HardenedSessionClient = {
      createSession,
      resumeSession: vi.fn<HardenedSessionClient['resumeSession']>(),
    };

    const service = createSdkAgentService({ client, policy: POLICY, authSource, idGenerator: ids });
    const events: AgentEvent[] = [];
    service.onEvent((event) => events.push(event));
    await service.initialize();

    const chatA = newChatId(ids);
    const chatB = newChatId(ids);
    await service.openConversation({ chatId: chatA });
    await service.sendPrompt({ chatId: chatA, turnId: newTurnId(ids), prompt: 'hi' });
    // Deliberately left "sending" - no idle/complete event delivered yet.

    const opened = await service.openConversation({ chatId: chatB });
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.value).toBe(chatB);

    expect(sessionHandleA.abort).toHaveBeenCalledTimes(1);
    expect(sessionHandleA.disconnect).toHaveBeenCalledTimes(1);

    const chatAEvents = events.filter((event) => event.chatId === chatA);
    assertLegalSequence(chatAEvents);
    expect(chatAEvents.at(-3)).toMatchObject({
      type: 'session.state.changed',
      state: 'cancelling',
    });
    expect(chatAEvents.at(-2)).toMatchObject({ type: 'session.state.changed', state: 'idle' });
    expect(chatAEvents.at(-1)).toMatchObject({ type: 'session.state.changed', state: 'closed' });

    const staleSend = await service.sendPrompt({
      chatId: chatA,
      turnId: newTurnId(ids),
      prompt: 'too late',
    });
    expect(staleSend.ok).toBe(false);
    if (!staleSend.ok) expect(staleSend.error.code).toBe('INVALID_ARGUMENT');

    const sendOnB = await service.sendPrompt({
      chatId: chatB,
      turnId: newTurnId(ids),
      prompt: 'hello',
    });
    expect(sendOnB.ok).toBe(true);
  });
});

describe('sdkAgentService - model and reasoning-effort preference (step 09)', () => {
  function serviceWith(
    sessionHandle: FakeSessionHandle,
    ids: IdGenerator,
    modelPreferences: () => ModelPreference,
  ) {
    const { client, createSession, resumeSession } = makeFakeClient(sessionHandle.session);
    const { source: authSource } = makeAuthSource();
    const service = createSdkAgentService({
      client,
      policy: POLICY,
      authSource,
      idGenerator: ids,
      modelPreferences,
    });
    const events: AgentEvent[] = [];
    service.onEvent((event) => events.push(event));
    return { service, events, createSession, resumeSession };
  }

  /**
   * Ends the in-flight turn the way the SDK really does. `sending -> idle` is
   * an illegal transition in the session state machine, so a turn has to pass
   * through an assistant message before it can settle.
   */
  function finishTurn(sessionHandle: FakeSessionHandle, messageId: string): void {
    sessionHandle.emit({ type: 'assistant.message_start', data: { messageId } });
    sessionHandle.emit({ type: 'assistant.message', data: { messageId, content: 'ok' } });
    sessionHandle.emit({ type: 'session.idle', data: {} });
  }

  it('passes the stored model and effort in the session config when CREATING', async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const { service, createSession } = serviceWith(sessionHandle, ids, () => ({
      model: 'model-a',
      reasoningEffort: 'high',
    }));

    expect((await service.initialize()).ok).toBe(true);
    expect((await service.openConversation({ chatId: newChatId(ids) })).ok).toBe(true);

    const config = createSession.mock.calls[0]?.[0] as
      { model?: string; reasoningEffort?: string; reasoningSummary?: string } | undefined;
    expect(config?.model).toBe('model-a');
    expect(config?.reasoningEffort).toBe('high');
    // A reasoning effort is what turns reasoning summaries on, so the
    // transcript has thinking to show.
    expect(config?.reasoningSummary).toBe('concise');
  });

  it('omits both keys entirely when there is no preference', async () => {
    // Omitted, not `undefined`: `exactOptionalPropertyTypes` aside, a present
    // key could be read by the SDK as an explicit "no model".
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const { service, createSession } = serviceWith(sessionHandle, ids, () => ({
      model: null,
      reasoningEffort: null,
    }));

    expect((await service.initialize()).ok).toBe(true);
    expect((await service.openConversation({ chatId: newChatId(ids) })).ok).toBe(true);

    const config = createSession.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(config).toBeDefined();
    expect(Object.hasOwn(config ?? {}, 'model')).toBe(false);
    expect(Object.hasOwn(config ?? {}, 'reasoningEffort')).toBe(false);
    expect(Object.hasOwn(config ?? {}, 'reasoningSummary')).toBe(false);
  });

  it('omits the effort when a model is chosen but no effort is', async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const { service, createSession } = serviceWith(sessionHandle, ids, () => ({
      model: 'model-a',
      reasoningEffort: null,
    }));

    expect((await service.initialize()).ok).toBe(true);
    expect((await service.openConversation({ chatId: newChatId(ids) })).ok).toBe(true);

    const config = createSession.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(config?.['model']).toBe('model-a');
    expect(Object.hasOwn(config ?? {}, 'reasoningEffort')).toBe(false);
    // Reasoning summaries are tied to an explicit effort: a model run at its
    // own default reasoning level is left untouched.
    expect(Object.hasOwn(config ?? {}, 'reasoningSummary')).toBe(false);
  });

  it('does NOT push the model into the config when RESUMING', async () => {
    // "Do not silently replace the model when resuming" - a resumed session
    // keeps whatever it was created with until the user next prompts.
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const { service, resumeSession } = serviceWith(sessionHandle, ids, () => ({
      model: 'model-a',
      reasoningEffort: 'high',
    }));

    expect((await service.initialize()).ok).toBe(true);
    const opened = await service.openConversation({
      chatId: newChatId(ids),
      resume: { sdkSessionId: sdkSessionIdSchema.parse('previous-session') },
    });
    expect(opened.ok).toBe(true);

    const config = resumeSession.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(Object.hasOwn(config ?? {}, 'model')).toBe(false);
    expect(Object.hasOwn(config ?? {}, 'reasoningEffort')).toBe(false);
  });

  it('issues no setModel on the first prompt of a freshly CREATED session', async () => {
    // The config already carried it; a second application would be a wasted RPC.
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const { service } = serviceWith(sessionHandle, ids, () => ({
      model: 'model-a',
      reasoningEffort: 'high',
    }));

    expect((await service.initialize()).ok).toBe(true);
    const chatId = newChatId(ids);
    expect((await service.openConversation({ chatId })).ok).toBe(true);
    expect((await service.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'hi' })).ok).toBe(
      true,
    );

    expect(sessionHandle.setModel).not.toHaveBeenCalled();
  });

  it('applies the stored preference on the first prompt after a RESUME', async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const { service } = serviceWith(sessionHandle, ids, () => ({
      model: 'model-a',
      reasoningEffort: 'high',
    }));

    expect((await service.initialize()).ok).toBe(true);
    const chatId = newChatId(ids);
    expect(
      (
        await service.openConversation({
          chatId,
          resume: { sdkSessionId: sdkSessionIdSchema.parse('previous-session') },
        })
      ).ok,
    ).toBe(true);
    expect((await service.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'hi' })).ok).toBe(
      true,
    );

    expect(sessionHandle.setModel).toHaveBeenCalledTimes(1);
    expect(sessionHandle.setModel).toHaveBeenCalledWith('model-a', {
      reasoningEffort: 'high',
      reasoningSummary: 'concise',
    });
  });

  it("leaves a resumed session's own model alone when there is NO preference", async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const { service } = serviceWith(sessionHandle, ids, () => ({
      model: null,
      reasoningEffort: null,
    }));

    expect((await service.initialize()).ok).toBe(true);
    const chatId = newChatId(ids);
    expect(
      (
        await service.openConversation({
          chatId,
          resume: { sdkSessionId: sdkSessionIdSchema.parse('previous-session') },
        })
      ).ok,
    ).toBe(true);
    expect((await service.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'hi' })).ok).toBe(
      true,
    );

    expect(sessionHandle.setModel).not.toHaveBeenCalled();
  });

  it('applies a preference CHANGED mid-conversation on the next prompt only', async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    let preference: ModelPreference = { model: 'model-a', reasoningEffort: null };
    const { service } = serviceWith(sessionHandle, ids, () => preference);

    expect((await service.initialize()).ok).toBe(true);
    const chatId = newChatId(ids);
    expect((await service.openConversation({ chatId })).ok).toBe(true);
    expect((await service.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'one' })).ok).toBe(
      true,
    );
    finishTurn(sessionHandle, 'msg-1');
    expect(sessionHandle.setModel).not.toHaveBeenCalled();

    preference = { model: 'model-b', reasoningEffort: 'low' };
    const second = await service.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'two' });
    expect(second.ok).toBe(true);
    expect(sessionHandle.setModel).toHaveBeenCalledTimes(1);
    expect(sessionHandle.setModel).toHaveBeenCalledWith('model-b', {
      reasoningEffort: 'low',
      reasoningSummary: 'concise',
    });

    finishTurn(sessionHandle, 'msg-2');
    expect((await service.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'three' })).ok).toBe(
      true,
    );
    // Unchanged since: no second RPC.
    expect(sessionHandle.setModel).toHaveBeenCalledTimes(1);
  });

  it('switches the model BEFORE emitting `sending`', async () => {
    // So a rejected switch leaves the conversation idle rather than stuck in a
    // turn that never began.
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const order: string[] = [];
    let preference: ModelPreference = { model: null, reasoningEffort: null };
    const { client } = makeFakeClient(sessionHandle.session);
    const { source: authSource } = makeAuthSource();
    const service = createSdkAgentService({
      client,
      policy: POLICY,
      authSource,
      idGenerator: ids,
      modelPreferences: () => preference,
    });
    service.onEvent((event) => {
      if (event.type === 'session.state.changed') order.push(`state:${event.state}`);
    });
    sessionHandle.setModel.mockImplementation(() => {
      order.push('setModel');
      return Promise.resolve();
    });

    expect((await service.initialize()).ok).toBe(true);
    const chatId = newChatId(ids);
    expect((await service.openConversation({ chatId })).ok).toBe(true);
    order.length = 0;

    preference = { model: 'model-a', reasoningEffort: null };
    expect((await service.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'hi' })).ok).toBe(
      true,
    );

    expect(order[0]).toBe('setModel');
    expect(order).toContain('state:sending');
    expect(order.indexOf('setModel')).toBeLessThan(order.indexOf('state:sending'));
  });

  it('reports a rejected switch and leaves the session re-promptable', async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    let preference: ModelPreference = { model: null, reasoningEffort: null };
    const { service, events } = serviceWith(sessionHandle, ids, () => preference);

    expect((await service.initialize()).ok).toBe(true);
    const chatId = newChatId(ids);
    expect((await service.openConversation({ chatId })).ok).toBe(true);

    sessionHandle.setModel.mockRejectedValueOnce(new Error('model retired'));
    preference = { model: 'model-a', reasoningEffort: null };
    const failed = await service.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'hi' });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('AGENT_UNAVAILABLE');

    // The turn never started, so the prompt was never sent...
    expect(sessionHandle.send).not.toHaveBeenCalled();
    expect(
      events.some((event) => event.type === 'session.state.changed' && event.state === 'sending'),
    ).toBe(false);

    // ...and the conversation is still usable once the model is fixed.
    preference = { model: null, reasoningEffort: null };
    expect((await service.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'retry' })).ok).toBe(
      true,
    );
    expect(sessionHandle.send).toHaveBeenCalledTimes(1);
  });

  it('does not leak raw SDK error text into the reported message', async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const { service } = serviceWith(sessionHandle, ids, () => ({
      model: 'model-a',
      reasoningEffort: null,
    }));

    expect((await service.initialize()).ok).toBe(true);
    const chatId = newChatId(ids);
    expect(
      (
        await service.openConversation({
          chatId,
          resume: { sdkSessionId: sdkSessionIdSchema.parse('previous') },
        })
      ).ok,
    ).toBe(true);

    sessionHandle.setModel.mockRejectedValueOnce(new Error('token sk-secret-value rejected'));
    const failed = await service.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'hi' });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.message).not.toContain('sk-secret-value');
  });

  it('re-applies the preference after the conversation is reopened', async () => {
    // `appliedModelPreference` must be cleared on teardown, or a new session
    // would inherit the previous one's "already applied" belief.
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const { service } = serviceWith(sessionHandle, ids, () => ({
      model: 'model-a',
      reasoningEffort: null,
    }));

    expect((await service.initialize()).ok).toBe(true);
    const first = newChatId(ids);
    expect(
      (
        await service.openConversation({
          chatId: first,
          resume: { sdkSessionId: sdkSessionIdSchema.parse('one') },
        })
      ).ok,
    ).toBe(true);
    expect(
      (await service.sendPrompt({ chatId: first, turnId: newTurnId(ids), prompt: 'a' })).ok,
    ).toBe(true);
    expect(sessionHandle.setModel).toHaveBeenCalledTimes(1);
    finishTurn(sessionHandle, 'msg-1');

    const second = newChatId(ids);
    expect(
      (
        await service.openConversation({
          chatId: second,
          resume: { sdkSessionId: sdkSessionIdSchema.parse('two') },
        })
      ).ok,
    ).toBe(true);
    expect(
      (await service.sendPrompt({ chatId: second, turnId: newTurnId(ids), prompt: 'b' })).ok,
    ).toBe(true);
    expect(sessionHandle.setModel).toHaveBeenCalledTimes(2);
  });
});

describe('sdkAgentService - open session id', () => {
  it('is undefined before a conversation opens and reports the SDK session id after', async () => {
    const ids = counterIdGenerator();
    const sessionHandle = makeFakeSession();
    const { client } = makeFakeClient(sessionHandle.session);
    const service = createSdkAgentService({
      client,
      policy: POLICY,
      authSource: makeAuthSource().source,
      idGenerator: ids,
    });

    expect(service.getOpenSessionId()).toBeUndefined();

    expect((await service.initialize()).ok).toBe(true);
    const chatId = newChatId(ids);
    expect((await service.openConversation({ chatId })).ok).toBe(true);

    expect(service.getOpenSessionId()).toBe('fake-session-id');
  });
});
