import { describe, expect, it } from 'vitest';
import {
  agentEventSchema,
  chatIdSchema,
  messageIdSchema,
  requestIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type AgentEvent,
  type MessageId,
  type ToolCallId,
  type TurnId,
} from '../../../../src/shared';
import { createTranscriptStore } from '../../../../src/renderer/src/chat/transcriptStore';

const chatId = chatIdSchema.parse('chat-1');
const turnId: TurnId = turnIdSchema.parse('turn-1');
const messageId: MessageId = messageIdSchema.parse('msg-1');
const toolCallId: ToolCallId = toolCallIdSchema.parse('call-1');
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

describe('createTranscriptStore', () => {
  it('starts empty', () => {
    const store = createTranscriptStore();
    expect(store.items()).toEqual([]);
    expect(store.takeDirty()).toBe(false);
  });

  describe('assistant messages', () => {
    it("adds one 'message' item on the first event for a messageId, not again on later events for it", () => {
      const store = createTranscriptStore();
      store.applyEvent(messageStarted(0));
      store.applyEvent(delta(1, 'Hi'));
      store.applyEvent(completed(2, 'Hi there'));
      expect(store.items()).toEqual([{ kind: 'message', messageId }]);
    });

    it('delegates text to the underlying message stream (folds deltas, replaces on completion)', () => {
      const store = createTranscriptStore();
      store.applyEvent(delta(0, 'I checked '));
      store.applyEvent(delta(1, 'the page.'));
      expect(store.textForMessage(messageId)).toBe('I checked the page.');

      store.applyEvent(completed(2, 'I checked the page, done.'));
      expect(store.textForMessage(messageId)).toBe('I checked the page, done.');
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
            code: 'COPILOT_UNAVAILABLE',
            message: 'Copilot is unavailable.',
            requestId,
            retryable: true,
            requiredAction: 'sign_in_to_copilot',
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

  describe('ordering', () => {
    it('preserves first-seen order across mixed item kinds', () => {
      const store = createTranscriptStore();
      store.applyUserPrompt(turnId, 'hello');
      store.applyEvent(toolRequested(0));
      store.applyEvent(messageStarted(1));
      expect(store.items()).toEqual([
        { kind: 'userPrompt', turnId },
        { kind: 'toolCall', toolCallId },
        { kind: 'message', messageId },
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
});
