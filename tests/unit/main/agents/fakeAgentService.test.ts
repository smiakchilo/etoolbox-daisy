import { describe, expect, it } from 'vitest';
import {
  type AgentEvent,
  type IdGenerator,
  type SdkSessionId,
  type SessionStatus,
  applyAgentEvent,
  createAgentServiceError,
  newChatId,
  newTurnId,
} from '../../../../src/shared';
import {
  type ScriptedTurn,
  createFakeAgentService,
} from '../../../../src/main/agents/fakeAgentService';

/**
 * A plain incrementing-counter id generator, used only to mint `ChatId`s and
 * `TurnId`s for these tests - the caller-supplied ids `agentService.ts`
 * documents as never minted by the service itself. Deliberately separate
 * from any generator a fake under test uses internally for `MessageId`s /
 * `ToolCallId`s / `RequestId`s.
 */
function counterIdGenerator(): IdGenerator {
  let counter = 0;
  return () => `test-id-${String(counter++)}`;
}

/** A fresh, idle `SessionStatus` - the starting point `applyAgentEvent` assumes for a brand-new chat. */
function idleStatus(): SessionStatus {
  return { state: 'idle', authenticated: true, browserReady: true };
}

/**
 * Replays every event in `events`, in order, through `applyAgentEvent`
 * starting from `idleStatus()`, asserting each application succeeds. This is
 * the outside-in check the plan requires ("Write a test that asserts exactly
 * this") in addition to the fake's own internal self-check
 * (`fakeAgentService.ts`'s `applyAndEmit`) - the two are independent: this
 * test does not know, and must not rely on, the fact that the fake already
 * checks itself.
 */
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

function isCompletedEvent(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: 'assistant.message.completed' }> {
  return event.type === 'assistant.message.completed';
}

describe('createAgentServiceError (folded in from D1 - agentService.ts is otherwise pure interface/types)', () => {
  it('omits requiredAction entirely when not supplied, rather than setting it to undefined', () => {
    const error = createAgentServiceError('INVALID_ARGUMENT', 'bad request');
    expect(error).toEqual({ code: 'INVALID_ARGUMENT', message: 'bad request' });
    expect(Object.hasOwn(error, 'requiredAction')).toBe(false);
  });

  it('includes requiredAction when supplied', () => {
    const error = createAgentServiceError('AGENT_UNAVAILABLE', 'not signed in', 'sign_in_to_agent');
    expect(error.requiredAction).toBe('sign_in_to_agent');
  });
});

describe('FakeAgentService - scripted content', () => {
  it('delivers scripted deltas and a tool call in order; completed content matches the folded deltas by default', async () => {
    const ids = counterIdGenerator();
    const fake = createFakeAgentService();
    const events: AgentEvent[] = [];
    fake.onEvent((event) => events.push(event));

    expect((await fake.initialize()).ok).toBe(true);
    const chatId = newChatId(ids);
    expect((await fake.openConversation({ chatId })).ok).toBe(true);

    const turnId = newTurnId(ids);
    fake.scriptNextResponse({
      steps: [
        { kind: 'delta', text: 'Hello, ' },
        { kind: 'delta', text: 'world!' },
        {
          kind: 'toolCall',
          call: {
            toolName: 'aem_get_json',
            arguments: { path: '/content/foo.json' },
            decision: { kind: 'approved', outcome: { ok: true, data: { title: 'Foo' } } },
          },
        },
      ],
    });

    const sent = await fake.sendPrompt({ chatId, turnId, prompt: 'hi' });
    expect(sent.ok).toBe(true);
    const delivered = fake.flush();
    expect(delivered).toBeGreaterThan(0);
    // Nothing left to deliver once flushed.
    expect(fake.advance()).toBe(false);

    const deltas = events.filter((event) => event.type === 'assistant.text.delta');
    expect(deltas.map((event) => (event as { delta: string }).delta)).toEqual([
      'Hello, ',
      'world!',
    ]);

    const requested = events.find((event) => event.type === 'tool.call.requested');
    expect(requested).toMatchObject({
      toolName: 'aem_get_json',
      arguments: { path: '/content/foo.json' },
    });
    expect(events.some((event) => event.type === 'tool.call.approved')).toBe(true);
    const result = events.find((event) => event.type === 'tool.result');
    expect(result).toMatchObject({ outcome: { ok: true, data: { title: 'Foo' } } });

    const completed = events.find(isCompletedEvent);
    expect(completed?.content).toBe('Hello, world!');

    assertLegalSequence(events);
  });

  it('ends a scripted turn at a turn-completing tool result, dropping any later scripted delta', async () => {
    const ids = counterIdGenerator();
    const fake = createFakeAgentService();
    const events: AgentEvent[] = [];
    fake.onEvent((event) => events.push(event));
    const chatId = newChatId(ids);
    await fake.openConversation({ chatId });

    fake.scriptNextResponse({
      steps: [
        { kind: 'delta', text: 'Searching. ' },
        {
          kind: 'toolCall',
          call: {
            toolName: 'aem_query_format_ask',
            arguments: { terms: 'waldo' },
            decision: { kind: 'approved', outcome: { ok: true, data: { turnComplete: true } } },
          },
        },
        // What the model would otherwise add: the real adapters never resume the
        // model after a turn-completing result, so the fake must not emit it.
        { kind: 'delta', text: 'The search is finished.' },
      ],
    });
    await fake.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'hi' });
    fake.flush();

    const deltas = events.filter((event) => event.type === 'assistant.text.delta');
    expect(deltas.map((event) => (event as { delta: string }).delta)).toEqual(['Searching. ']);
    expect(events.find(isCompletedEvent)?.content).toBe('Searching. ');
    expect(events.at(-1)).toMatchObject({ type: 'session.state.changed', state: 'idle' });
    assertLegalSequence(events);
  });

  it('finalContentOverride lets a scenario deliberately diverge from the folded deltas', async () => {
    const ids = counterIdGenerator();
    const fake = createFakeAgentService();
    const events: AgentEvent[] = [];
    fake.onEvent((event) => events.push(event));
    const chatId = newChatId(ids);
    await fake.openConversation({ chatId });

    fake.scriptNextResponse({
      steps: [
        { kind: 'delta', text: 'a' },
        { kind: 'delta', text: 'b' },
      ],
      finalContentOverride: 'totally different',
    });
    await fake.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'hi' });
    fake.flush();

    const completed = events.find(isCompletedEvent);
    expect(completed?.content).toBe('totally different');
    assertLegalSequence(events);
  });
});

describe('FakeAgentService - every scripted scenario is a legal event sequence', () => {
  const scenarios: Record<string, ScriptedTurn> = {
    'empty turn (no steps scripted)': {},
    'deltas only': {
      steps: [
        { kind: 'delta', text: 'one ' },
        { kind: 'delta', text: 'two' },
      ],
    },
    'approved tool call, successful result': {
      steps: [
        {
          kind: 'toolCall',
          call: {
            toolName: 'aem_get_json',
            arguments: {},
            decision: { kind: 'approved', outcome: { ok: true, data: null } },
          },
        },
      ],
    },
    'approved tool call, failed result': {
      steps: [
        {
          kind: 'toolCall',
          call: {
            toolName: 'aem_get_json',
            arguments: {},
            decision: {
              kind: 'approved',
              outcome: { ok: false, code: 'NOT_FOUND', message: 'no such node' },
            },
          },
        },
      ],
    },
    'rejected tool call': {
      steps: [
        {
          kind: 'toolCall',
          call: {
            toolName: 'aem_get_json',
            arguments: {},
            decision: { kind: 'rejected', reason: 'policy denied it' },
          },
        },
      ],
    },
    'deltas interleaved with multiple tool calls': {
      steps: [
        { kind: 'delta', text: 'checking ' },
        {
          kind: 'toolCall',
          call: {
            toolName: 'aem_get_json',
            arguments: { path: '/a' },
            decision: { kind: 'approved', outcome: { ok: true, data: 1 } },
          },
        },
        { kind: 'delta', text: 'and ' },
        {
          kind: 'toolCall',
          call: {
            toolName: 'aem_get_json',
            arguments: { path: '/b' },
            decision: { kind: 'rejected', reason: 'not allowed' },
          },
        },
        { kind: 'delta', text: 'done.' },
      ],
    },
    'reasoning before and between tool calls': {
      steps: [
        { kind: 'reasoning', text: 'I should look this up.\n' },
        { kind: 'reasoning', text: 'Let me query AEM.' },
        {
          kind: 'toolCall',
          call: {
            toolName: 'aem_get_json',
            arguments: { path: '/a' },
            decision: { kind: 'approved', outcome: { ok: true, data: 1 } },
          },
        },
        { kind: 'reasoning', text: 'That answered it.' },
        { kind: 'delta', text: 'Done.' },
      ],
    },
  };

  for (const [name, turn] of Object.entries(scenarios)) {
    it(`is legal end to end: ${name}`, async () => {
      const ids = counterIdGenerator();
      const fake = createFakeAgentService();
      const events: AgentEvent[] = [];
      fake.onEvent((event) => events.push(event));
      const chatId = newChatId(ids);
      await fake.openConversation({ chatId });
      fake.scriptNextResponse(turn);
      const sent = await fake.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'hi' });
      expect(sent.ok).toBe(true);
      fake.flush();

      const finalStatus = assertLegalSequence(events);
      expect(finalStatus.state).toBe('idle');
    });
  }
});

describe('FakeAgentService - reasoning steps', () => {
  it('closes one reasoning block per contiguous run, with deltas then a completed event', async () => {
    const ids = counterIdGenerator();
    const fake = createFakeAgentService();
    const events: AgentEvent[] = [];
    fake.onEvent((event) => events.push(event));
    const chatId = newChatId(ids);
    await fake.openConversation({ chatId });
    fake.scriptNextResponse({
      steps: [
        { kind: 'reasoning', text: 'first ' },
        { kind: 'reasoning', text: 'block' },
        { kind: 'delta', text: 'answer' },
        { kind: 'reasoning', text: 'second block' },
      ],
    });
    await fake.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'hi' });
    fake.flush();

    const reasoning = events.filter((event) => event.type.startsWith('assistant.reasoning'));
    expect(reasoning.map((event) => event.type)).toEqual([
      'assistant.reasoning.delta',
      'assistant.reasoning.delta',
      'assistant.reasoning.completed',
      'assistant.reasoning.delta',
      'assistant.reasoning.completed',
    ]);
    // Two contiguous runs -> two distinct reasoning ids.
    const idsUsed = new Set(
      reasoning.map((event) => (event as { reasoningId?: string }).reasoningId),
    );
    expect(idsUsed.size).toBe(2);
    const completed = reasoning.filter((event) => event.type === 'assistant.reasoning.completed');
    expect(completed[0]).toMatchObject({ content: 'first block' });
    expect(completed[1]).toMatchObject({ content: 'second block' });
  });

  it('rejects an empty reasoning step', async () => {
    const ids = counterIdGenerator();
    const fake = createFakeAgentService();
    const chatId = newChatId(ids);
    await fake.openConversation({ chatId });
    fake.scriptNextResponse({ steps: [{ kind: 'reasoning', text: '' }] });

    // `buildTurnPlan` runs synchronously inside `sendPrompt`, so the invalid
    // script throws before a promise is ever returned.
    expect(() => fake.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'hi' })).toThrow(
      /empty reasoning step/,
    );
  });
});

describe('FakeAgentService - abort', () => {
  /**
   * One row per state a turn can legally be aborted from. `advancesBeforeAbort`
   * is how many `advance()` calls are made (after `sendPrompt`'s own
   * synchronous "sending" event) before `abort()` is called, chosen so the
   * turn is sitting in exactly `originState` when it is cancelled:
   * `sendPrompt` alone leaves it at `sending`; one `advance()` delivers
   * `assistant.message.started`, which reaches `streaming`; a second
   * `advance()` on a turn whose first step is a tool call delivers
   * `tool.call.requested`, which reaches `runningTool`.
   */
  interface AbortOrigin {
    readonly originState: 'sending' | 'streaming' | 'runningTool';
    readonly turn: ScriptedTurn;
    readonly advancesBeforeAbort: number;
  }

  const origins: readonly AbortOrigin[] = [
    {
      originState: 'sending',
      turn: { steps: [{ kind: 'delta', text: "won't finish" }] },
      advancesBeforeAbort: 0,
    },
    {
      originState: 'streaming',
      turn: { steps: [{ kind: 'delta', text: "won't finish" }] },
      advancesBeforeAbort: 1,
    },
    {
      originState: 'runningTool',
      turn: {
        steps: [
          {
            kind: 'toolCall',
            call: {
              toolName: 'aem_get_json',
              arguments: {},
              decision: { kind: 'approved', outcome: { ok: true, data: null } },
            },
          },
        ],
      },
      advancesBeforeAbort: 2,
    },
  ];

  for (const origin of origins) {
    it(`aborting while ${origin.originState} emits "cancelling" then "idle" (never "error"), and suppresses further events for that turn`, async () => {
      const ids = counterIdGenerator();
      const fake = createFakeAgentService();
      const events: AgentEvent[] = [];
      fake.onEvent((event) => events.push(event));
      const chatId = newChatId(ids);
      await fake.openConversation({ chatId });

      fake.scriptNextResponse(origin.turn);
      await fake.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'hi' });
      for (let i = 0; i < origin.advancesBeforeAbort; i++) {
        expect(fake.advance()).toBe(true);
      }
      const eventsBeforeAbort = events.length;

      const aborted = await fake.abort(chatId);
      expect(aborted.ok).toBe(true);

      const afterAbort = events.slice(eventsBeforeAbort);
      expect(afterAbort).toHaveLength(2);
      expect(afterAbort[0]).toMatchObject({
        type: 'session.state.changed',
        state: 'cancelling',
      });
      expect(afterAbort[1]).toMatchObject({ type: 'session.state.changed', state: 'idle' });
      expect(events.some((event) => event.type === 'error')).toBe(false);

      // Nothing left of the aborted turn to deliver.
      expect(fake.flush()).toBe(0);
      expect(events).toHaveLength(eventsBeforeAbort + 2);

      const finalStatus = assertLegalSequence(events);
      expect(finalStatus.state).toBe('idle');

      // Aborting returned the conversation to a genuinely sendable idle state.
      const secondSend = await fake.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'again' });
      expect(secondSend.ok).toBe(true);
    });
  }

  it('aborting with nothing in flight is a no-op success', async () => {
    const ids = counterIdGenerator();
    const fake = createFakeAgentService();
    const chatId = newChatId(ids);
    await fake.openConversation({ chatId });
    const events: AgentEvent[] = [];
    fake.onEvent((event) => events.push(event));

    const result = await fake.abort(chatId);
    expect(result.ok).toBe(true);
    expect(events).toHaveLength(0);
  });
});

describe('FakeAgentService - one active conversation', () => {
  it('re-opening the already-open chat is a no-op: no teardown, no events', async () => {
    const ids = counterIdGenerator();
    const fake = createFakeAgentService();
    const chatId = newChatId(ids);
    expect((await fake.openConversation({ chatId })).ok).toBe(true);

    const events: AgentEvent[] = [];
    fake.onEvent((event) => events.push(event));
    const reopened = await fake.openConversation({ chatId });
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(reopened.value).toBe(chatId);
    expect(events).toHaveLength(0);
  });

  it('opening a different chat implicitly aborts and closes the previous one first', async () => {
    const ids = counterIdGenerator();
    const fake = createFakeAgentService();
    const events: AgentEvent[] = [];
    fake.onEvent((event) => events.push(event));

    const chatA = newChatId(ids);
    const chatB = newChatId(ids);
    await fake.openConversation({ chatId: chatA });
    fake.scriptNextResponse({ steps: [{ kind: 'delta', text: 'in flight' }] });
    await fake.sendPrompt({ chatId: chatA, turnId: newTurnId(ids), prompt: 'hi' });
    // Deliberately do not advance/flush: chatA's turn is still "sending".

    const opened = await fake.openConversation({ chatId: chatB });
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.value).toBe(chatB);

    // chatA must have been cancelled (never "error") and then closed:
    // [sending, cancelling, idle, closed].
    const chatAEvents = events.filter((event) => event.chatId === chatA);
    assertLegalSequence(chatAEvents);
    expect(chatAEvents.at(-3)).toMatchObject({
      type: 'session.state.changed',
      state: 'cancelling',
    });
    expect(chatAEvents.at(-2)).toMatchObject({ type: 'session.state.changed', state: 'idle' });
    expect(chatAEvents.at(-1)).toMatchObject({ type: 'session.state.changed', state: 'closed' });

    // chatA is no longer the open conversation.
    const staleSend = await fake.sendPrompt({
      chatId: chatA,
      turnId: newTurnId(ids),
      prompt: 'too late',
    });
    expect(staleSend.ok).toBe(false);
    if (!staleSend.ok) expect(staleSend.error.code).toBe('INVALID_ARGUMENT');

    // chatB is now usable.
    const sendOnB = await fake.sendPrompt({
      chatId: chatB,
      turnId: newTurnId(ids),
      prompt: 'hello',
    });
    expect(sendOnB.ok).toBe(true);
  });
});

describe('FakeAgentService - one turn at a time', () => {
  it('a second sendPrompt over an unfinished turn is refused immediately, without requiring advance() first', async () => {
    const ids = counterIdGenerator();
    const fake = createFakeAgentService();
    const chatId = newChatId(ids);
    await fake.openConversation({ chatId });

    const first = await fake.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'first' });
    expect(first.ok).toBe(true);

    const second = await fake.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'second' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('PRECONDITION_FAILED');
  });
});

describe('FakeAgentService - authentication gating', () => {
  it('refuses sendPrompt while not authenticated, with a sign_in_to_agent required action', async () => {
    const ids = counterIdGenerator();
    const fake = createFakeAgentService({
      initialAuthState: { apiVersion: 1, isAuthenticated: false },
    });
    const chatId = newChatId(ids);
    await fake.openConversation({ chatId });

    const blocked = await fake.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'hi' });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.code).toBe('AGENT_UNAVAILABLE');
      expect(blocked.error.requiredAction).toBe('sign_in_to_agent');
    }

    fake.setAuthState({ apiVersion: 1, isAuthenticated: true });
    const allowed = await fake.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'hi' });
    expect(allowed.ok).toBe(true);
  });
});

describe('FakeAgentService - unsubscribe', () => {
  it("onEvent's returned Unsubscribe actually stops delivery", async () => {
    const ids = counterIdGenerator();
    const fake = createFakeAgentService();
    const chatId = newChatId(ids);
    await fake.openConversation({ chatId });

    const events: AgentEvent[] = [];
    const unsubscribe = fake.onEvent((event) => events.push(event));

    fake.scriptNextResponse({ steps: [{ kind: 'delta', text: 'before unsubscribe' }] });
    await fake.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'hi' });
    fake.flush();
    const countBeforeUnsubscribe = events.length;
    expect(countBeforeUnsubscribe).toBeGreaterThan(0);

    unsubscribe();

    fake.scriptNextResponse({ steps: [{ kind: 'delta', text: 'after unsubscribe' }] });
    await fake.sendPrompt({ chatId, turnId: newTurnId(ids), prompt: 'hi again' });
    fake.flush();

    expect(events).toHaveLength(countBeforeUnsubscribe);
  });

  it("onAuthStateChanged's returned Unsubscribe actually stops delivery", () => {
    const fake = createFakeAgentService();
    const states: boolean[] = [];
    const unsubscribe = fake.onAuthStateChanged((state) => states.push(state.isAuthenticated));

    fake.setAuthState({ apiVersion: 1, isAuthenticated: false });
    expect(states).toEqual([false]);

    unsubscribe();
    fake.setAuthState({ apiVersion: 1, isAuthenticated: true });
    expect(states).toEqual([false]);
  });
});

describe('FakeAgentService - open session id', () => {
  it('is undefined before a chat opens and deterministic after', async () => {
    const ids = counterIdGenerator();
    const fake = createFakeAgentService({ idGenerator: counterIdGenerator() });

    expect(fake.getOpenSessionId()).toBeUndefined();

    const chatId = newChatId(ids);
    await fake.openConversation({ chatId });

    expect(fake.getOpenSessionId()).toBe('fake-session-test-id-0');
  });
});

describe('FakeAgentService - deleteSession', () => {
  it('records every session id it is asked to delete, in order', async () => {
    const fake = createFakeAgentService({ idGenerator: counterIdGenerator() });

    expect(fake.deletedSessionIds()).toEqual([]);
    expect((await fake.deleteSession('sdk-1' as SdkSessionId)).ok).toBe(true);
    expect((await fake.deleteSession('sdk-2' as SdkSessionId)).ok).toBe(true);

    expect(fake.deletedSessionIds()).toEqual(['sdk-1', 'sdk-2']);
  });
});

describe('scripted input requests', () => {
  it('pauses on the question, then emits the answer as the tool result', async () => {
    const service = createFakeAgentService({ idGenerator: counterIdGenerator() });
    const ids = counterIdGenerator();
    const chatId = newChatId(ids);
    const turnId = newTurnId(ids);
    const events: AgentEvent[] = [];
    service.onEvent((event) => events.push(event));

    await service.openConversation({ chatId });
    service.scriptNextResponse({
      steps: [{ kind: 'inputRequest', question: 'Pick a colour', options: ['Red', 'Green'] }],
    });
    await service.sendPrompt({ chatId, turnId, prompt: 'hi' });

    // message.started, tool.call.requested, tool.call.approved, user.input.requested.
    expect(service.advance()).toBe(true);
    expect(service.advance()).toBe(true);
    expect(service.advance()).toBe(true);
    expect(service.advance()).toBe(true);
    // The placeholder tool.result is next; the turn pauses there until answered.
    expect(service.advance()).toBe(false);

    const requested = events.find((event) => event.type === 'user.input.requested');
    expect(requested).toMatchObject({
      type: 'user.input.requested',
      question: 'Pick a colour',
      options: ['Red', 'Green'],
      multiple: false,
      freeInput: false,
    });
    if (requested?.type !== 'user.input.requested') throw new Error('no question emitted');

    // A stale id is refused; the right one is accepted.
    expect(
      (await service.respondToInput(chatId, 'missing' as never, { selections: [], freeform: null }))
        .ok,
    ).toBe(false);
    expect(
      (
        await service.respondToInput(chatId, requested.requestId, {
          selections: ['Red'],
          freeform: null,
        })
      ).ok,
    ).toBe(true);

    // The turn resumes and finishes.
    expect(service.flush()).toBe(3);
    const result = events.find((event) => event.type === 'tool.result');
    expect(result).toMatchObject({ type: 'tool.result', outcome: { ok: true } });
    if (result?.type === 'tool.result' && result.outcome.ok) {
      expect(result.outcome.data).toMatchObject({ operation: 'ask_user', selections: ['Red'] });
    }
    expect(events.at(-1)).toMatchObject({ type: 'session.state.changed', state: 'idle' });
  });

  it('scripts an actions-only question: the event and call arguments carry the actions and no question', async () => {
    const service = createFakeAgentService({ idGenerator: counterIdGenerator() });
    const ids = counterIdGenerator();
    const chatId = newChatId(ids);
    const turnId = newTurnId(ids);
    const events: AgentEvent[] = [];
    service.onEvent((event) => events.push(event));

    await service.openConversation({ chatId });
    service.scriptNextResponse({ steps: [{ kind: 'inputRequest', actions: ['Load more'] }] });
    await service.sendPrompt({ chatId, turnId, prompt: 'hi' });
    service.advance();
    service.advance();
    service.advance();
    service.advance();

    const call = events.find((event) => event.type === 'tool.call.requested');
    expect(call).toMatchObject({
      type: 'tool.call.requested',
      arguments: { actions: ['Load more'] },
    });
    if (call?.type === 'tool.call.requested') {
      expect(call.arguments['question']).toBeUndefined();
    }
    const requested = events.find((event) => event.type === 'user.input.requested');
    expect(requested).toMatchObject({
      type: 'user.input.requested',
      actions: ['Load more'],
      multiple: false,
      freeInput: false,
    });
    if (requested?.type !== 'user.input.requested') throw new Error('no question emitted');
    expect(requested.question).toBeUndefined();

    await service.respondToInput(chatId, requested.requestId, {
      selections: ['Load more'],
      freeform: null,
    });
    service.flush();
    const result = events.find((event) => event.type === 'tool.result');
    if (result?.type === 'tool.result' && result.outcome.ok) {
      expect(result.outcome.data).toMatchObject({
        operation: 'ask_user',
        selections: ['Load more'],
      });
    }
  });

  it('refuses requestUserInput - the fake scripts questions instead of running executors', async () => {
    const service = createFakeAgentService({ idGenerator: counterIdGenerator() });
    const result = await service.requestUserInput(newChatId(counterIdGenerator()), {
      question: 'Q',
      multiple: false,
      freeInput: false,
    });
    expect(result.ok).toBe(false);
  });
});
