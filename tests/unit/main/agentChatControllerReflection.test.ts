import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentChatControllerDeps,
  createAgentChatController,
} from '../../../src/main/agentChatController';
import {
  type FakeAgentService,
  type ScriptedStep,
  createFakeAgentService,
} from '../../../src/main/agents/fakeAgentService';
import {
  type AgentEvent,
  type ChatId,
  type SendPromptRequest,
  type ServerId,
  MEMO_REFLECTION_TOOL_NAME,
  MEMO_TOOL_NAME,
} from '../../../src/shared';
import { flushMicrotasks, settle } from '../../support/asyncWaits';
import { makeRecordingLogger } from '../../support/ipcHandlerHarness';
import { createRecordingJournal } from '../../support/recordingJournal';

/**
 * The application's post-turn reflection: a user turn that ends `idle` with
 * problems is followed by one turn of the application's own, whose prompt the
 * reflection template renders over the observed problems.
 */

const REFLECTION_PROMPT = 'REFLECT';

function counterIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${String(n++)}`;
}

const chatId = 'chat-1' as ChatId;

const failingCall: ScriptedStep = {
  kind: 'toolCall',
  call: {
    toolName: 'aem_get_json',
    arguments: { path: '/content/missing' },
    decision: {
      kind: 'approved',
      outcome: { ok: false, code: 'NOT_FOUND', message: 'Nothing at /content/missing' },
    },
  },
};

const memoCall: ScriptedStep = {
  kind: 'toolCall',
  call: {
    toolName: MEMO_TOOL_NAME,
    arguments: { text: 'lesson' },
    decision: { kind: 'approved', outcome: { ok: true, data: { ok: true } } },
  },
};

interface Harness {
  readonly fake: FakeAgentService;
  readonly controller: ReturnType<typeof createAgentChatController>;
  readonly prompts: string[];
  readonly signalsSeen: (readonly string[])[];
  readonly forwarded: AgentEvent[];
  readonly journal: ReturnType<typeof createRecordingJournal>;
  readonly logger: ReturnType<typeof makeRecordingLogger>;
}

function build(overrides: Partial<AgentChatControllerDeps> = {}): Harness {
  const fake = createFakeAgentService({ idGenerator: counterIds('fake') });
  const prompts: string[] = [];
  const signalsSeen: (readonly string[])[] = [];
  const forwarded: AgentEvent[] = [];
  const journal = createRecordingJournal();
  const logger = makeRecordingLogger();
  const sendPrompt = fake.sendPrompt.bind(fake);
  fake.sendPrompt = (request: SendPromptRequest) => {
    prompts.push(request.prompt);
    return sendPrompt(request);
  };
  const controller = createAgentChatController({
    agentService: fake,
    logger,
    idGenerator: counterIds('turn'),
    currentHostContext: () => ({
      origin: 'https://author.example.com',
      serverId: 'server-a' as ServerId,
      serverRevision: 1,
    }),
    navigationEpoch: () => 0,
    currentPageContext: () => undefined,
    chatJournal: journal.journal,
    reflectionPrompt: (signals) => {
      signalsSeen.push(signals);
      return REFLECTION_PROMPT;
    },
    ...overrides,
  });
  controller.onEvent((event) => forwarded.push(event));
  return { fake, controller, prompts, signalsSeen, forwarded, journal, logger };
}

/** Sends a user prompt with `steps` scripted as its reply, runs the turn to its end, and lets a reflection start. */
async function runUserTurn(harness: Harness, steps: readonly ScriptedStep[]): Promise<void> {
  harness.fake.scriptNextResponse({ steps });
  const sent = await harness.controller.sendMessage({ chatId, prompt: 'user prompt' });
  if (!sent.ok) throw new Error('send was refused');
  harness.fake.flush();
  await settle(0);
  await flushMicrotasks();
}

function markerEvents(harness: Harness): AgentEvent[] {
  return harness.forwarded.filter(
    (event) =>
      (event.type === 'tool.call.requested' && event.toolName === MEMO_REFLECTION_TOOL_NAME) ||
      (event.type === 'tool.result' &&
        harness.forwarded.some(
          (other) =>
            other.type === 'tool.call.requested' &&
            other.toolName === MEMO_REFLECTION_TOOL_NAME &&
            other.toolCallId === event.toolCallId,
        )),
  );
}

describe('post-turn reflection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('follows a turn whose tool failed with a reflection over the failure, journaled as the application’s own prompt', async () => {
    const harness = build();
    await harness.controller.openConversation({ chatId });

    await runUserTurn(harness, [failingCall]);

    expect(harness.prompts).toEqual(['user prompt', REFLECTION_PROMPT]);
    expect(harness.signalsSeen).toHaveLength(1);
    expect(harness.signalsSeen[0]?.join('\n')).toContain('Nothing at /content/missing');
    const reflectionPrompt = harness.journal.calls.filter(
      (call) => call.method === 'recordUserPrompt',
    )[1];
    expect(reflectionPrompt?.args).toMatchObject({
      prompt: REFLECTION_PROMPT,
      origin: 'reflection',
    });
  });

  it('shows the reflection as a marker call that starts with its turn and settles before it ends', async () => {
    const harness = build();
    await harness.controller.openConversation({ chatId });
    await runUserTurn(harness, [failingCall]);

    expect(markerEvents(harness).map((event) => event.type)).toEqual(['tool.call.requested']);
    harness.fake.flush();

    const marker = markerEvents(harness);
    expect(marker.map((event) => event.type)).toEqual(['tool.call.requested', 'tool.result']);
    const settledAt = harness.forwarded.indexOf(marker[1] as AgentEvent);
    const idleAt = harness.forwarded.findLastIndex(
      (event) => event.type === 'session.state.changed' && event.state === 'idle',
    );
    expect(settledAt).toBeLessThan(idleAt);
    expect(harness.controller.getStatus().sessionState).toBe('idle');
  });

  it('does not reflect on a turn without problems', async () => {
    const harness = build();
    await harness.controller.openConversation({ chatId });

    await runUserTurn(harness, [{ kind: 'delta', text: 'all good' }]);

    expect(harness.prompts).toEqual(['user prompt']);
  });

  it('does not reflect on a turn that already wrote a memo', async () => {
    const harness = build();
    await harness.controller.openConversation({ chatId });

    await runUserTurn(harness, [failingCall, memoCall]);

    expect(harness.prompts).toEqual(['user prompt']);
  });

  it('does not reflect on a turn the user stopped', async () => {
    const harness = build();
    await harness.controller.openConversation({ chatId });
    harness.fake.scriptNextResponse({ steps: [failingCall, { kind: 'delta', text: 'more' }] });
    await harness.controller.sendMessage({ chatId, prompt: 'user prompt' });
    for (let step = 0; step < 5; step += 1) harness.fake.advance();

    await harness.controller.abort({ chatId });
    await settle(0);

    expect(harness.prompts).toEqual(['user prompt']);
  });

  it('does not reflect while self-learning is off', async () => {
    const harness = build({ reflectionPrompt: () => undefined });
    await harness.controller.openConversation({ chatId });

    await runUserTurn(harness, [failingCall]);

    expect(harness.prompts).toEqual(['user prompt']);
  });

  it('never reflects on its own reflection', async () => {
    const harness = build();
    await harness.controller.openConversation({ chatId });
    await runUserTurn(harness, [failingCall]);

    harness.fake.scriptNextResponse({ steps: [failingCall] });
    harness.fake.flush();
    await settle(0);

    expect(harness.prompts).toEqual(['user prompt', REFLECTION_PROMPT]);
  });

  it('reflects when a dismissed question is asked again', async () => {
    const harness = build();
    await harness.controller.openConversation({ chatId });
    harness.fake.scriptNextResponse({
      steps: [
        { kind: 'inputRequest', question: 'Which one?', options: ['A', 'B'] },
        { kind: 'inputRequest', question: 'Which one?', options: ['A', 'B'] },
      ],
    });
    await harness.controller.sendMessage({ chatId, prompt: 'user prompt' });
    harness.fake.flush();
    const first = harness.forwarded.find((event) => event.type === 'user.input.requested');
    if (first?.type !== 'user.input.requested') throw new Error('no question asked');
    await harness.controller.respondToInput({
      chatId,
      requestId: first.requestId,
      answer: { selections: [], freeform: null },
    });
    harness.fake.flush();
    const second = harness.forwarded.filter((event) => event.type === 'user.input.requested')[1];
    if (second?.type !== 'user.input.requested') throw new Error('no second question asked');
    await harness.controller.respondToInput({
      chatId,
      requestId: second.requestId,
      answer: { selections: ['A'], freeform: null },
    });
    harness.fake.flush();
    await settle(0);

    expect(harness.prompts).toEqual(['user prompt', REFLECTION_PROMPT]);
  });

  it('stops the reflection quietly when the user sends a prompt during it', async () => {
    const harness = build();
    await harness.controller.openConversation({ chatId });
    await runUserTurn(harness, [failingCall]);

    const sent = await harness.controller.sendMessage({ chatId, prompt: 'next prompt' });

    expect(sent.ok).toBe(true);
    expect(harness.prompts).toEqual(['user prompt', REFLECTION_PROMPT, 'next prompt']);
    expect(harness.journal.calls.some((call) => call.method === 'recordInterruption')).toBe(false);
    expect(markerEvents(harness).map((event) => event.type)).toEqual([
      'tool.call.requested',
      'tool.result',
    ]);
  });

  it('records no interruption when the user stops a reflection', async () => {
    const harness = build();
    await harness.controller.openConversation({ chatId });
    await runUserTurn(harness, [failingCall]);

    await harness.controller.abort({ chatId });

    expect(harness.journal.calls.some((call) => call.method === 'recordInterruption')).toBe(false);
    expect(harness.controller.getStatus().sessionState).toBe('idle');
  });

  it('leaves a reflection running when the page changes', async () => {
    const harness = build();
    await harness.controller.openConversation({ chatId });
    await runUserTurn(harness, [failingCall]);

    await harness.controller.handleHostContextInvalidated();

    expect(harness.controller.getStatus().sessionState).not.toBe('idle');
  });

  it('logs a reflection the service refused, and leaves the chat ready', async () => {
    const harness = build();
    await harness.controller.openConversation({ chatId });
    const sendPrompt = harness.fake.sendPrompt.bind(harness.fake);
    let calls = 0;
    harness.fake.sendPrompt = (request) => {
      calls += 1;
      if (calls === 2) {
        return Promise.resolve({
          ok: false,
          error: { code: 'AGENT_UNAVAILABLE', message: 'unavailable' },
        });
      }
      return sendPrompt(request);
    };

    await runUserTurn(harness, [failingCall]);

    expect(harness.logger.warn).toHaveBeenCalledWith('MEMO_REFLECTION_FAILED', expect.anything());
    expect(
      harness.journal.calls.filter((call) => call.method === 'discardUserPrompt'),
    ).toHaveLength(1);
    const sent = await harness.controller.sendMessage({ chatId, prompt: 'next prompt' });
    expect(sent.ok).toBe(true);
  });
});
