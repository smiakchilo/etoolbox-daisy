import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentChatController,
  type AgentChatControllerDeps,
  createAgentChatController,
} from '../../../src/main/agentChatController';
import type { Logger } from '../../../src/main/logger';
import {
  type AgentAuthState,
  type AgentEvent,
  type AgentService,
  type AgentServiceError,
  type ChatId,
  type CurrentToolContext,
  type MessageId,
  type OpenConversationRequest,
  type RequestId,
  type Result,
  type SendPromptRequest,
  type ServerId,
  type ToolCallId,
  type Unsubscribe,
  createToolError,
  ok,
} from '../../../src/shared';

/**
 * The turn a `sendMessage` registers exists from that moment until the turn's
 * *own* terminal event - not "while the session happens to be idle".
 *
 * A resumed Copilot session is the case that proves it: the adapter applies the
 * stored model preference at prompt time, the SDK answers with
 * `session.model_change`, and that is mapped to a **turn-less** `model.changed`
 * (`cause: "runtime-reported"`) which arrives *before* the turn's `sending`
 * event. Reading the session state at that moment saw `idle` and dropped the turn
 * that had just been registered, so every event of the real turn was then dropped
 * as unowned: no "Thinking" billet, no tool billets, no answer, and every tool
 * that needs `currentToolContext()` failed with "no active chat/turn to bind
 * to". Only the first prompt after a restore hit it (see
 * `tests/live/first-prompt-after-restore.live.spec.ts`).
 */

const chatId = 'chat-1' as ChatId;
const toolCallId = 'call-1' as ToolCallId;
const messageId = 'message-1' as MessageId;

function noopLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    getHealth: () => ({ writeFailureCount: 0, lastFailureCode: null, rotationCount: 0 }),
  };
}

/**
 * An `AgentService` double that reports the resumed session's model inside
 * `sendPrompt`, before the turn's `sending` event - the exact order the Copilot
 * adapter produces after a resume - then runs one tool call and closes the turn.
 * Scriptable so a failing call can also drive the post-turn reflection.
 */
interface ResumedReportService extends AgentService {
  /** Every event the double emitted, in order (the journal's view of a turn). */
  readonly emitted: AgentEvent[];
  /** Turns the scripted tool call into a failure. */
  setToolFailure(failure: boolean): void;
}

function createResumedReportService(): ResumedReportService {
  const eventListeners = new Set<(event: AgentEvent) => void>();
  const authState: AgentAuthState = { apiVersion: 1, isAuthenticated: true };
  const emitted: AgentEvent[] = [];
  let sequence = 0;
  let toolFailure = false;

  const emit = (event: AgentEvent): void => {
    emitted.push(event);
    for (const listener of [...eventListeners]) listener(event);
  };

  return {
    initialize: () => Promise.resolve(ok(undefined)),
    getAuthState: () => authState,
    getOpenSessionId: () => undefined,
    onAuthStateChanged: (): Unsubscribe => () => undefined,
    onEvent(listener): Unsubscribe {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    openConversation: (request: OpenConversationRequest) => Promise.resolve(ok(request.chatId)),
    sendPrompt(request: SendPromptRequest): Promise<Result<void, AgentServiceError>> {
      // 1. The resumed session reports its model. Turn-less, exactly as the
      //    adapter emits it: its own `currentTurn` is not set at that point.
      emit({
        type: 'model.changed',
        chatId,
        sequence: sequence++,
        model: 'model-a',
        previousModel: 'model-a',
        cause: 'runtime-reported',
      });
      // 2. Only now does the turn start.
      emit({
        type: 'session.state.changed',
        chatId,
        sequence: sequence++,
        turnId: request.turnId,
        state: 'sending',
      });
      // 3. One tool call, then the answer, then the turn's end.
      emit({
        type: 'tool.call.requested',
        chatId,
        sequence: sequence++,
        toolCallId,
        toolName: 'aem_query',
        arguments: { predicates: { type: 'cq:Page' } },
      });
      emit({ type: 'tool.call.approved', chatId, sequence: sequence++, toolCallId });
      emit({
        type: 'tool.result',
        chatId,
        sequence: sequence++,
        toolCallId,
        outcome: toolFailure
          ? {
              ok: false,
              error: createToolError(
                'UNEXPECTED_RESPONSE',
                'The query was refused',
                'request-1' as RequestId,
              ),
            }
          : { ok: true, data: { ok: true, resultType: 'success' } },
      });
      emit({
        type: 'assistant.message.started',
        chatId,
        sequence: sequence++,
        turnId: request.turnId,
        messageId,
      });
      emit({
        type: 'assistant.message.completed',
        chatId,
        sequence: sequence++,
        turnId: request.turnId,
        messageId,
        content: 'done',
      });
      emit({
        type: 'session.state.changed',
        chatId,
        sequence: sequence++,
        turnId: request.turnId,
        state: 'idle',
      });
      return Promise.resolve(ok(undefined));
    },
    abort: () => Promise.resolve(ok(undefined)),
    closeConversation: () => Promise.resolve(ok(undefined)),
    deleteSession: () => Promise.resolve(ok(undefined)),
    requestUserInput: () => Promise.resolve(ok({ selections: [], freeform: null })),
    respondToInput: () => Promise.resolve(ok(undefined)),
    dispose: () => {
      eventListeners.clear();
      return Promise.resolve();
    },
    emitted,
    setToolFailure(failure) {
      toolFailure = failure;
    },
  };
}

/** What the controller answered when the tool call was dispatched, as its executor would. */
interface ContextProbe {
  context: CurrentToolContext | undefined;
  failure: unknown;
}

interface Harness {
  readonly service: ResumedReportService;
  readonly controller: AgentChatController;
  /** Events the controller forwarded to a renderer-style listener. */
  readonly forwarded: AgentEvent[];
  readonly prompts: string[];
  /** The context read at the dispatched tool call. */
  readonly probe: ContextProbe;
}

function build(overrides: Partial<AgentChatControllerDeps> = {}): Harness {
  const service = createResumedReportService();
  const forwarded: AgentEvent[] = [];
  const prompts: string[] = [];
  const probe: ContextProbe = { context: undefined, failure: undefined };
  const sendPrompt = service.sendPrompt.bind(service);
  service.sendPrompt = (request) => {
    prompts.push(request.prompt);
    return sendPrompt(request);
  };
  let n = 0;
  const controller = createAgentChatController({
    agentService: service,
    logger: noopLogger(),
    idGenerator: () => `id-${String(n++)}`,
    currentHostContext: () => ({
      origin: 'https://author.example.com',
      serverId: 'server-a' as ServerId,
      serverRevision: 1,
    }),
    navigationEpoch: () => 0,
    currentPageContext: () => undefined,
    ...overrides,
  });
  controller.onEvent((event) => {
    forwarded.push(event);
    // A tool's executor asks the controller for the turn's context once its call
    // is dispatched; asking here is the same call at the same moment.
    if (event.type !== 'tool.call.requested') return;
    try {
      probe.context = controller.currentToolContext();
      probe.failure = undefined;
    } catch (error) {
      probe.context = undefined;
      probe.failure = error;
    }
  });
  return { service, controller, forwarded, prompts, probe };
}

describe('the turn a send registers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('survives a resumed session reporting its model before the turn’s own `sending`', async () => {
    const harness = build();
    await harness.controller.openConversation({ chatId });

    const sent = await harness.controller.sendMessage({ chatId, prompt: 'go to the page' });

    expect(sent.ok).toBe(true);
    // The trigger really happened: a turn-less model report comes first.
    expect(harness.service.emitted[0]).toMatchObject({
      type: 'model.changed',
      cause: 'runtime-reported',
    });
    expect(harness.service.emitted[0]).not.toHaveProperty('turnId');
    // ...and the turn's own events were still accepted and forwarded.
    expect(
      harness.forwarded.map((event) =>
        event.type === 'session.state.changed' ? `state:${event.state}` : event.type,
      ),
    ).toEqual([
      'model.changed',
      'state:sending',
      'tool.call.requested',
      'tool.call.approved',
      'tool.result',
      'assistant.message.started',
      'assistant.message.completed',
      'state:idle',
    ]);
    expect(harness.controller.getStatus().sessionState).toBe('idle');
  });

  it('keeps the turn’s context available to the tool call dispatched before that report was applied', async () => {
    const harness = build();
    await harness.controller.openConversation({ chatId });

    const sent = await harness.controller.sendMessage({ chatId, prompt: 'go to the page' });
    if (!sent.ok) throw new Error('send was refused');

    expect(harness.probe.failure).toBeUndefined();
    expect(harness.probe.context).toMatchObject({ chatId, turnId: sent.turnId });
  });

  it('still ends the turn at its own terminal event, so the context is gone afterwards', async () => {
    const harness = build();
    await harness.controller.openConversation({ chatId });
    await harness.controller.sendMessage({ chatId, prompt: 'go to the page' });

    expect(() => harness.controller.currentToolContext()).toThrow(/no active chat\/turn/);
  });

  it('keeps collecting a turn’s failure signals across a chat-scoped event before `sending`', async () => {
    vi.useFakeTimers();
    const reflections: (readonly string[])[] = [];
    const harness = build({
      reflectionPrompt: (signals) => {
        reflections.push(signals);
        return 'REFLECT';
      },
    });
    await harness.controller.openConversation({ chatId });
    harness.service.setToolFailure(true);

    await harness.controller.sendMessage({ chatId, prompt: 'go to the page' });
    // The reflection is scheduled (not run) when the turn ends.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(reflections).toHaveLength(1);
    expect(reflections[0]?.join('\n')).toContain('The query was refused');
    expect(harness.prompts).toEqual(['go to the page', 'REFLECT']);
  });
});
