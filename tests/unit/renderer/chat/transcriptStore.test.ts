import { describe, expect, it } from 'vitest';
import {
  agentEventSchema,
  chatIdSchema,
  MEMO_REFLECTION_TOOL_NAME,
  messageIdSchema,
  reasoningIdSchema,
  requestIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type AgentEvent,
  type MessageId,
  type ReasoningId,
  type ToolCallId,
  type TurnId,
} from '../../../../src/shared';
import { addonPins } from '../../../../src/shared/addons/pins';
import { createTranscriptStore } from '../../../../src/renderer/src/chat/transcriptStore';
import {
  resetTableOnlySkills,
  setTableOnlySkills,
} from '../../../../src/renderer/src/chat/transcriptViewModel';

const chatId = chatIdSchema.parse('chat-1');
const turnId: TurnId = turnIdSchema.parse('turn-1');
const messageId: MessageId = messageIdSchema.parse('msg-1');
const toolCallId: ToolCallId = toolCallIdSchema.parse('call-1');
const reasoningId: ReasoningId = reasoningIdSchema.parse('reason-1');
const requestId = requestIdSchema.parse('req-1');

function messageStarted(sequence: number): AgentEvent {
  return agentEventSchema.parse({
    type: 'assistant.message.started',
    chatId,
    sequence,
    turnId,
    messageId,
  });
}

function delta(sequence: number, text: string): AgentEvent {
  return agentEventSchema.parse({
    type: 'assistant.text.delta',
    chatId,
    sequence,
    turnId,
    messageId,
    delta: text,
  });
}

function completed(sequence: number, content: string): AgentEvent {
  return agentEventSchema.parse({
    type: 'assistant.message.completed',
    chatId,
    sequence,
    turnId,
    messageId,
    content,
  });
}

function reasoningDelta(
  sequence: number,
  deltaText: string,
  id: ReasoningId = reasoningId,
): AgentEvent {
  return agentEventSchema.parse({
    type: 'assistant.reasoning.delta',
    chatId,
    sequence,
    turnId,
    reasoningId: id,
    delta: deltaText,
  });
}

function reasoningCompleted(
  sequence: number,
  content: string,
  id: ReasoningId = reasoningId,
): AgentEvent {
  return agentEventSchema.parse({
    type: 'assistant.reasoning.completed',
    chatId,
    sequence,
    turnId,
    reasoningId: id,
    content,
  });
}

function toolRequested(sequence: number, toolName = 'aem_get_json'): AgentEvent {
  return agentEventSchema.parse({
    type: 'tool.call.requested',
    chatId,
    sequence,
    toolCallId,
    toolName,
    arguments: { path: '/content' },
  });
}

function toolApproved(sequence: number): AgentEvent {
  return agentEventSchema.parse({ type: 'tool.call.approved', chatId, sequence, toolCallId });
}

function toolRejected(sequence: number, reason: string): AgentEvent {
  return agentEventSchema.parse({
    type: 'tool.call.rejected',
    chatId,
    sequence,
    toolCallId,
    reason,
  });
}

function toolResultSucceeded(sequence: number): AgentEvent {
  return agentEventSchema.parse({
    type: 'tool.result',
    chatId,
    sequence,
    toolCallId,
    outcome: { ok: true, data: { status: 200 } },
  });
}

function toolResultFailed(sequence: number): AgentEvent {
  return agentEventSchema.parse({
    type: 'tool.result',
    chatId,
    sequence,
    toolCallId,
    outcome: {
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: 'The requested page does not exist.',
        requestId,
        retryable: false,
        requiredAction: 'none',
      },
    },
  });
}

function toolProgress(sequence: number, text: string): AgentEvent {
  return agentEventSchema.parse({
    type: 'tool.call.progress',
    chatId,
    sequence,
    toolCallId,
    text,
  });
}

/**
 * A settled `format_table` call - the answer a table-only skill is supposed to
 * produce, and the only thing that hides that turn's prose (see
 * `markTableOnlyTurn`).
 */
function tableLanded(sequence: number): AgentEvent[] {
  return [toolRequested(sequence, 'format_table'), toolResultSucceeded(sequence + 1)];
}

const skillToolCallId: ToolCallId = toolCallIdSchema.parse('skill-call-1');

/** A `skill` tool call (the skill loader) for `skillName`. */
function skillRequested(sequence: number, skillName: string): AgentEvent {
  return agentEventSchema.parse({
    type: 'tool.call.requested',
    chatId,
    sequence,
    toolCallId: skillToolCallId,
    toolName: 'load_skill',
    arguments: { name: skillName },
  });
}

/** The settled result of {@link skillRequested}. */
function skillResult(sequence: number, data: Record<string, unknown>): AgentEvent {
  return agentEventSchema.parse({
    type: 'tool.result',
    chatId,
    sequence,
    toolCallId: skillToolCallId,
    outcome: { ok: true, data },
  });
}

/** A model-chosen load: the real executor names itself, with no user marker. */
function modelSkillResult(sequence: number, skillName: string): AgentEvent {
  return skillResult(sequence, {
    ok: true,
    operation: 'load_skill',
    skill: skillName,
    activatedBy: 'model',
    resultType: 'success',
  });
}

/** The controller's synthetic marker for a skill an explicit `/name` prompt loaded. */
function userSkillResult(sequence: number, skillName: string): AgentEvent {
  return skillResult(sequence, {
    ok: true,
    operation: 'load_skill',
    skill: skillName,
    activatedBy: 'user',
    resultType: 'success',
  });
}

describe('createTranscriptStore', () => {
  it('starts empty', () => {
    const store = createTranscriptStore();
    expect(store.items()).toEqual([]);
    expect(store.takeDirty()).toBe(false);
  });

  it('ignores the model diagnostics events and leaves the store clean', () => {
    const store = createTranscriptStore();
    store.applyEvent({
      type: 'model.changed',
      chatId,
      sequence: 0,
      model: 'gpt-x',
      cause: 'session-open',
    });
    store.applyEvent({ type: 'model.usage', chatId, sequence: 1, inputTokens: 3 });
    store.applyEvent({ type: 'model.call.failed', chatId, sequence: 2, statusCode: 500 });
    expect(store.items()).toEqual([]);
    expect(store.takeDirty()).toBe(false);
  });

  describe('assistant messages', () => {
    it("adds one 'message' item on the first event for a messageId, not again on later events for it", () => {
      const store = createTranscriptStore();
      store.applyEvent(messageStarted(0));
      store.applyEvent(delta(1, 'Hi'));
      store.applyEvent(completed(2, 'Hi there'));
      expect(store.items()).toEqual([{ kind: 'message', messageId, turnId }]);
    });

    it('delegates text to the underlying message stream (folds deltas, replaces on completion)', () => {
      const store = createTranscriptStore();
      store.applyEvent(delta(0, 'I checked '));
      store.applyEvent(delta(1, 'the page.'));
      expect(store.textForMessage(messageId)).toBe('I checked the page.');

      store.applyEvent(completed(2, 'I checked the page, done.'));
      expect(store.textForMessage(messageId)).toBe('I checked the page, done.');
    });

    it("keeps a table-only turn's prose until its table lands, then hides it", () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, '/search waldo');
      store.markTableOnlyTurn(turnId);
      store.applyEvent(messageStarted(0));
      store.applyEvent(delta(1, 'I searched...'));
      // Nothing is hidden yet: without a table, this prose *is* the turn's output.
      expect(store.items()).toEqual([
        { kind: 'userPrompt', turnId },
        { kind: 'message', messageId, turnId },
      ]);

      for (const event of tableLanded(2)) store.applyEvent(event);
      expect(store.items()).toEqual([
        { kind: 'userPrompt', turnId },
        { kind: 'toolCall', toolCallId },
      ]);
    });

    it("hides a report turn's prose - the report is the answer", () => {
      // The report tool the pins declare: its result paints the answer itself.
      const reportTool = Object.values(addonPins)
        .flatMap((pin) => pin.contributions.tools)
        .find((tool) => tool.presentation === 'report')?.name;
      // A build with no pinned report tool has no such turn to replay.
      if (reportTool === undefined) return;
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, '/search');
      store.markTableOnlyTurn(turnId);
      store.applyEvent(toolRequested(0, reportTool));
      store.applyEvent(toolApproved(1));
      store.applyEvent(toolResultSucceeded(2));
      store.applyEvent(messageStarted(3));
      store.applyEvent(completed(4, 'No response.'));

      // The report (presentation 'report') is the turn's answer, so
      // the model's own "No response." prose is not painted.
      expect(store.items()).toEqual([
        { kind: 'userPrompt', turnId },
        { kind: 'toolCall', toolCallId },
      ]);
    });

    it('keeps the only output of a table-only turn that produced no table', () => {
      // Measured 2026-10-26: the first `/name` of a session answered with
      // one prose message and called no tool. Hiding that prose left the reader
      // with a turn that showed nothing at all - the pane went from "Thinking"
      // straight back to an empty transcript, indistinguishable from a broken
      // skill or add-on.
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, '/search');
      store.markTableOnlyTurn(turnId);
      store.applyEvent(messageStarted(0));
      store.applyEvent(delta(1, 'Understood.'));
      store.applyEvent(completed(2, 'Understood.'));
      store.applyEvent(
        agentEventSchema.parse({
          type: 'session.state.changed',
          chatId,
          sequence: 3,
          turnId,
          state: 'idle',
        }),
      );

      expect(store.items()).toEqual([
        { kind: 'userPrompt', turnId },
        { kind: 'message', messageId, turnId },
      ]);
      expect(store.textForMessage(messageId)).toBe('Understood.');
    });

    it('keeps the prose when a table-only turn settles a billet tool but no table', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, '/search');
      store.markTableOnlyTurn(turnId);
      store.applyEvent(toolRequested(0, 'aem_get_json'));
      store.applyEvent(toolApproved(1));
      store.applyEvent(toolResultSucceeded(2));
      store.applyEvent(messageStarted(3));
      store.applyEvent(delta(4, 'That page has a title.'));

      // A billet's settle is not the answer: only the skill's own table is.
      expect(store.items().some((item) => item.kind === 'message')).toBe(true);
    });

    it('forgets the table-only expectation on clear()', () => {
      const store = createTranscriptStore();
      store.markTableOnlyTurn(turnId);
      store.clear();
      store.applyUserPrompt(turnId, '/search waldo');
      store.applyEvent(messageStarted(0));
      for (const event of tableLanded(1)) store.applyEvent(event);
      expect(store.items().some((item) => item.kind === 'message')).toBe(true);
    });
  });

  describe('skill loads', () => {
    it('shows a billet for a skill the model chose to load', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'find pages about Waldo');
      store.applyEvent(skillRequested(0, 'search'));
      store.applyEvent(modelSkillResult(1, 'search'));

      expect(store.items()).toEqual([
        { kind: 'userPrompt', turnId },
        { kind: 'toolCall', toolCallId: skillToolCallId },
      ]);
      expect(store.toolCallFor(skillToolCallId)).toMatchObject({
        toolName: 'load_skill',
        status: { kind: 'succeeded' },
      });
    });

    it('shows a failed skill load too, so an attempt is never invisible', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'find pages about Waldo');
      store.applyEvent(skillRequested(0, 'ghost'));
      store.applyEvent(
        agentEventSchema.parse({
          type: 'tool.result',
          chatId,
          sequence: 1,
          toolCallId: skillToolCallId,
          outcome: {
            ok: false,
            error: {
              code: 'NOT_FOUND',
              message: 'No such skill',
              retryable: false,
              requestId,
              requiredAction: 'none',
            },
          },
        }),
      );

      expect(store.items()).toContainEqual({ kind: 'toolCall', toolCallId: skillToolCallId });
      expect(store.toolCallFor(skillToolCallId)).toMatchObject({
        toolName: 'load_skill',
        status: { kind: 'failed' },
      });
    });

    it("keeps the controller's marker for an explicit /name prompt out of the transcript", () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, '/search Waldo');
      store.applyEvent(skillRequested(0, 'search'));
      store.applyEvent(userSkillResult(1, 'search'));

      expect(store.items()).toEqual([{ kind: 'userPrompt', turnId }]);
      expect(store.toolCallFor(skillToolCallId)).toBeUndefined();
    });

    it('shows a model-chosen load even when no prompt was recorded', () => {
      const store = createTranscriptStore();
      store.applyEvent(skillRequested(0, 'search'));
      store.applyEvent(modelSkillResult(1, 'search'));

      expect(store.items()).toEqual([{ kind: 'toolCall', toolCallId: skillToolCallId }]);
    });

    it('suppresses a search turn the model chose on its own, exactly like /search', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'find pages about Waldo');
      store.applyEvent(skillRequested(0, 'search'));
      store.applyEvent(modelSkillResult(1, 'search'));
      store.applyEvent(messageStarted(2));
      store.applyEvent(delta(3, 'I will search for that.'));
      store.applyEvent(completed(4, 'I will search for that.'));
      expect(store.items().some((item) => item.kind === 'message')).toBe(true);

      for (const event of tableLanded(5)) store.applyEvent(event);
      expect(store.items().some((item) => item.kind === 'message')).toBe(false);
      // The load stays visible; only the model's prose is suppressed.
      expect(store.items()).toEqual([
        { kind: 'userPrompt', turnId },
        { kind: 'toolCall', toolCallId: skillToolCallId },
        { kind: 'toolCall', toolCallId },
      ]);
    });

    it('removes prose that arrived before the table landed', () => {
      for (const skillName of ['semantic-search', 'search-component', 'search-page']) {
        const store = createTranscriptStore();
        store.applyUserPrompt(turnId, 'text about Waldo, ranked by meaning');
        store.applyEvent(messageStarted(0));
        store.applyEvent(completed(1, 'Let me think about that.'));
        expect(store.items().some((item) => item.kind === 'message')).toBe(true);

        store.applyEvent(skillRequested(2, skillName));
        store.applyEvent(modelSkillResult(3, skillName));
        for (const event of tableLanded(4)) store.applyEvent(event);

        expect(store.items()).toEqual([
          { kind: 'userPrompt', turnId },
          { kind: 'toolCall', toolCallId: skillToolCallId },
          { kind: 'toolCall', toolCallId },
        ]);
      }
    });

    it('suppresses the prose of a custom skill the skill list flags as table-only', () => {
      setTableOnlySkills([{ name: 'demo-table', tableOnly: true }]);
      try {
        const store = createTranscriptStore();
        store.applyUserPrompt(turnId, 'audit this page');
        store.applyEvent(skillRequested(0, 'demo-table'));
        store.applyEvent(modelSkillResult(1, 'demo-table'));
        store.applyEvent(messageStarted(2));
        store.applyEvent(delta(3, 'Running the audit.'));
        for (const event of tableLanded(4)) store.applyEvent(event);
        expect(store.items().some((item) => item.kind === 'message')).toBe(false);
      } finally {
        resetTableOnlySkills();
      }
    });

    it('keeps the turn prose around an auxiliary skill load', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'where do paths live?');
      store.applyEvent(skillRequested(0, 'daisy-conventions'));
      store.applyEvent(modelSkillResult(1, 'daisy-conventions'));
      store.applyEvent(messageStarted(2));
      store.applyEvent(delta(3, 'Under /content by default.'));
      expect(store.items()).toEqual([
        { kind: 'userPrompt', turnId },
        { kind: 'toolCall', toolCallId: skillToolCallId },
        { kind: 'message', messageId, turnId },
      ]);
      expect(store.toolCallFor(skillToolCallId)).toMatchObject({ toolName: 'load_skill' });
    });
  });

  describe('automatic reflection turns', () => {
    const reflectionTurnId: TurnId = turnIdSchema.parse('turn-reflection');
    const markerCallId: ToolCallId = toolCallIdSchema.parse('marker-call-1');

    function sending(sequence: number, id: TurnId): AgentEvent {
      return agentEventSchema.parse({
        type: 'session.state.changed',
        chatId,
        sequence,
        turnId: id,
        state: 'sending',
      });
    }

    function markerRequested(sequence: number): AgentEvent {
      return agentEventSchema.parse({
        type: 'tool.call.requested',
        chatId,
        sequence,
        toolCallId: markerCallId,
        toolName: MEMO_REFLECTION_TOOL_NAME,
        arguments: { signals: ['a tool failed'] },
      });
    }

    function reflectionMessage(sequence: number, text: string): AgentEvent[] {
      const id = messageIdSchema.parse('msg-reflection');
      return [
        agentEventSchema.parse({
          type: 'assistant.message.started',
          chatId,
          sequence,
          turnId: reflectionTurnId,
          messageId: id,
        }),
        agentEventSchema.parse({
          type: 'assistant.message.completed',
          chatId,
          sequence: sequence + 1,
          turnId: reflectionTurnId,
          messageId: id,
          content: text,
        }),
      ];
    }

    it("keeps the marker billet but hides the reflection turn's prose", () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'find pages about Waldo');
      store.applyEvent(messageStarted(0));
      store.applyEvent(completed(1, 'Here they are.'));
      store.applyEvent(sending(2, reflectionTurnId));
      store.applyEvent(markerRequested(3));
      for (const event of reflectionMessage(4, 'Nothing worth remembering.')) {
        store.applyEvent(event);
      }

      expect(store.items()).toEqual([
        { kind: 'userPrompt', turnId },
        { kind: 'message', messageId, turnId },
        { kind: 'toolCall', toolCallId: markerCallId },
      ]);
    });
  });

  describe('user prompts', () => {
    it('records a user prompt as its own item, once, with the exact text given', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'What is the weather?');
      store.applyUserPrompt(turnId, 'What is the weather? (edited)');
      expect(store.items()).toEqual([{ kind: 'userPrompt', turnId }]);
      expect(store.textForUserPrompt(turnId)).toBe('What is the weather? (edited)');
    });

    it('returns an empty string for a turnId no prompt was ever recorded for', () => {
      const store = createTranscriptStore();
      expect(store.textForUserPrompt(turnId)).toBe('');
    });
  });

  describe('tool call lifecycle', () => {
    it("appears as its own item from 'requested' alone, independent of any message text", () => {
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      expect(store.items()).toEqual([{ kind: 'toolCall', toolCallId }]);
      expect(store.toolCallFor(toolCallId)).toEqual({
        toolCallId,
        toolName: 'aem_get_json',
        args: { path: '/content' },
        status: { kind: 'requested' },
      });
    });

    it('moves through requested -> approved -> succeeded without adding a second item', () => {
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      store.applyEvent(toolApproved(1));
      store.applyEvent(toolResultSucceeded(2));
      expect(store.items()).toEqual([{ kind: 'toolCall', toolCallId }]);
      expect(store.toolCallFor(toolCallId)?.status).toEqual({
        kind: 'succeeded',
        data: { status: 200 },
      });
    });

    it('records a rejection with its reason', () => {
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      store.applyEvent(toolRejected(1, 'Refused by policy'));
      expect(store.toolCallFor(toolCallId)?.status).toEqual({
        kind: 'rejected',
        reason: 'Refused by policy',
      });
    });

    it("renders a failed outcome as status 'failed' carrying the error, not as a success", () => {
      // The mandatory anti-regression case: a failed tool.result must never
      // be recorded as a completed/successful tool call.
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      store.applyEvent(toolApproved(1));
      store.applyEvent(toolResultFailed(2));
      const view = store.toolCallFor(toolCallId);
      expect(view?.status.kind).toBe('failed');
      expect(view?.status).toEqual({
        kind: 'failed',
        error: {
          code: 'NOT_FOUND',
          message: 'The requested page does not exist.',
          requestId,
          retryable: false,
          requiredAction: 'none',
        },
      });
    });

    it('drops a status update for a toolCallId that was never requested, rather than fabricating an item', () => {
      const store = createTranscriptStore();
      store.applyEvent(toolApproved(0));
      expect(store.items()).toEqual([]);
      expect(store.toolCallFor(toolCallId)).toBeUndefined();
    });

    it('records a progress note on the running call and drops it once the call settles', () => {
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      store.applyEvent(toolApproved(1));
      store.applyEvent(toolProgress(2, 'Reading 12 of 20'));
      expect(store.toolCallFor(toolCallId)?.progress).toBe('Reading 12 of 20');

      store.applyEvent(toolResultSucceeded(3));
      // Progress is running-only: a settled call carries none.
      expect(store.toolCallFor(toolCallId)?.progress).toBeUndefined();
    });

    it('drops a progress note for a toolCallId that was never requested', () => {
      const store = createTranscriptStore();
      store.applyEvent(toolProgress(0, 'Reading 1 of 2'));
      expect(store.items()).toEqual([]);
      expect(store.toolCallFor(toolCallId)).toBeUndefined();
    });

    it('settles every running call as abandoned, dropping its running-only progress', () => {
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      store.applyEvent(toolApproved(1));
      store.applyEvent(toolProgress(2, 'Reading 1 of 2'));

      store.abandonRunningToolCalls();

      const view = store.toolCallFor(toolCallId);
      expect(view?.status).toEqual({ kind: 'abandoned' });
      expect(view?.progress).toBeUndefined();
      // The item stays: it is an honest, non-spinning "Interrupted" billet.
      expect(store.items()).toEqual([{ kind: 'toolCall', toolCallId }]);
    });

    it('settles running calls with no status word when the turn was waiting on the user', () => {
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      store.applyEvent(toolApproved(1));

      store.abandonRunningToolCalls(true);

      // A turn paused on a question was not interrupted: the call settles as
      // `abandonedAwaitingInput`, which paints no status word (see
      // `describeToolCallStatus`).
      expect(store.toolCallFor(toolCallId)?.status).toEqual({ kind: 'abandonedAwaitingInput' });
      expect(store.items()).toEqual([{ kind: 'toolCall', toolCallId }]);
    });

    it('leaves a settled call untouched when nothing is running', () => {
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      store.applyEvent(toolResultSucceeded(1));
      store.takeDirty();

      store.abandonRunningToolCalls();

      expect(store.toolCallFor(toolCallId)?.status.kind).toBe('succeeded');
      expect(store.takeDirty()).toBe(false);
    });

    it('settles a pending total flag on a format_table call', () => {
      const store = createTranscriptStore();
      store.applyEvent(
        agentEventSchema.parse({
          type: 'tool.call.requested',
          chatId,
          sequence: 0,
          toolCallId,
          toolName: 'format_table',
          arguments: { data: { rows: [] }, mode: 'new', totalPending: true },
        }),
      );
      store.takeDirty();

      store.settlePendingTotals();

      expect(store.toolCallFor(toolCallId)?.args['totalPending']).toBe(false);
      expect(store.takeDirty()).toBe(true);
    });

    it('settles a call the turn left running as interrupted when it leaves the in-flight state', () => {
      // A turn can end without a result for its running call (an agent error, a
      // result lost on the way). Nothing is running any more, so the billet must
      // not keep a spinner that can never stop.
      const store = createTranscriptStore();
      store.setTurnInFlight(true);
      store.applyEvent(toolRequested(0));
      store.applyEvent(toolApproved(1));
      store.applyEvent(toolProgress(2, 'Reading 1 of 2'));

      store.setTurnInFlight(false);

      const view = store.toolCallFor(toolCallId);
      expect(view?.status).toEqual({ kind: 'abandoned' });
      expect(view?.progress).toBeUndefined();
    });

    it('lets a result that arrives after the interruption settle the call truthfully', () => {
      const store = createTranscriptStore();
      store.setTurnInFlight(true);
      store.applyEvent(toolRequested(0));
      store.addInterruption('stopped');

      // The executor had already finished when the abort landed: the real
      // outcome wins over the interruption's placeholder, so the billet never
      // claims a completed call was interrupted.
      store.applyEvent(toolResultSucceeded(1));

      expect(store.toolCallFor(toolCallId)?.status).toEqual({
        kind: 'succeeded',
        data: { status: 200 },
      });
    });

    it('settlePendingTotals is a no-op when no call is counting', () => {
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      store.takeDirty();

      store.settlePendingTotals();

      expect(store.toolCallFor(toolCallId)?.args).toEqual({ path: '/content' });
      expect(store.takeDirty()).toBe(false);
    });
  });

  describe('events with no transcript item of their own', () => {
    it("ignores 'error' and 'session.state.changed' without adding an item or throwing", () => {
      const store = createTranscriptStore();
      store.applyEvent(
        agentEventSchema.parse({
          type: 'error',
          chatId,
          sequence: 0,
          error: {
            code: 'AGENT_UNAVAILABLE',
            message: 'Copilot is unavailable.',
            requestId,
            retryable: true,
            requiredAction: 'sign_in_to_agent',
          },
        }),
      );
      store.applyEvent(
        agentEventSchema.parse({
          type: 'session.state.changed',
          chatId,
          sequence: 1,
          state: 'idle',
        }),
      );
      expect(store.items()).toEqual([]);
    });
  });

  describe('thinking indicator', () => {
    it('adds a trailing thinking item while a turn is in flight and no text has arrived', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.setTurnInFlight(true);
      expect(store.items()).toEqual([{ kind: 'userPrompt', turnId }, { kind: 'thinking' }]);
    });

    it('does not show thinking while no turn is in flight', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      expect(store.items()).toEqual([{ kind: 'userPrompt', turnId }]);
    });

    it('drops the thinking item as soon as the first assistant text arrives, while the turn is still in flight', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.setTurnInFlight(true);
      store.takeDirty();

      store.applyEvent(delta(0, 'Here'));

      expect(store.items()).toEqual([
        { kind: 'userPrompt', turnId },
        { kind: 'message', messageId, turnId },
      ]);
      expect(store.takeDirty()).toBe(true);
    });

    it('hides thinking while the turn waits on a question, and restores it once answered', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.setTurnInFlight(true);
      store.takeDirty();

      store.setAwaitingUserInput(true);
      expect(store.items()).toEqual([{ kind: 'userPrompt', turnId }]);
      expect(store.takeDirty()).toBe(true);

      store.setAwaitingUserInput(false);
      expect(store.items()).toEqual([{ kind: 'userPrompt', turnId }, { kind: 'thinking' }]);
      expect(store.takeDirty()).toBe(true);
    });

    it('hides thinking while a tool call runs, and restores it when the call settles', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.setTurnInFlight(true);
      store.applyEvent(toolRequested(0));

      // A running tool call supersedes the Thinking billet.
      expect(store.items()).toEqual([
        { kind: 'userPrompt', turnId },
        { kind: 'toolCall', toolCallId },
      ]);

      store.applyEvent(toolResultSucceeded(1));
      // No text has arrived, so Thinking comes back now that nothing is running.
      expect(store.items()).toContainEqual({ kind: 'thinking' });
    });

    it('shows thinking for a new turn even after a previous call was abandoned mid-flight', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'first');
      store.setTurnInFlight(true);
      // A call that never settles (the turn is stopped while it is running).
      store.applyEvent(toolRequested(0));
      store.setTurnInFlight(false);

      const secondTurn: TurnId = turnIdSchema.parse('turn-2');
      store.applyUserPrompt(secondTurn, 'second');
      store.setTurnInFlight(true);

      // The abandoned call no longer counts as running, so it cannot keep
      // Thinking hidden in the next turn.
      expect(store.items()).toContainEqual({ kind: 'thinking' });
    });

    it('does not mark the store dirty when the awaiting-input flag is unchanged', () => {
      const store = createTranscriptStore();
      store.setAwaitingUserInput(true);
      store.takeDirty();
      store.setAwaitingUserInput(true);
      expect(store.takeDirty()).toBe(false);
    });

    it('forgets a pending question when the transcript is cleared', () => {
      const store = createTranscriptStore();
      store.setAwaitingUserInput(true);
      store.clear();
      store.applyUserPrompt(turnId, 'hi');
      store.setTurnInFlight(true);
      expect(store.items()).toEqual([{ kind: 'userPrompt', turnId }, { kind: 'thinking' }]);
    });

    it('drops the thinking item when the turn leaves the in-flight state', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.setTurnInFlight(true);
      store.setTurnInFlight(false);
      expect(store.items()).toEqual([{ kind: 'userPrompt', turnId }]);
    });

    it('shows thinking again for a new turn even after the previous turn produced text', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'first');
      store.setTurnInFlight(true);
      store.applyEvent(delta(0, 'answer'));
      store.setTurnInFlight(false);

      const secondTurn: TurnId = turnIdSchema.parse('turn-2');
      store.applyUserPrompt(secondTurn, 'second');
      store.setTurnInFlight(true);

      expect(store.items()).toEqual([
        { kind: 'userPrompt', turnId },
        { kind: 'message', messageId, turnId },
        { kind: 'userPrompt', turnId: secondTurn },
        { kind: 'thinking' },
      ]);
    });

    it('ignores a late text event belonging to a previous turn when deciding the current turn has text', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'first');
      const secondTurn: TurnId = turnIdSchema.parse('turn-2');
      store.applyUserPrompt(secondTurn, 'second');
      store.setTurnInFlight(true);

      // `delta` carries `turnId` (the first turn), not `secondTurn`.
      store.applyEvent(delta(0, 'late previous text'));

      expect(store.items()).toContainEqual({ kind: 'thinking' });
    });
  });

  describe('reasoning (transient thinking)', () => {
    it('exposes the accumulated reasoning text while a block streams', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.setTurnInFlight(true);
      store.takeDirty();

      store.applyEvent(reasoningDelta(0, 'first '));
      store.applyEvent(reasoningDelta(1, 'second'));

      expect(store.thinkingReasoning()).toBe('first second');
      expect(store.takeDirty()).toBe(true);
    });

    it('keeps the thinking item visible for a later reasoning block even after text has arrived', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.setTurnInFlight(true);
      store.applyEvent(delta(0, 'some answer'));
      expect(store.items()).not.toContainEqual({ kind: 'thinking' });

      store.applyEvent(reasoningDelta(1, 'reflecting'));

      expect(store.items()).toContainEqual({ kind: 'thinking' });
      expect(store.thinkingReasoning()).toBe('reflecting');
    });

    it('replaces the text when a delta belongs to a different reasoning block', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.setTurnInFlight(true);
      store.applyEvent(reasoningDelta(0, 'block one'));

      const secondReasoningId: ReasoningId = reasoningIdSchema.parse('reason-2');
      store.applyEvent(reasoningDelta(1, 'block two', secondReasoningId));

      expect(store.thinkingReasoning()).toBe('block two');
    });

    it('discards the reasoning text when the block completes', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.setTurnInFlight(true);
      store.applyEvent(reasoningDelta(0, 'thinking'));

      store.applyEvent(reasoningCompleted(1, 'thinking'));

      expect(store.thinkingReasoning()).toBe('');
      // Still in flight with no text: the plain thinking item remains.
      expect(store.items()).toContainEqual({ kind: 'thinking' });
    });

    it('discards the reasoning text when assistant text starts', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.setTurnInFlight(true);
      store.applyEvent(reasoningDelta(0, 'thinking'));

      store.applyEvent(delta(1, 'answer'));

      expect(store.thinkingReasoning()).toBe('');
      expect(store.items()).not.toContainEqual({ kind: 'thinking' });
    });

    it('discards the reasoning text when a tool call is requested', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.setTurnInFlight(true);
      store.applyEvent(reasoningDelta(0, 'thinking'));

      store.applyEvent(toolRequested(1));

      expect(store.thinkingReasoning()).toBe('');
    });

    it('returns no reasoning once the turn leaves the in-flight state', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.setTurnInFlight(true);
      store.applyEvent(reasoningDelta(0, 'thinking'));

      store.setTurnInFlight(false);

      expect(store.thinkingReasoning()).toBe('');
    });

    it('ignores a completed event for a reasoning block that is not the active one', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.setTurnInFlight(true);
      store.applyEvent(reasoningDelta(0, 'active block'));

      const otherReasoningId: ReasoningId = reasoningIdSchema.parse('reason-other');
      store.applyEvent(reasoningCompleted(1, 'other block', otherReasoningId));

      expect(store.thinkingReasoning()).toBe('active block');
    });

    it('drops reasoning on clear()', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.setTurnInFlight(true);
      store.applyEvent(reasoningDelta(0, 'thinking'));

      store.clear();

      expect(store.thinkingReasoning()).toBe('');
      expect(store.items()).toEqual([]);
    });
  });

  describe('ordering', () => {
    it('preserves first-seen order across mixed item kinds', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hello');
      store.applyEvent(toolRequested(0));
      store.applyEvent(messageStarted(1));
      expect(store.items()).toEqual([
        { kind: 'userPrompt', turnId },
        { kind: 'toolCall', toolCallId },
        { kind: 'message', messageId, turnId },
      ]);
    });
  });

  describe('takeDirty', () => {
    it('starts not dirty', () => {
      expect(createTranscriptStore().takeDirty()).toBe(false);
    });

    it('is dirty after a new item is added, then clears on read', () => {
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      expect(store.takeDirty()).toBe(true);
      expect(store.takeDirty()).toBe(false);
    });

    it('is dirty after applyUserPrompt', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      expect(store.takeDirty()).toBe(true);
    });

    it("is dirty for a message-text-only change even when nothing of this store's own bookkeeping changed", () => {
      const store = createTranscriptStore();
      store.applyEvent(delta(0, 'hi'));
      store.takeDirty();

      store.applyEvent(delta(1, ' there'));
      expect(store.takeDirty()).toBe(true);
    });
  });

  describe('clear', () => {
    it('drops every item, prompt, tool call, and the thinking indicator', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.applyEvent(toolRequested(0));
      store.applyEvent(messageStarted(1));
      store.applyEvent(delta(2, 'answer'));
      store.setTurnInFlight(true);
      store.takeDirty();
      expect(store.textForMessage(messageId)).toBe('answer');

      store.clear();

      expect(store.items()).toEqual([]);
      expect(store.textForUserPrompt(turnId)).toBe('');
      expect(store.toolCallFor(toolCallId)).toBeUndefined();
      expect(store.textForMessage(messageId)).toBe('');
      // A cleared transcript is a change worth repainting.
      expect(store.takeDirty()).toBe(true);
    });

    it('does not mark dirty when there was nothing to clear', () => {
      const store = createTranscriptStore();
      store.clear();
      expect(store.takeDirty()).toBe(false);
    });
  });

  describe('interruption notices', () => {
    it('appends a durable notice carrying the reason, and marks the store dirty', () => {
      const store = createTranscriptStore();
      store.addInterruption('stopped');
      expect(store.items()).toEqual([
        {
          kind: 'interruption',
          interruptionId: 'interruption-1',
          reason: 'stopped',
          resumable: true,
        },
      ]);
      expect(store.takeDirty()).toBe(true);
    });

    it('records a non-resumable notice when replayed as history', () => {
      const store = createTranscriptStore();
      store.addInterruption('stopped', false);
      expect(store.items()).toEqual([
        {
          kind: 'interruption',
          interruptionId: 'interruption-1',
          reason: 'stopped',
          resumable: false,
        },
      ]);
    });

    it('gives each notice a distinct id, so two notices never share a cache key', () => {
      const store = createTranscriptStore();
      store.addInterruption('stopped');
      store.addInterruption('navigation');
      const ids = store
        .items()
        .filter((item) => item.kind === 'interruption')
        .map((item) => item.interruptionId);
      expect(new Set(ids).size).toBe(2);
    });

    it('keeps notices in first-seen order alongside the rest of the transcript', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hi');
      store.addInterruption('navigation');
      store.applyEvent(delta(0, 'answer'));
      expect(store.items().map((item) => item.kind)).toEqual([
        'userPrompt',
        'interruption',
        'message',
      ]);
    });

    it('settles a call that was still running as interrupted, so no spinner outlives its turn', () => {
      // The defect this guards: the pane's interruption notice used to only drop
      // the store's "is anything running?" index, leaving the billet itself in a
      // running state - so an interrupted call kept spinning, and a journal
      // replay (which replays the interruption record before settling) never
      // settled it either.
      const store = createTranscriptStore();
      store.applyEvent(toolRequested(0));
      store.applyEvent(toolApproved(1));
      store.applyEvent(toolProgress(2, 'Reading 1 of 2'));

      store.addInterruption('navigation');

      const view = store.toolCallFor(toolCallId);
      expect(view?.status).toEqual({ kind: 'abandoned' });
      expect(view?.progress).toBeUndefined();
    });

    it('settles a counting table when the turn is interrupted, so its total stops spinning', () => {
      const store = createTranscriptStore();
      store.applyEvent(
        agentEventSchema.parse({
          type: 'tool.call.requested',
          chatId,
          sequence: 0,
          toolCallId,
          toolName: 'format_table',
          arguments: { data: { rows: [] }, mode: 'new', totalPending: true },
        }),
      );

      store.addInterruption('navigation');

      const view = store.toolCallFor(toolCallId);
      expect(view?.args['totalPending']).toBe(false);
      expect(view?.status).toEqual({ kind: 'abandoned' });
    });

    it('drops notices on clear()', () => {
      const store = createTranscriptStore();
      store.addInterruption('stopped');
      store.clear();
      expect(store.items()).toEqual([]);
    });
  });
});
