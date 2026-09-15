import { describe, expect, it, vi } from 'vitest';
import { createFakeAgentService } from '../../../src/agent/fakeAgentService';
import {
  createAgentChatController,
  createAgentChatEventForwarder,
  createStartupGatedAgentChatController,
  type AemServerContext,
  type AgentChatController,
  type AgentChatControllerDeps,
  type AgentChatEventSink,
} from '../../../src/main/agentChatController';
import type { Logger } from '../../../src/main/logger';
import type {
  AgentAuthState,
  AgentService,
  AgentServiceError,
  OpenConversationRequest,
  Unsubscribe,
} from '../../../src/agent/agentService';
import { ok, type Result } from '../../../src/shared/result';
import type { AgentEvent } from '../../../src/shared/contracts/agentEvents';
import type { ChatId, ServerId } from '../../../src/shared/contracts/ids';

/**
 * Unit tests for `agentChatController.ts` against `fakeAgentService.ts` -
 * no Electron runtime anywhere in this file (`createAgentChatEventForwarder`
 * is exercised with a plain fake `AgentChatEventSink` object, never a real
 * `WebContents`).
 *
 * Two tests (marked below) need a hand-written, deliberately permissive
 * `AgentService` double instead of the real fake: `fakeAgentService.ts`
 * already refuses a second prompt and already discards a turn's queue on
 * abort, so it structurally cannot produce the "late/foreign event" or
 * "stale-turn corruption" scenarios this controller's *own* guard exists to
 * catch. The double exists to drive the controller with events the real
 * fake would never itself emit, so the controller's guard is what is
 * actually being exercised - independent of whether the real fake ever
 * reaches that state on its own. This mirrors this project's own stated
 * intent for this controller: "defense-in-depth on top of the service's own
 * guarantee, not a replacement for it."
 */

function counterIdGenerator(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${String(n++)}`;
}

function noopLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    getHealth: () => ({ writeFailureCount: 0, lastFailureCode: null, rotationCount: 0 }),
  };
}

function serverContext(overrides: Partial<AemServerContext> = {}): AemServerContext {
  return {
    origin: 'https://author.example.com',
    serverId: 'server-a' as ServerId,
    serverRevision: 1,
    ...overrides,
  };
}

/** Builds a controller wired to `agentService` with sensible test defaults; individual fields are overridable. */
function buildController(
  agentService: AgentService,
  overrides: Partial<AgentChatControllerDeps> = {},
): { controller: AgentChatController; logger: Logger } {
  const logger = overrides.logger ?? noopLogger();
  const deps: AgentChatControllerDeps = {
    agentService,
    logger,
    idGenerator: counterIdGenerator('turn'),
    currentAemServerContext: () => serverContext(),
    navigationEpoch: () => 0,
    ...overrides,
  };
  const controller = createAgentChatController(deps);
  return { controller, logger };
}

/** Test-only helper to mutate the closures `buildController` captured, simulating a live server switch. */
interface MutableServerSlot {
  set(context: AemServerContext | undefined): void;
  bumpEpoch(): void;
}

function buildControllerWithMutableServer(agentService: AgentService): {
  controller: AgentChatController;
  server: MutableServerSlot;
  logger: Logger;
} {
  const logger = noopLogger();
  let current: AemServerContext | undefined = serverContext();
  let epoch = 0;
  const controller = createAgentChatController({
    agentService,
    logger,
    idGenerator: counterIdGenerator('turn'),
    currentAemServerContext: () => current,
    navigationEpoch: () => epoch,
  });
  return {
    controller,
    logger,
    server: {
      set(context) {
        current = context;
      },
      bumpEpoch() {
        epoch += 1;
      },
    },
  };
}

function newChatId(id: string): ChatId {
  return id as ChatId;
}

// ---------------------------------------------------------------------------
// A deliberately permissive `AgentService` double - see module doc above.
// ---------------------------------------------------------------------------

interface LeakyAgentService extends AgentService {
  /** Pushes `event` to every subscribed `onEvent` listener, bypassing any state-machine legality check. */
  emit(event: AgentEvent): void;
}

function createLeakyAgentService(): LeakyAgentService {
  const eventListeners = new Set<(event: AgentEvent) => void>();
  const authListeners = new Set<(state: AgentAuthState) => void>();
  const authState: AgentAuthState = { apiVersion: 1, isAuthenticated: true };

  return {
    initialize(): Promise<Result<void, AgentServiceError>> {
      return Promise.resolve(ok(undefined));
    },
    getAuthState(): AgentAuthState {
      return authState;
    },
    onAuthStateChanged(listener: (state: AgentAuthState) => void): Unsubscribe {
      authListeners.add(listener);
      return () => authListeners.delete(listener);
    },
    onEvent(listener: (event: AgentEvent) => void): Unsubscribe {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    openConversation(request: OpenConversationRequest): Promise<Result<ChatId, AgentServiceError>> {
      return Promise.resolve(ok(request.chatId));
    },
    sendPrompt(): Promise<Result<void, AgentServiceError>> {
      return Promise.resolve(ok(undefined));
    },
    abort(): Promise<Result<void, AgentServiceError>> {
      return Promise.resolve(ok(undefined));
    },
    closeConversation(): Promise<Result<void, AgentServiceError>> {
      return Promise.resolve(ok(undefined));
    },
    dispose(): Promise<void> {
      eventListeners.clear();
      authListeners.clear();
      return Promise.resolve();
    },
    emit(event: AgentEvent): void {
      for (const listener of eventListeners) listener(event);
    },
  };
}

describe('agentChatController', () => {
  it("delivers a scripted turn's events to the forwarder in order, and only once opened/sent", async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller } = buildController(agentService);
    const received: AgentEvent[] = [];
    controller.onEvent((event) => received.push(event));

    const chatId = newChatId('chat-1');
    const openResult = await controller.openConversation({ chatId });
    expect(openResult).toEqual({ ok: true, chatId });
    expect(received).toEqual([]); // Opening a brand-new chat emits nothing.

    agentService.scriptNextResponse({
      steps: [
        { kind: 'delta', text: 'Hello' },
        {
          kind: 'toolCall',
          call: {
            toolName: 'aem_get_json',
            arguments: { path: '/content' },
            decision: { kind: 'approved', outcome: { ok: true, data: { found: true } } },
          },
        },
      ],
    });
    const sendResult = await controller.sendMessage({ chatId, prompt: 'hi' });
    expect(sendResult.ok).toBe(true);
    if (!sendResult.ok) throw new Error('unreachable');
    const { turnId } = sendResult;

    // The very first event ("sending") is delivered synchronously by
    // sendPrompt itself, before this call even resolves.
    expect(received).toEqual([
      { type: 'session.state.changed', chatId, sequence: 0, turnId, state: 'sending' },
    ]);

    const delivered = agentService.flush();
    expect(delivered).toBeGreaterThan(0);

    const types = received.map((event) => event.type);
    expect(types).toEqual([
      'session.state.changed', // sending
      'assistant.message.started',
      'assistant.text.delta',
      'tool.call.requested',
      'tool.call.approved',
      'tool.result',
      'assistant.message.completed',
      'session.state.changed', // idle
    ]);
    // Sequence numbers strictly increase - the forwarder never reorders.
    const sequences = received.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(controller.getStatus().sessionState).toBe('idle');
  });

  it("refuses a second sendMessage over an unfinished turn, and keeps forwarding the original turn's later events", async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller } = buildController(agentService);
    const received: AgentEvent[] = [];
    controller.onEvent((event) => received.push(event));

    const chatId = newChatId('chat-1');
    await controller.openConversation({ chatId });
    agentService.scriptNextResponse({ steps: [{ kind: 'delta', text: 'first' }] });
    const first = await controller.sendMessage({ chatId, prompt: 'one' });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');

    // A second prompt while the first turn is still in flight must be
    // refused, not queued.
    const second = await controller.sendMessage({ chatId, prompt: 'two' });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.error.code).toBe('PRECONDITION_FAILED');

    // The refusal must not have disturbed this controller's tracking of the
    // still-in-flight first turn: its remaining events must still arrive.
    const delivered = agentService.flush();
    expect(delivered).toBeGreaterThan(0);
    const firstTurnEvents = received.filter(
      (event) => 'turnId' in event && event.turnId === first.turnId,
    );
    expect(firstTurnEvents.length).toBeGreaterThan(1);
    expect(received.at(-1)).toMatchObject({ type: 'session.state.changed', state: 'idle' });
  });

  it('Stop cancels the in-flight turn (streaming -> cancelling -> idle) and emits no error event', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller } = buildController(agentService);
    const received: AgentEvent[] = [];
    controller.onEvent((event) => received.push(event));

    const chatId = newChatId('chat-1');
    await controller.openConversation({ chatId });
    agentService.scriptNextResponse({ steps: [{ kind: 'delta', text: "won't finish" }] });
    const sent = await controller.sendMessage({ chatId, prompt: 'hi' });
    expect(sent.ok).toBe(true);

    const abortResult = await controller.abort({ chatId });
    expect(abortResult).toEqual({ ok: true });

    expect(received.map((event) => event.type)).toEqual([
      'session.state.changed', // sending
      'session.state.changed', // cancelling
      'session.state.changed', // idle
    ]);
    expect(received.some((event) => event.type === 'error')).toBe(false);
    expect(controller.getStatus().sessionState).toBe('idle');

    // The turn's remaining scripted queue must never surface afterward.
    const delivered = agentService.flush();
    expect(delivered).toBe(0);
  });

  it('drops a late event tagged with an abandoned chat, and never forwards it into the newly opened chat', async () => {
    const leaky = createLeakyAgentService();
    const { controller } = buildController(leaky);
    const received: AgentEvent[] = [];
    controller.onEvent((event) => received.push(event));

    const chatA = newChatId('chat-a');
    const chatB = newChatId('chat-b');
    await controller.openConversation({ chatId: chatA });
    const sentA = await controller.sendMessage({ chatId: chatA, prompt: 'hi' });
    expect(sentA.ok).toBe(true);
    if (!sentA.ok) throw new Error('unreachable');

    // Switch to a different chat - ownership flips to chatB before this
    // resolves.
    await controller.openConversation({ chatId: chatB });
    received.length = 0;

    // A straggler from chatA/turnA arrives after the switch.
    leaky.emit({
      type: 'assistant.text.delta',
      chatId: chatA,
      sequence: 999,
      turnId: sentA.turnId,
      messageId: 'late-message',
      delta: 'should never arrive',
    } as AgentEvent);

    expect(received).toEqual([]);
    expect(controller.getStatus().activeChatId).toBe(chatB);
  });

  it('drops a late event from a turn that has already ended, even on the same still-open chat', async () => {
    const leaky = createLeakyAgentService();
    const { controller } = buildController(leaky);
    const received: AgentEvent[] = [];

    const chatId = newChatId('chat-1');
    await controller.openConversation({ chatId });
    const sent = await controller.sendMessage({ chatId, prompt: 'hi' });
    expect(sent.ok).toBe(true);
    if (!sent.ok) throw new Error('unreachable');
    const staleTurnId = sent.turnId;

    // End the turn normally.
    leaky.emit({
      type: 'session.state.changed',
      chatId,
      sequence: 1,
      turnId: staleTurnId,
      state: 'idle',
    });

    controller.onEvent((event) => received.push(event));

    // A straggler from the now-finished turn arrives.
    leaky.emit({
      type: 'assistant.text.delta',
      chatId,
      sequence: 2,
      turnId: staleTurnId,
      messageId: 'late-message',
      delta: 'should never arrive',
    } as AgentEvent);

    expect(received).toEqual([]);
  });

  it('a server switch cancels in-flight work and the next tool context reflects the new server, not the old one', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller, server } = buildControllerWithMutableServer(agentService);
    const received: AgentEvent[] = [];
    controller.onEvent((event) => received.push(event));

    const chatId = newChatId('chat-1');
    await controller.openConversation({ chatId });
    agentService.scriptNextResponse({ steps: [{ kind: 'delta', text: 'in flight' }] });
    const sent = await controller.sendMessage({ chatId, prompt: 'hi' });
    expect(sent.ok).toBe(true);

    // Simulate a server switch: the composition root would call this from
    // NavigationEpochTracker.subscribe.
    server.set(
      serverContext({ origin: 'https://author-b.example.com', serverId: 'server-b' as ServerId }),
    );
    server.bumpEpoch();
    await controller.handleAemContextInvalidated();

    expect(received.map((event) => event.type)).toEqual([
      'session.state.changed', // sending
      'session.state.changed', // cancelling
      'session.state.changed', // idle
    ]);
    expect(controller.getStatus().sessionState).toBe('idle');

    // Start a fresh turn after the switch and confirm the tool context binds
    // to the *new* server, proving the switch actually rebound context.
    agentService.scriptNextResponse({});
    const sentAfter = await controller.sendMessage({ chatId, prompt: 'again' });
    expect(sentAfter.ok).toBe(true);
    const context = controller.currentAemToolContext();
    expect(context.origin).toBe('https://author-b.example.com');
    expect(context.serverId).toBe('server-b');
  });

  it('reads the AEM tool context fresh on every call, not once at conversation-open time', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller, server } = buildControllerWithMutableServer(agentService);

    const chatId = newChatId('chat-1');
    await controller.openConversation({ chatId });
    agentService.scriptNextResponse({});
    const sent = await controller.sendMessage({ chatId, prompt: 'hi' });
    expect(sent.ok).toBe(true);

    const before = controller.currentAemToolContext();
    expect(before.origin).toBe('https://author.example.com');

    // Mutate the underlying server context directly (no cancel, no new
    // turn) - simulating the moment a server switch is reflected, before
    // any explicit cancellation callback runs.
    server.set(
      serverContext({ origin: 'https://author-b.example.com', serverId: 'server-b' as ServerId }),
    );
    server.bumpEpoch();

    const after = controller.currentAemToolContext();
    expect(after.origin).toBe('https://author-b.example.com');
    expect(after.serverId).toBe('server-b');
    expect(after.navigationEpoch).toBe(1);
  });

  it('does not send to a destroyed/closed renderer sink', () => {
    const destroyedSend = vi.fn();
    const destroyedSink: AgentChatEventSink = { isDestroyed: () => true, send: destroyedSend };
    const forward = createAgentChatEventForwarder(destroyedSink, 'agent-chat:event');
    forward({ type: 'session.state.changed', chatId: newChatId('c'), sequence: 0, state: 'idle' });
    expect(destroyedSend).not.toHaveBeenCalled();

    const liveSend = vi.fn();
    const liveSink: AgentChatEventSink = { isDestroyed: () => false, send: liveSend };
    const forwardLive = createAgentChatEventForwarder(liveSink, 'agent-chat:event');
    const event: AgentEvent = {
      type: 'session.state.changed',
      chatId: newChatId('c'),
      sequence: 0,
      state: 'idle',
    };
    forwardLive(event);
    expect(liveSend).toHaveBeenCalledWith('agent-chat:event', event);
  });
});

// ---------------------------------------------------------------------------
// createStartupGatedAgentChatController - the honest "still starting"
// placeholder registered before any real AgentService exists.
// ---------------------------------------------------------------------------

describe('createStartupGatedAgentChatController', () => {
  it('reports serviceState "starting" - never a bare "not authenticated" - before markReady is called', () => {
    const gated = createStartupGatedAgentChatController();
    const status = gated.getStatus();

    expect(status.serviceState).toBe('starting');
    // The placeholder auth value must never be mistaken for a real "signed
    // out" answer - callers are required to check serviceState first (see
    // agent-chat-ipc.ts's own doc comment) - but the underlying value it
    // ships today is `false`; pin that down so a future regression that
    // silently drops `serviceState` is caught by the assertion above, not
    // masked by this one changing too.
    expect(status.auth.isAuthenticated).toBe(false);
    expect(status.activeChatId).toBeNull();
    expect(status.sessionState).toBe('idle');
  });

  it('refuses openConversation/sendMessage with a clear, retryable-sounding reason before markReady, never crashing the handler', async () => {
    const gated = createStartupGatedAgentChatController();

    const openResult = await gated.openConversation({ chatId: newChatId('chat-1') });
    expect(openResult).toEqual({
      ok: false,
      error: {
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('still starting') as string,
      },
    });

    const sendResult = await gated.sendMessage({ chatId: newChatId('chat-1'), prompt: 'hi' });
    expect(sendResult.ok).toBe(false);
    if (sendResult.ok) throw new Error('unreachable');
    expect(sendResult.error.code).toBe('PRECONDITION_FAILED');
  });

  it('treats abort/closeConversation as already-satisfied (ok: true) before markReady, since there is no conversation yet to act on', async () => {
    const gated = createStartupGatedAgentChatController();

    await expect(gated.abort({ chatId: newChatId('chat-1') })).resolves.toEqual({ ok: true });
    await expect(gated.closeConversation({ chatId: newChatId('chat-1') })).resolves.toEqual({
      ok: true,
    });
  });

  it('throws a clear error from currentAemToolContext before markReady, rather than fabricating one', () => {
    const gated = createStartupGatedAgentChatController();
    expect(() => gated.currentAemToolContext()).toThrow(/starting/);
  });

  it('is a no-op for handleAemContextInvalidated/dispose before markReady', async () => {
    const gated = createStartupGatedAgentChatController();
    await expect(gated.handleAemContextInvalidated()).resolves.toBeUndefined();
    await expect(gated.dispose()).resolves.toBeUndefined();
  });

  it('delegates every call to the real controller once markReady runs, and forwards its events to listeners registered earlier', async () => {
    const gated = createStartupGatedAgentChatController();
    const received: AgentEvent[] = [];
    gated.onEvent((event) => received.push(event));

    // Listeners/gates registered against the placeholder before the real
    // agent service exists - exactly what `index.ts` does.
    expect(gated.getStatus().serviceState).toBe('starting');

    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller: real } = buildController(agentService);
    gated.markReady(real);

    expect(gated.getStatus().serviceState).toBe('ready');

    const chatId = newChatId('chat-1');
    const openResult = await gated.openConversation({ chatId });
    expect(openResult).toEqual({ ok: true, chatId });

    agentService.scriptNextResponse({ steps: [{ kind: 'delta', text: 'hi' }] });
    const sendResult = await gated.sendMessage({ chatId, prompt: 'hello' });
    expect(sendResult.ok).toBe(true);

    // The turn is still in flight here (not yet flushed), so the AEM tool
    // context can still bind to it - proving `gated` delegates this call to
    // the real controller too, not just the request/response ones above.
    expect(gated.currentAemToolContext().origin).toBe('https://author.example.com');

    agentService.flush();
    expect(received.length).toBeGreaterThan(0);
  });

  it('throws if markReady is called more than once', () => {
    const gated = createStartupGatedAgentChatController();
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller: real } = buildController(agentService);

    gated.markReady(real);
    expect(() => gated.markReady(real)).toThrow(/more than once/);
  });
});
