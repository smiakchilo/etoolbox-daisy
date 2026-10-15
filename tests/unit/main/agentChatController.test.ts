import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createAgentChatController,
  composeModelPrompt,
  createAgentChatEventForwarder,
  createStartupGatedAgentChatController,
  type AemServerContext,
  type AgentChatController,
  type AgentChatControllerDeps,
  type AgentChatEventSink,
} from '../../../src/main/agentChatController';
import { createFakeAgentService } from '../../../src/main/agents/fakeAgentService';
import { removeChatJournal } from '../../../src/main/chatHistory';
import { type ChatJournal, createChatJournal } from '../../../src/main/chatJournal';
import { readChatSessionIds } from '../../../src/main/chatJournalReader';
import type { Logger } from '../../../src/main/logger';
import {
  type AgentAuthState,
  type AgentEvent,
  type AgentService,
  type AgentServiceError,
  type ChatId,
  type OpenConversationRequest,
  type Result,
  type SdkSessionId,
  type SendPromptRequest,
  type ServerId,
  type Unsubscribe,
  type UserInputAnswer,
  ok,
} from '../../../src/shared';

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

/** Lets a controller's `await` chains settle without advancing a timer. */
async function flushMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
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
    currentPageContext: () => undefined,
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
    currentPageContext: () => undefined,
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
  /** Every `sendPrompt` request this double received, in order. */
  readonly sentPrompts: SendPromptRequest[];
}

function createLeakyAgentService(): LeakyAgentService {
  const eventListeners = new Set<(event: AgentEvent) => void>();
  const authListeners = new Set<(state: AgentAuthState) => void>();
  const authState: AgentAuthState = { apiVersion: 1, isAuthenticated: true };
  const sentPrompts: SendPromptRequest[] = [];

  return {
    initialize(): Promise<Result<void, AgentServiceError>> {
      return Promise.resolve(ok(undefined));
    },
    getAuthState(): AgentAuthState {
      return authState;
    },
    getOpenSessionId() {
      return undefined;
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
    sendPrompt(request: SendPromptRequest): Promise<Result<void, AgentServiceError>> {
      sentPrompts.push(request);
      return Promise.resolve(ok(undefined));
    },
    abort(): Promise<Result<void, AgentServiceError>> {
      return Promise.resolve(ok(undefined));
    },
    closeConversation(): Promise<Result<void, AgentServiceError>> {
      return Promise.resolve(ok(undefined));
    },
    deleteSession(): Promise<Result<void, AgentServiceError>> {
      return Promise.resolve(ok(undefined));
    },
    requestUserInput(): Promise<Result<UserInputAnswer, AgentServiceError>> {
      return Promise.resolve(ok({ selections: [], freeform: null }));
    },
    respondToInput(): Promise<Result<void, AgentServiceError>> {
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
    sentPrompts,
  };
}

/**
 * An `AgentService` double whose `openConversation` is held open until the test
 * settles it, so the controller's single-flight + `superseded` behaviour can be
 * driven deterministically. Like the real adapters, it commits its "open chat"
 * only when an open *settles* - which is exactly what let a real out-of-order
 * completion leave the service on the older chat while the controller had moved
 * on.
 */
interface DeferredOpenService extends AgentService {
  /** Every `openConversation` the controller actually handed to the service, in order. */
  readonly openCalls: ChatId[];
  /** Resolves the pending open for `chatId`, committing it as open on success. */
  settleOpen(chatId: ChatId, result: Result<ChatId, AgentServiceError>): void;
  /** The chat this service currently considers open, or `undefined`. */
  openChatId(): ChatId | undefined;
}

function createDeferredOpenService(): DeferredOpenService {
  const eventListeners = new Set<(event: AgentEvent) => void>();
  const authListeners = new Set<(state: AgentAuthState) => void>();
  const authState: AgentAuthState = { apiVersion: 1, isAuthenticated: true };
  const openCalls: ChatId[] = [];
  const pending = new Map<ChatId, (result: Result<ChatId, AgentServiceError>) => void>();
  let openChatId: ChatId | undefined;

  return {
    initialize: () => Promise.resolve(ok(undefined)),
    getAuthState: () => authState,
    getOpenSessionId: () => undefined,
    onAuthStateChanged(listener) {
      authListeners.add(listener);
      return () => authListeners.delete(listener);
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    openConversation(request) {
      openCalls.push(request.chatId);
      return new Promise<Result<ChatId, AgentServiceError>>((resolve) => {
        pending.set(request.chatId, (result) => {
          if (result.ok) openChatId = request.chatId;
          resolve(result);
        });
      });
    },
    sendPrompt: () => Promise.resolve(ok(undefined)),
    abort: () => Promise.resolve(ok(undefined)),
    closeConversation: () => Promise.resolve(ok(undefined)),
    deleteSession: () => Promise.resolve(ok(undefined)),
    requestUserInput: () => Promise.resolve(ok({ selections: [], freeform: null })),
    respondToInput: () => Promise.resolve(ok(undefined)),
    dispose() {
      eventListeners.clear();
      authListeners.clear();
      return Promise.resolve();
    },
    openCalls,
    settleOpen(chatId, result) {
      const settle = pending.get(chatId);
      pending.delete(chatId);
      if (settle === undefined) throw new Error(`no pending open for ${String(chatId)}`);
      settle(result);
    },
    openChatId: () => openChatId,
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
  it('reports serviceState "starting" - never a bare "not authenticated" - before a delegate is installed', () => {
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

  it('refuses openConversation/sendMessage with a clear, retryable-sounding reason before a delegate is installed, never crashing the handler', async () => {
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

  it('treats abort/closeConversation as already-satisfied (ok: true) before a delegate is installed, since there is no conversation yet to act on', async () => {
    const gated = createStartupGatedAgentChatController();

    await expect(gated.abort({ chatId: newChatId('chat-1') })).resolves.toEqual({ ok: true });
    await expect(gated.closeConversation({ chatId: newChatId('chat-1') })).resolves.toEqual({
      ok: true,
    });
  });

  it('throws a clear error from currentAemToolContext before a delegate is installed, rather than fabricating one', () => {
    const gated = createStartupGatedAgentChatController();
    expect(() => gated.currentAemToolContext()).toThrow(/starting/);
  });

  it('is a no-op for handleAemContextInvalidated/dispose before a delegate is installed', async () => {
    const gated = createStartupGatedAgentChatController();
    await expect(gated.handleAemContextInvalidated()).resolves.toBeUndefined();
    await expect(gated.dispose()).resolves.toBeUndefined();
  });

  it('delegates every call to the real controller once replaceDelegate runs, and forwards its events to listeners registered earlier', async () => {
    const gated = createStartupGatedAgentChatController();
    const received: AgentEvent[] = [];
    gated.onEvent((event) => received.push(event));

    // Listeners/gates registered against the placeholder before the real
    // agent service exists - exactly what `index.ts` does.
    expect(gated.getStatus().serviceState).toBe('starting');

    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller: real } = buildController(agentService);
    await gated.replaceDelegate(real);

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

  it("swaps the delegate on a second replaceDelegate call, disposing the previous one and forwarding the new delegate's events", async () => {
    const gated = createStartupGatedAgentChatController();
    const received: AgentEvent[] = [];
    gated.onEvent((event) => received.push(event));

    const firstService = createFakeAgentService({ idGenerator: counterIdGenerator('first') });
    const firstDispose = vi.spyOn(firstService, 'dispose');
    const { controller: first } = buildController(firstService);
    await gated.replaceDelegate(first);

    const chatId = newChatId('chat-1');
    await expect(gated.openConversation({ chatId })).resolves.toEqual({ ok: true, chatId });

    // Recycling the runtime - e.g. a proxy change - replaces the service and
    // the controller built from it while the request stays on `gated`.
    const secondService = createFakeAgentService({ idGenerator: counterIdGenerator('second') });
    const { controller: second } = buildController(secondService);
    await gated.replaceDelegate(second);

    // The old delegate was torn down exactly once...
    expect(firstDispose).toHaveBeenCalledTimes(1);
    // ...and the new one answers subsequent calls.
    await expect(gated.openConversation({ chatId })).resolves.toEqual({ ok: true, chatId });
    secondService.scriptNextResponse({ steps: [{ kind: 'delta', text: 'again' }] });
    const sendResult = await gated.sendMessage({ chatId, prompt: 'hello again' });
    expect(sendResult.ok).toBe(true);
    secondService.flush();
    // ...and its events reach a listener registered before either delegate.
    expect(received.length).toBeGreaterThan(0);
  });

  it('awaits beforeSendMessage and re-reads the delegate, so a recycle applied by the hook sends to the new runtime', async () => {
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const gated = createStartupGatedAgentChatController({
      beforeSendMessage: () =>
        new Promise<void>((resolve) => {
          calls.push('hook');
          release = resolve;
        }),
    });

    const firstService = createFakeAgentService({ idGenerator: counterIdGenerator('first') });
    const { controller: first } = buildController(firstService);
    await gated.replaceDelegate(first);
    const chatId = newChatId('chat-1');
    await gated.openConversation({ chatId });

    // The re-cycled runtime the hook installs, with the conversation reopened -
    // exactly what the renderer's status reconciliation does after a recycle.
    const secondService = createFakeAgentService({ idGenerator: counterIdGenerator('second') });
    secondService.scriptNextResponse({ steps: [{ kind: 'delta', text: 'ok' }] });
    const { controller: second } = buildController(secondService);
    await second.openConversation({ chatId });

    const firstSend = vi.spyOn(firstService, 'sendPrompt');
    const secondSend = vi.spyOn(secondService, 'sendPrompt');

    const pending = gated.sendMessage({ chatId, prompt: 'hello' });
    await Promise.resolve();
    // Awaited: the current delegate is not sent to while the hook is pending.
    expect(calls).toEqual(['hook']);
    expect(firstSend).not.toHaveBeenCalled();

    // The deferred recycle lands while the hook is pending; the send must go to
    // the new delegate, never the disposed one.
    await gated.replaceDelegate(second);
    release?.();

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(firstSend).not.toHaveBeenCalled();
    expect(secondSend).toHaveBeenCalledTimes(1);
    secondService.flush();
  });
});

describe('AgentChatController.onStatusChanged', () => {
  it('notifies when the service reports a new auth state', () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller } = buildController(agentService);
    const listener = vi.fn();
    controller.onStatusChanged(listener);

    agentService.setAuthState({ apiVersion: 1, isAuthenticated: false });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reports no sdkSessionId once the conversation is closed', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller } = buildController(agentService);
    const chatId = newChatId('chat-1');
    await controller.openConversation({ chatId });

    await controller.closeConversation({ chatId });

    expect(controller.getStatus().activeChatId).toBeNull();
    expect(controller.getStatus().sdkSessionId).toBeNull();
  });

  it('stops notifying after the listener unsubscribes', () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller } = buildController(agentService);
    const listener = vi.fn();
    const unsubscribe = controller.onStatusChanged(listener);

    unsubscribe();
    agentService.setAuthState({ apiVersion: 1, isAuthenticated: false });

    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies when the gated controller installs a delegate - the runtime-recycle signal', async () => {
    // This is what makes a token set/clear (or a proxy/active-provider change)
    // visible to the renderer immediately: `replaceDelegate` is the moment the
    // fresh runtime's auth and (empty) active conversation become current.
    const gated = createStartupGatedAgentChatController();
    const listener = vi.fn();
    gated.onStatusChanged(listener);

    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller: real } = buildController(agentService);
    await gated.replaceDelegate(real);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("forwards a delegate's own later auth change to gated listeners", async () => {
    const gated = createStartupGatedAgentChatController();
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller: real } = buildController(agentService);
    await gated.replaceDelegate(real);
    const listener = vi.fn();
    gated.onStatusChanged(listener);

    agentService.setAuthState({ apiVersion: 1, isAuthenticated: false });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('forwards the new delegate, not the replaced one, after a recycle', async () => {
    const gated = createStartupGatedAgentChatController();
    const firstService = createFakeAgentService({ idGenerator: counterIdGenerator('first') });
    const { controller: first } = buildController(firstService);
    await gated.replaceDelegate(first);

    const secondService = createFakeAgentService({ idGenerator: counterIdGenerator('second') });
    const { controller: second } = buildController(secondService);
    await gated.replaceDelegate(second);

    const listener = vi.fn();
    gated.onStatusChanged(listener);
    // The detached delegate must no longer reach the gated listeners...
    firstService.setAuthState({ apiVersion: 1, isAuthenticated: false });
    expect(listener).not.toHaveBeenCalled();
    // ...while the current one does.
    secondService.setAuthState({ apiVersion: 1, isAuthenticated: false });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Chat journal integration (implementation-plan.md step 09)
// ---------------------------------------------------------------------------

interface JournalCall {
  readonly method: string;
  readonly args: unknown;
}

function createRecordingJournal(): { journal: ChatJournal; calls: JournalCall[] } {
  const calls: JournalCall[] = [];
  const journal: ChatJournal = {
    openChat: (params) => calls.push({ method: 'openChat', args: params }),
    recordUserPrompt: (params) => calls.push({ method: 'recordUserPrompt', args: params }),
    discardUserPrompt: (chatId, turnId) =>
      calls.push({ method: 'discardUserPrompt', args: { chatId, turnId } }),
    recordEvent: (event) => calls.push({ method: 'recordEvent', args: event }),
    recordInterruption: (params) => calls.push({ method: 'recordInterruption', args: params }),
    closeChat: (chatId) => calls.push({ method: 'closeChat', args: chatId }),
    getHealth: () => ({ writeFailureCount: 0, droppedRecordCount: 0, lastFailureCode: null }),
  };
  return { journal, calls };
}

function methods(calls: readonly JournalCall[]): string[] {
  return calls.map((call) => call.method);
}

describe('agentChatController chat journal', () => {
  it('opens the journal with the SDK session id and the bound server after a successful open', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { journal, calls } = createRecordingJournal();
    const { controller } = buildController(agentService, { chatJournal: journal });

    const chatId = newChatId('chat-1');
    await controller.openConversation({ chatId });

    expect(calls).toEqual([
      {
        method: 'openChat',
        args: {
          chatId,
          sdkSessionId: 'fake-session-chat-1',
          serverId: 'server-a',
        },
      },
    ]);
  });

  it('stages the prompt before the turn, and records every event including the ones the renderer never sees', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { journal, calls } = createRecordingJournal();
    const { controller } = buildController(agentService, { chatJournal: journal });

    const chatId = newChatId('chat-1');
    await controller.openConversation({ chatId });
    agentService.scriptNextResponse({ steps: [{ kind: 'delta', text: 'hi' }] });
    const sent = await controller.sendMessage({ chatId, prompt: 'hello' });
    expect(sent.ok).toBe(true);
    if (!sent.ok) throw new Error('unreachable');

    // The prompt is staged before sendPrompt, whose synchronous first event is
    // the "sending" state change - so on disk the prompt precedes the turn.
    expect(methods(calls).slice(1, 3)).toEqual(['recordUserPrompt', 'recordEvent']);
    expect(calls[1]?.args).toEqual({ chatId, turnId: sent.turnId, prompt: 'hello' });
    expect(calls[2]?.args).toMatchObject({ type: 'session.state.changed', state: 'sending' });

    agentService.flush();
    expect(methods(calls).filter((method) => method === 'recordEvent').length).toBeGreaterThan(1);
  });
  it('journals the current-page block the model reads, exactly as given, beside the typed prompt', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { journal, calls } = createRecordingJournal();
    const block =
      'Current AEM page (...):\nHost origin: https://author.example\nContent path: /content/a';
    const { controller } = buildController(agentService, {
      chatJournal: journal,
      currentPageContext: () => block,
    });

    const chatId = newChatId('chat-1');
    await controller.openConversation({ chatId });
    const sent = await controller.sendMessage({ chatId, prompt: 'hello' });
    if (!sent.ok) throw new Error('unreachable');

    expect(calls[1]?.args).toEqual({
      chatId,
      turnId: sent.turnId,
      prompt: 'hello',
      pageContext: block,
    });
  });

  it.each([
    ['no block', undefined],
    ['an empty block', ''],
  ])('journals no pageContext when there is %s', async (_name, block) => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { journal, calls } = createRecordingJournal();
    const { controller } = buildController(agentService, {
      chatJournal: journal,
      currentPageContext: () => block,
    });

    const chatId = newChatId('chat-1');
    await controller.openConversation({ chatId });
    await controller.sendMessage({ chatId, prompt: 'hello' });

    expect(calls[1]?.args).not.toHaveProperty('pageContext');
  });

  it('discards a staged prompt when sendPrompt fails', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    // A service that reports a failure after the controller has staged the
    // prompt. The real adapter can fail this way (e.g. an unavailable model).
    const failing = {
      ...agentService,
      sendPrompt: () =>
        Promise.resolve({
          ok: false as const,
          error: { code: 'AGENT_UNAVAILABLE' as const, message: 'no' },
        }),
    };
    const { journal, calls } = createRecordingJournal();
    const { controller } = buildController(failing, { chatJournal: journal });

    const chatId = newChatId('chat-1');
    await controller.openConversation({ chatId });
    const sent = await controller.sendMessage({ chatId, prompt: 'hello' });
    expect(sent.ok).toBe(false);

    expect(methods(calls)).toContain('discardUserPrompt');
    expect(calls.at(-1)).toMatchObject({ method: 'discardUserPrompt' });
  });

  it('closes the journal when the conversation is closed', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { journal, calls } = createRecordingJournal();
    const { controller } = buildController(agentService, { chatJournal: journal });

    const chatId = newChatId('chat-1');
    await controller.openConversation({ chatId });
    await controller.closeConversation({ chatId });

    expect(calls.at(-1)).toEqual({ method: 'closeChat', args: chatId });
  });

  it('closes the previous chat and records its teardown events when switching to another chat', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { journal, calls } = createRecordingJournal();
    const { controller } = buildController(agentService, { chatJournal: journal });

    const chatA = newChatId('chat-a');
    const chatB = newChatId('chat-b');
    await controller.openConversation({ chatId: chatA });
    calls.length = 0;

    await controller.openConversation({ chatId: chatB });

    // chatA's own "closed" event is still recorded, and only then is chatA's
    // journal closed and chatB's opened.
    expect(methods(calls)).toEqual(['recordEvent', 'closeChat', 'openChat']);
    expect(calls[0]?.args).toMatchObject({ type: 'session.state.changed', state: 'closed' });
    expect(calls[1]?.args).toBe(chatA);
    expect(calls[2]?.args).toMatchObject({ chatId: chatB });
  });

  it("records a 'stopped' interruption when a Stop cancels a turn in flight", async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { journal, calls } = createRecordingJournal();
    const { controller } = buildController(agentService, { chatJournal: journal });

    const chatId = newChatId('chat-1');
    await controller.openConversation({ chatId });
    agentService.scriptNextResponse({ steps: [{ kind: 'delta', text: 'slow' }] });
    await controller.sendMessage({ chatId, prompt: 'hi' });
    calls.length = 0;

    await controller.abort({ chatId });

    // The turn's own cancelling/idle events are journaled first; the notice
    // lands after them, so a resumed chat replays it in order.
    expect(methods(calls)).toEqual(['recordEvent', 'recordEvent', 'recordInterruption']);
    expect(calls.at(-1)?.args).toEqual({ chatId, reason: 'stopped' });
  });

  it('records no interruption when a Stop arrives with no turn in flight', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { journal, calls } = createRecordingJournal();
    const { controller } = buildController(agentService, { chatJournal: journal });

    const chatId = newChatId('chat-1');
    await controller.openConversation({ chatId });
    calls.length = 0;

    await controller.abort({ chatId });

    expect(methods(calls)).not.toContain('recordInterruption');
  });

  it("records a 'navigation' interruption on an AEM-context abort", async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { journal, calls } = createRecordingJournal();
    const { controller } = buildController(agentService, { chatJournal: journal });

    const chatId = newChatId('chat-1');
    await controller.openConversation({ chatId });
    agentService.scriptNextResponse({ steps: [{ kind: 'delta', text: 'slow' }] });
    await controller.sendMessage({ chatId, prompt: 'hi' });
    calls.length = 0;

    await controller.handleAemContextInvalidated();

    expect(calls.at(-1)).toEqual({
      method: 'recordInterruption',
      args: { chatId, reason: 'navigation' },
    });
  });

  it('journals the model diagnostics events of the live turn but never forwards them to the renderer', async () => {
    const leaky = createLeakyAgentService();
    const { journal, calls } = createRecordingJournal();
    const { controller } = buildController(leaky, { chatJournal: journal });
    const received: AgentEvent[] = [];
    controller.onEvent((event) => received.push(event));

    const chatId = newChatId('chat-1');
    await controller.openConversation({ chatId });
    const sent = await controller.sendMessage({ chatId, prompt: 'hi' });
    if (!sent.ok) throw new Error('unreachable');
    received.length = 0;

    const diagnostics = [
      { type: 'model.changed', model: 'gpt-x', cause: 'session-open' },
      { type: 'model.usage', inputTokens: 5 },
      { type: 'model.call.failed', statusCode: 503 },
    ];
    diagnostics.forEach((diagnostic, index) => {
      leaky.emit({
        ...diagnostic,
        chatId,
        sequence: 10 + index,
        turnId: sent.turnId,
      } as AgentEvent);
    });

    expect(received).toEqual([]);
    const journaled = calls
      .filter((call) => call.method === 'recordEvent')
      .map((call) => (call.args as AgentEvent).type);
    expect(journaled).toEqual(expect.arrayContaining(diagnostics.map((d) => d.type)));
  });
});

describe('agentChatController AEM-request cancellation', () => {
  it('cancels in-flight AEM requests on Stop', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const cancelAemRequests = vi.fn();
    const { controller } = buildController(agentService, { cancelAemRequests });

    const chatId = newChatId('chat-1');
    await controller.openConversation({ chatId });
    agentService.scriptNextResponse({ steps: [{ kind: 'delta', text: 'slow' }] });
    await controller.sendMessage({ chatId, prompt: 'hi' });

    await controller.abort({ chatId });
    expect(cancelAemRequests).toHaveBeenCalledTimes(1);
  });

  it('cancels in-flight AEM requests when the conversation is closed', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const cancelAemRequests = vi.fn();
    const { controller } = buildController(agentService, { cancelAemRequests });

    const chatId = newChatId('chat-1');
    await controller.openConversation({ chatId });
    await controller.closeConversation({ chatId });

    expect(cancelAemRequests).toHaveBeenCalledTimes(1);
  });

  it('cancels in-flight AEM requests when switching to another chat', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const cancelAemRequests = vi.fn();
    const { controller } = buildController(agentService, { cancelAemRequests });

    await controller.openConversation({ chatId: newChatId('chat-a') });
    await controller.openConversation({ chatId: newChatId('chat-b') });

    expect(cancelAemRequests).toHaveBeenCalledTimes(1);
  });

  it('cancels AEM requests and logs the cause on an AEM-context invalidation', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const cancelAemRequests = vi.fn();
    const info = vi.fn();
    const logger: Logger = {
      info,
      warn: vi.fn(),
      error: vi.fn(),
      getHealth: () => ({ writeFailureCount: 0, lastFailureCode: null, rotationCount: 0 }),
    };
    const { controller } = buildController(agentService, { cancelAemRequests, logger });

    const chatId = newChatId('chat-1');
    await controller.openConversation({ chatId });
    agentService.scriptNextResponse({ steps: [{ kind: 'delta', text: 'slow' }] });
    await controller.sendMessage({ chatId, prompt: 'hi' });

    await controller.handleAemContextInvalidated();

    expect(cancelAemRequests).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('AGENT_CHAT_ABORT_ON_CONTEXT_CHANGE', {
      ids: { chatId },
    });
  });

  it('does nothing on a context invalidation when no turn is in flight', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const cancelAemRequests = vi.fn();
    const { controller } = buildController(agentService, { cancelAemRequests });

    await controller.openConversation({ chatId: newChatId('chat-1') });
    await controller.handleAemContextInvalidated();

    expect(cancelAemRequests).not.toHaveBeenCalled();
  });
});

describe('agentChatController.deleteConversation', () => {
  it('deletes an unopened chat: its SDK session and its journal', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const removeChatJournal = vi.fn(() => true);
    const { controller } = buildController(agentService, {
      readChatSessionIds: () => ['sdk-chat-1' as SdkSessionId],
      removeChatJournal,
    });

    const result = await controller.deleteConversation({ chatId: newChatId('chat-1') });

    expect(result).toEqual({ ok: true });
    expect(agentService.deletedSessionIds()).toEqual(['sdk-chat-1']);
    expect(removeChatJournal).toHaveBeenCalledWith('chat-1');
  });

  it('deletes every session the journal recorded, not only the header', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller } = buildController(agentService, {
      readChatSessionIds: () => [
        'sdk-chat-1' as SdkSessionId,
        'sdk-chat-1-recycled' as SdkSessionId,
      ],
      removeChatJournal: () => true,
    });

    const result = await controller.deleteConversation({ chatId: newChatId('chat-1') });

    expect(result).toEqual({ ok: true });
    expect(agentService.deletedSessionIds()).toEqual(['sdk-chat-1', 'sdk-chat-1-recycled']);
  });

  it('removes every session a twice-recycled chat recorded, through the real journal', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'daisy-delete-'));
    const journalPath = path.join(dir, 'chat-1.jsonl');
    try {
      const journal = createChatJournal(dir);
      const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
      let sessionId = 'sdk-1' as SdkSessionId;
      const withSession: AgentService = { ...agentService, getOpenSessionId: () => sessionId };
      const { controller } = buildController(withSession, {
        chatJournal: journal,
        readChatSessionIds: (chatId) => readChatSessionIds(dir, chatId),
        removeChatJournal: (chatId) => removeChatJournal(dir, chatId),
      });

      const chatId = newChatId('chat-1');
      await controller.openConversation({ chatId });
      // Using the chat flushes its header - the first session id.
      await controller.sendMessage({ chatId, prompt: 'one' });
      await controller.closeConversation({ chatId });

      // A first runtime recycle re-opens the same chat under a new session.
      sessionId = 'sdk-2' as SdkSessionId;
      await controller.openConversation({ chatId });
      await controller.sendMessage({ chatId, prompt: 'two' });
      await controller.closeConversation({ chatId });

      // A second recycle mints yet another session for the same chat.
      sessionId = 'sdk-3' as SdkSessionId;
      await controller.openConversation({ chatId });

      // Three sessions are recorded on disk before deletion.
      expect(readChatSessionIds(dir, chatId)).toEqual(['sdk-1', 'sdk-2', 'sdk-3']);

      const result = await controller.deleteConversation({ chatId });

      expect(result).toEqual({ ok: true });
      expect(agentService.deletedSessionIds()).toEqual(['sdk-1', 'sdk-2', 'sdk-3']);
      // The app's own record is gone too.
      expect(existsSync(journalPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops and closes an open chat before deleting it', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller } = buildController(agentService, {
      readChatSessionIds: () => ['sdk-chat-1' as SdkSessionId],
      removeChatJournal: () => true,
    });

    const chatId = newChatId('chat-1');
    await controller.openConversation({ chatId });

    const result = await controller.deleteConversation({ chatId });

    expect(result).toEqual({ ok: true });
    // The open conversation is no longer owned after deletion.
    expect(controller.getStatus().activeChatId).toBeNull();
  });

  it('is non-fatal when the SDK session cannot be deleted, but still removes the journal', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const failing = {
      ...agentService,
      deleteSession: () =>
        Promise.resolve({
          ok: false as const,
          error: { code: 'STORAGE_ERROR' as const, message: 'nope' },
        }),
    };
    const removeChatJournal = vi.fn(() => true);
    // A local spy, not `noopLogger().warn`: reading a method off an object to
    // hand to `expect` trips `@typescript-eslint/unbound-method`.
    const warn = vi.fn<(code: string, fields?: unknown) => void>();
    const logger: Logger = {
      info: vi.fn(),
      warn,
      error: vi.fn(),
      getHealth: () => ({ writeFailureCount: 0, lastFailureCode: null, rotationCount: 0 }),
    };
    const { controller } = buildController(failing, {
      logger,
      readChatSessionIds: () => ['sdk-chat-1' as SdkSessionId],
      removeChatJournal,
    });

    const result = await controller.deleteConversation({ chatId: newChatId('chat-1') });

    expect(result).toEqual({ ok: true });
    expect(removeChatJournal).toHaveBeenCalledWith('chat-1');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe('AGENT_CHAT_DELETE_SESSION_FAILED');
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ ids: { chatId: 'chat-1' } });
  });

  it('reports a storage error when the journal file cannot be removed', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller } = buildController(agentService, {
      readChatSessionIds: () => [],
      removeChatJournal: () => false,
    });

    const result = await controller.deleteConversation({ chatId: newChatId('chat-1') });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('STORAGE_ERROR');
  });

  it('deletes a chat with no journal-storage deps without touching an SDK session', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller } = buildController(agentService);

    const result = await controller.deleteConversation({ chatId: newChatId('chat-1') });

    expect(result).toEqual({ ok: true });
    expect(agentService.deletedSessionIds()).toEqual([]);
  });

  it('refuses deletion while no agent service is installed (gated controller)', async () => {
    const gated = createStartupGatedAgentChatController();

    const result = await gated.deleteConversation({ chatId: newChatId('chat-1') });

    expect(result.ok).toBe(false);
  });
});

describe('composeModelPrompt', () => {
  it('returns the prompt unchanged when there is no page context', () => {
    expect(composeModelPrompt(undefined, 'hi')).toBe('hi');
    expect(composeModelPrompt('', 'hi')).toBe('hi');
  });

  it('prepends the context block, separated by a blank line', () => {
    expect(composeModelPrompt('CTX-BLOCK', 'hi')).toBe('CTX-BLOCK\n\nhi');
  });
});

describe('agentChatController page context', () => {
  it('sends the current page context as part of the model prompt while the typed prompt is what is displayed', async () => {
    const leaky = createLeakyAgentService();
    const { controller } = buildController(leaky, {
      currentPageContext: () => 'CTX-BLOCK',
    });
    const chatId = newChatId('chat-ctx');
    await controller.openConversation({ chatId });

    const sent = await controller.sendMessage({ chatId, prompt: 'what is on this page?' });
    expect(sent.ok).toBe(true);
    if (!sent.ok) throw new Error('unreachable');

    expect(leaky.sentPrompts.at(-1)).toEqual({
      chatId,
      turnId: sent.turnId,
      prompt: 'CTX-BLOCK\n\nwhat is on this page?',
      displayPrompt: 'what is on this page?',
    });
  });

  it('leaves the prompt untouched when the provider yields no context', async () => {
    const leaky = createLeakyAgentService();
    const { controller } = buildController(leaky);
    const chatId = newChatId('chat-ctx');
    await controller.openConversation({ chatId });

    const sent = await controller.sendMessage({ chatId, prompt: 'plain' });
    expect(sent.ok).toBe(true);
    if (!sent.ok) throw new Error('unreachable');

    expect(leaky.sentPrompts.at(-1)).toEqual({
      chatId,
      turnId: sent.turnId,
      prompt: 'plain',
      displayPrompt: 'plain',
    });
  });

  it('reads the page context fresh on every send, so navigation between turns is reflected', async () => {
    const leaky = createLeakyAgentService();
    let context: string | undefined = 'PAGE-A';
    const { controller } = buildController(leaky, { currentPageContext: () => context });
    const chatId = newChatId('chat-ctx');
    await controller.openConversation({ chatId });

    await controller.sendMessage({ chatId, prompt: 'one' });
    context = 'PAGE-B';
    await controller.sendMessage({ chatId, prompt: 'two' });

    expect(leaky.sentPrompts.map((request) => request.prompt)).toEqual([
      'PAGE-A\n\none',
      'PAGE-B\n\ntwo',
    ]);
  });
});

describe('agentChatController skill prompt rewrite', () => {
  it('rewrites only the model-facing prompt, keeping the user text for display', async () => {
    const leaky = createLeakyAgentService();
    const { controller } = buildController(leaky, {
      currentPageContext: () => 'CTX-BLOCK',
      resolveSkillPrompt: (prompt) =>
        prompt === '/aem-tool-selection what tool?' ? 'DIRECTIVE' : prompt,
    });
    const chatId = newChatId('chat-skill');
    await controller.openConversation({ chatId });

    const sent = await controller.sendMessage({
      chatId,
      prompt: '/aem-tool-selection what tool?',
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) throw new Error('unreachable');

    expect(leaky.sentPrompts.at(-1)).toEqual({
      chatId,
      turnId: sent.turnId,
      prompt: 'CTX-BLOCK\n\nDIRECTIVE',
      displayPrompt: '/aem-tool-selection what tool?',
    });
  });

  it('passes an unrecognised prompt through unchanged', async () => {
    const leaky = createLeakyAgentService();
    const { controller } = buildController(leaky, {
      resolveSkillPrompt: (prompt) => prompt,
    });
    const chatId = newChatId('chat-skill');
    await controller.openConversation({ chatId });

    await controller.sendMessage({ chatId, prompt: '/content/wknd/us/en' });

    expect(leaky.sentPrompts.at(-1)).toMatchObject({
      prompt: '/content/wknd/us/en',
      displayPrompt: '/content/wknd/us/en',
    });
  });

  it('leaves the prompt untouched when no resolver is configured', async () => {
    const leaky = createLeakyAgentService();
    const { controller } = buildController(leaky);
    const chatId = newChatId('chat-skill');
    await controller.openConversation({ chatId });

    await controller.sendMessage({ chatId, prompt: '/aem-tool-selection hi' });

    expect(leaky.sentPrompts.at(-1)).toMatchObject({
      prompt: '/aem-tool-selection hi',
      displayPrompt: '/aem-tool-selection hi',
    });
  });
});

describe('interactive questions', () => {
  it('forwards the question and routes the answer back to the service', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller } = buildController(agentService);
    const received: AgentEvent[] = [];
    controller.onEvent((event) => received.push(event));

    const chatId = newChatId('chat-q');
    await controller.openConversation({ chatId });
    agentService.scriptNextResponse({
      steps: [{ kind: 'inputRequest', question: 'Pick a colour', options: ['Red', 'Green'] }],
    });
    await controller.sendMessage({ chatId, prompt: 'hi' });
    // Delivers up to and including the question, then pauses on the answer.
    agentService.flush();

    const requested = received.find((event) => event.type === 'user.input.requested');
    expect(requested).toMatchObject({
      type: 'user.input.requested',
      question: 'Pick a colour',
      options: ['Red', 'Green'],
    });
    if (requested?.type !== 'user.input.requested') throw new Error('no question forwarded');

    const answered = await controller.respondToInput({
      chatId,
      requestId: requested.requestId,
      answer: { selections: ['Red'], freeform: null },
    });
    expect(answered.ok).toBe(true);

    agentService.flush();
    const result = received.find((event) => event.type === 'tool.result');
    expect(result).toMatchObject({ type: 'tool.result', outcome: { ok: true } });
    expect(received.at(-1)).toMatchObject({ type: 'session.state.changed', state: 'idle' });
  });

  it('refuses an answer for a conversation that is not open', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller } = buildController(agentService);
    const result = await controller.respondToInput({
      chatId: newChatId('not-open'),
      requestId: 'missing' as never,
      answer: { selections: [], freeform: null },
    });
    expect(result.ok).toBe(false);
  });
});

describe('nested tool calls (ToolHost.invokeTool)', () => {
  const spyLogger = (error: Logger['error']): Logger => ({
    info: vi.fn(),
    warn: vi.fn(),
    error,
    getHealth: () => ({ writeFailureCount: 0, lastFailureCode: null, rotationCount: 0 }),
  });
  const started = {
    phase: 'started' as const,
    toolCallId: 'nested-1' as never,
    toolName: 'format_table',
    args: { data: [], mode: 'new' },
  };
  const settled = {
    phase: 'settled' as const,
    toolCallId: 'nested-1' as never,
    outcome: ok({ rows: 0 }),
  };

  it('forwards and journals a nested call as tool events of the active turn', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { journal, calls } = createRecordingJournal();
    const { controller } = buildController(agentService, { chatJournal: journal });
    const received: AgentEvent[] = [];
    controller.onEvent((event) => received.push(event));

    const chatId = newChatId('chat-n');
    await controller.openConversation({ chatId });
    agentService.scriptNextResponse({ steps: [{ kind: 'delta', text: 'done' }] });
    await controller.sendMessage({ chatId, prompt: 'hi' });

    controller.recordNestedToolCall(started);
    controller.recordNestedToolCall(settled);

    const requested = received.find((event) => event.type === 'tool.call.requested');
    expect(requested).toMatchObject({
      chatId,
      toolCallId: 'nested-1',
      toolName: 'format_table',
      arguments: { data: [], mode: 'new' },
    });
    expect(received.find((event) => event.type === 'tool.result')).toMatchObject({
      toolCallId: 'nested-1',
      outcome: { ok: true, data: { rows: 0 } },
    });
    const journaled = calls
      .filter((call) => call.method === 'recordEvent')
      .map((call) => (call.args as AgentEvent).type);
    expect(journaled).toContain('tool.call.requested');
    expect(journaled).toContain('tool.result');

    agentService.flush();
    expect(received.at(-1)).toMatchObject({ type: 'session.state.changed', state: 'idle' });
  });

  it('carries a failed nested outcome as a structured tool error', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller } = buildController(agentService);
    const received: AgentEvent[] = [];
    controller.onEvent((event) => received.push(event));

    const chatId = newChatId('chat-e');
    await controller.openConversation({ chatId });
    agentService.scriptNextResponse({ steps: [{ kind: 'delta', text: 'x' }] });
    await controller.sendMessage({ chatId, prompt: 'hi' });
    controller.recordNestedToolCall(started);
    controller.recordNestedToolCall({
      phase: 'settled',
      toolCallId: 'nested-1' as never,
      outcome: {
        ok: false,
        error: {
          code: 'CANCELLED',
          message: 'Stopped',
          requestId: 'req-1' as never,
          retryable: false,
          requiredAction: 'none',
        },
      },
    });

    expect(received.find((event) => event.type === 'tool.result')).toMatchObject({
      outcome: { ok: false, error: { code: 'CANCELLED' } },
    });
  });

  it('ignores a nested call when no turn is running', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { journal, calls } = createRecordingJournal();
    const error = vi.fn();
    const { controller } = buildController(agentService, {
      chatJournal: journal,
      logger: spyLogger(error),
    });
    const received: AgentEvent[] = [];
    controller.onEvent((event) => received.push(event));

    controller.recordNestedToolCall(started);
    await controller.openConversation({ chatId: newChatId('chat-idle') });
    controller.recordNestedToolCall(started);

    expect(received.filter((event) => event.type === 'tool.call.requested')).toEqual([]);
    expect(methods(calls)).not.toContain('recordEvent');
    expect(error).not.toHaveBeenCalled();
  });

  it('drops a nested call quietly once the turn is being cancelled', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const error = vi.fn();
    const { controller } = buildController(agentService, { logger: spyLogger(error) });
    const received: AgentEvent[] = [];
    controller.onEvent((event) => received.push(event));

    const chatId = newChatId('chat-c');
    await controller.openConversation({ chatId });
    agentService.scriptNextResponse({ steps: [{ kind: 'delta', text: 'x' }] });
    const sent = await controller.sendMessage({ chatId, prompt: 'hi' });
    if (!sent.ok) throw new Error('unreachable');
    const aborting = controller.abort({ chatId });
    controller.recordNestedToolCall(started);
    await aborting;

    expect(received.filter((event) => event.type === 'tool.call.requested')).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it('is forwarded by the startup-gated controller once the real one is installed', async () => {
    const { controller: real } = buildController(
      createFakeAgentService({ idGenerator: counterIdGenerator('fake') }),
    );
    const spy = vi.spyOn(real, 'recordNestedToolCall');
    const gated = createStartupGatedAgentChatController();
    gated.recordNestedToolCall(started);
    await gated.replaceDelegate(real);
    gated.recordNestedToolCall(started);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('forwards a tool progress note to the renderer but never journals it', async () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { journal, calls } = createRecordingJournal();
    const { controller } = buildController(agentService, { chatJournal: journal });
    const received: AgentEvent[] = [];
    controller.onEvent((event) => received.push(event));

    const chatId = newChatId('chat-p');
    await controller.openConversation({ chatId });
    agentService.scriptNextResponse({ steps: [{ kind: 'delta', text: 'x' }] });
    await controller.sendMessage({ chatId, prompt: 'hi' });
    // Registers `nested-1` as a tool call of the active turn (progress is only
    // accepted for a call the turn owns).
    controller.recordNestedToolCall(started);
    controller.recordToolProgress('nested-1' as never, 'Reading 12 of 20');

    expect(received.find((event) => event.type === 'tool.call.progress')).toMatchObject({
      chatId,
      toolCallId: 'nested-1',
      text: 'Reading 12 of 20',
    });
    const journaled = calls
      .filter((call) => call.method === 'recordEvent')
      .map((call) => (call.args as AgentEvent).type);
    expect(journaled).toContain('tool.call.requested');
    // Transient: running-only status, meaningless on replay.
    expect(journaled).not.toContain('tool.call.progress');
  });

  it('ignores a tool progress note when no turn is running', () => {
    const agentService = createFakeAgentService({ idGenerator: counterIdGenerator('fake') });
    const { controller } = buildController(agentService);
    const received: AgentEvent[] = [];
    controller.onEvent((event) => received.push(event));

    controller.recordToolProgress('nested-1' as never, 'Reading 1 of 2');

    expect(received.filter((event) => event.type === 'tool.call.progress')).toEqual([]);
  });

  it('is forwarded by the startup-gated controller once the real one is installed', async () => {
    const { controller: real } = buildController(
      createFakeAgentService({ idGenerator: counterIdGenerator('fake') }),
    );
    const spy = vi.spyOn(real, 'recordToolProgress');
    const gated = createStartupGatedAgentChatController();
    gated.recordToolProgress('nested-1' as never, 'Reading 1 of 2');
    await gated.replaceDelegate(real);
    gated.recordToolProgress('nested-1' as never, 'Reading 2 of 2');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Single-flight + supersede for openConversation (the "XXX is not the open
  // conversation" banner: two opens for different chats completing out of
  // order left the service on the older chat)
  // -------------------------------------------------------------------------

  it('serializes concurrent opens so the service is never mid-open for two chats, and reports the superseded one as not-applicable', async () => {
    const agentService = createDeferredOpenService();
    const { controller } = buildController(agentService);

    const first = controller.openConversation({ chatId: newChatId('chat-a') });
    const second = controller.openConversation({ chatId: newChatId('chat-b') });
    await flushMicrotasks();

    // Single-flight: chat-b is not handed to the service until chat-a settles -
    // that is what removes the out-of-order completion in the first place.
    expect(agentService.openCalls).toEqual([newChatId('chat-a')]);
    expect(controller.getStatus().activeChatId).toBe('chat-b');

    agentService.settleOpen(newChatId('chat-a'), ok(newChatId('chat-a')));
    await flushMicrotasks();
    expect(agentService.openCalls).toEqual([newChatId('chat-a'), newChatId('chat-b')]);

    agentService.settleOpen(newChatId('chat-b'), ok(newChatId('chat-b')));

    // The superseded request is "not applicable", never a failure of chat-b.
    await expect(first).resolves.toMatchObject({
      ok: false,
      error: { code: 'PRECONDITION_FAILED' },
    });
    await expect(second).resolves.toEqual({ ok: true, chatId: 'chat-b' });
    expect(controller.getStatus().activeChatId).toBe('chat-b');
    expect(agentService.openChatId()).toBe('chat-b');

    // And the send the pane would make goes through: controller and service agree.
    await expect(
      controller.sendMessage({ chatId: newChatId('chat-b'), prompt: 'hi' }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('does not let a superseded open that failed clear the chat a newer open made active', async () => {
    const agentService = createDeferredOpenService();
    const { controller } = buildController(agentService);

    const first = controller.openConversation({ chatId: newChatId('chat-a') });
    const second = controller.openConversation({ chatId: newChatId('chat-b') });
    await flushMicrotasks();

    // chat-a (superseded) fails; chat-b then opens. Without the supersede guard
    // chat-a's failure would reset activeChatId to undefined *after* chat-b had
    // already become the active chat, so the next send would be refused.
    agentService.settleOpen(newChatId('chat-a'), {
      ok: false,
      error: { code: 'AGENT_UNAVAILABLE', message: 'could not open' },
    });
    await flushMicrotasks();
    agentService.settleOpen(newChatId('chat-b'), ok(newChatId('chat-b')));

    await expect(first).resolves.toMatchObject({
      ok: false,
      error: { code: 'PRECONDITION_FAILED' },
    });
    await expect(second).resolves.toEqual({ ok: true, chatId: 'chat-b' });
    expect(controller.getStatus().activeChatId).toBe('chat-b');
  });

  it('serializes a repeated open of the same chat and leaves that chat open', async () => {
    const agentService = createDeferredOpenService();
    const { controller } = buildController(agentService);
    const chatId = newChatId('chat-a');

    const first = controller.openConversation({ chatId });
    const second = controller.openConversation({ chatId });
    await flushMicrotasks();
    expect(agentService.openCalls).toEqual([chatId]);

    agentService.settleOpen(chatId, ok(chatId));
    await flushMicrotasks();
    expect(agentService.openCalls).toEqual([chatId, chatId]);
    agentService.settleOpen(chatId, ok(chatId));

    await expect(first).resolves.toMatchObject({
      ok: false,
      error: { code: 'PRECONDITION_FAILED' },
    });
    await expect(second).resolves.toEqual({ ok: true, chatId });
    expect(controller.getStatus().activeChatId).toBe(chatId);
  });
});
