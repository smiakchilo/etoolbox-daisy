import { describe, expect, it } from 'vitest';
import {
  agentEventSchema,
  chatIdSchema,
  messageIdSchema,
  turnIdSchema,
  type AgentEvent,
  type MessageId,
} from '../../../../src/shared';
import { createMessageStream } from '../../../../src/renderer/src/chat/messageStream';

const chatId = chatIdSchema.parse('chat-1');
const turnId = turnIdSchema.parse('turn-1');
const messageId: MessageId = messageIdSchema.parse('msg-1');
const otherMessageId: MessageId = messageIdSchema.parse('msg-2');

/** Builds a validated `assistant.text.delta` event, mirroring the shared contract test's pattern. */
function delta(sequence: number, text: string, forMessageId: MessageId = messageId): AgentEvent {
  return agentEventSchema.parse({
    type: 'assistant.text.delta',
    chatId,
    sequence,
    turnId,
    messageId: forMessageId,
    delta: text,
  });
}

/** Builds a validated `assistant.message.completed` event. */
function completed(
  sequence: number,
  content: string,
  forMessageId: MessageId = messageId,
): AgentEvent {
  return agentEventSchema.parse({
    type: 'assistant.message.completed',
    chatId,
    sequence,
    turnId,
    messageId: forMessageId,
    content,
  });
}

/** Builds a validated `assistant.message.started` event - one this module deliberately ignores. */
function started(sequence: number, forMessageId: MessageId = messageId): AgentEvent {
  return agentEventSchema.parse({
    type: 'assistant.message.started',
    chatId,
    sequence,
    turnId,
    messageId: forMessageId,
  });
}

/** Builds a validated `tool.call.requested` event - unrelated to any message's text. */
function toolCallRequested(sequence: number): AgentEvent {
  return agentEventSchema.parse({
    type: 'tool.call.requested',
    chatId,
    sequence,
    toolCallId: 'call-1',
    toolName: 'aem_get_json',
    arguments: {},
  });
}

describe('createMessageStream', () => {
  describe('unseen messages', () => {
    it('returns an empty string for a messageId no event has been applied for', () => {
      const stream = createMessageStream();
      expect(stream.textFor(messageId)).toBe('');
    });
  });

  describe('delta folding (delegated to the shared contract layer)', () => {
    it('concatenates in-order deltas', () => {
      const stream = createMessageStream();
      stream.applyEvent(delta(0, 'Hello'));
      stream.applyEvent(delta(1, ', '));
      stream.applyEvent(delta(2, 'world'));
      expect(stream.textFor(messageId)).toBe('Hello, world');
    });

    it('reassembles out-of-order delta sequences in sequence order, not arrival order', () => {
      const stream = createMessageStream();
      stream.applyEvent(delta(2, 'world'));
      stream.applyEvent(delta(0, 'Hello'));
      stream.applyEvent(delta(1, ', '));
      expect(stream.textFor(messageId)).toBe('Hello, world');
    });

    it('tracks independent messages independently', () => {
      const stream = createMessageStream();
      stream.applyEvent(delta(0, 'for msg 1', messageId));
      stream.applyEvent(delta(0, 'for msg 2', otherMessageId));
      expect(stream.textFor(messageId)).toBe('for msg 1');
      expect(stream.textFor(otherMessageId)).toBe('for msg 2');
    });
  });

  describe('completion is a replace, not an append (anti-duplication)', () => {
    it('does not duplicate text when deltas are followed by a completed event repeating the same content', () => {
      const stream = createMessageStream();
      stream.applyEvent(delta(0, 'I checked '));
      stream.applyEvent(delta(1, 'the page.'));
      stream.applyEvent(completed(2, 'I checked the page.'));
      expect(stream.textFor(messageId)).toBe('I checked the page.');
    });

    it("uses the completed event's content verbatim even when it differs from the folded deltas", () => {
      const stream = createMessageStream();
      stream.applyEvent(delta(0, 'draft'));
      stream.applyEvent(completed(1, 'final, corrected text'));
      expect(stream.textFor(messageId)).toBe('final, corrected text');
    });

    it('keeps the completed content even for a message that received no deltas at all', () => {
      const stream = createMessageStream();
      stream.applyEvent(completed(0, 'a message that arrived whole'));
      expect(stream.textFor(messageId)).toBe('a message that arrived whole');
    });
  });

  describe('deltas after completion are ignored', () => {
    it("ignores a late delta arriving after the message's completed event", () => {
      const stream = createMessageStream();
      stream.applyEvent(delta(0, 'Hello'));
      stream.applyEvent(completed(1, 'Hello'));
      stream.applyEvent(delta(2, ' world')); // late, must be ignored
      expect(stream.textFor(messageId)).toBe('Hello');
    });

    it('does not mark the stream dirty for an ignored late delta', () => {
      const stream = createMessageStream();
      stream.applyEvent(delta(0, 'Hello'));
      stream.applyEvent(completed(1, 'Hello'));
      stream.takeDirty(); // clear whatever dirt the setup above produced

      stream.applyEvent(delta(2, ' world'));
      expect(stream.takeDirty()).toBe(false);
    });

    it("does not let a late delta for one message affect a completed message's text, even while another message is still streaming", () => {
      const stream = createMessageStream();
      stream.applyEvent(completed(0, 'done'));
      stream.applyEvent(delta(0, 'still going', otherMessageId));
      stream.applyEvent(delta(5, 'late for the finished one'));
      expect(stream.textFor(messageId)).toBe('done');
      expect(stream.textFor(otherMessageId)).toBe('still going');
    });
  });

  describe('takeDirty edge triggering', () => {
    it('starts not dirty', () => {
      const stream = createMessageStream();
      expect(stream.takeDirty()).toBe(false);
    });

    it('becomes dirty after a delta changes text, then clears on read', () => {
      const stream = createMessageStream();
      stream.applyEvent(delta(0, 'hi'));
      expect(stream.takeDirty()).toBe(true);
      expect(stream.takeDirty()).toBe(false);
    });

    it('does not mark dirty for an empty-string delta (the schema forbids one anyway, but the check must not assume that)', () => {
      const stream = createMessageStream();
      stream.applyEvent(
        agentEventSchema.parse({
          type: 'assistant.text.delta',
          chatId,
          sequence: 0,
          turnId,
          messageId,
          delta: 'x',
        }),
      );
      stream.takeDirty();

      // Re-delivering the same sequence produces the same folded text, so
      // this must NOT re-mark the stream dirty.
      stream.applyEvent(delta(0, 'x'));
      expect(stream.takeDirty()).toBe(false);
    });

    it("marks dirty when completion's content differs from the folded deltas", () => {
      const stream = createMessageStream();
      stream.applyEvent(delta(0, 'draft'));
      stream.takeDirty();

      stream.applyEvent(completed(1, 'final'));
      expect(stream.takeDirty()).toBe(true);
    });

    it("does not mark dirty when completion's content is identical to the already-folded deltas", () => {
      const stream = createMessageStream();
      stream.applyEvent(delta(0, 'same text'));
      stream.takeDirty();

      stream.applyEvent(completed(1, 'same text'));
      expect(stream.takeDirty()).toBe(false);
    });

    it('coalesces multiple changes between polls into a single dirty read', () => {
      const stream = createMessageStream();
      stream.applyEvent(delta(0, 'a'));
      stream.applyEvent(delta(1, 'b'));
      stream.applyEvent(delta(2, 'c'));
      expect(stream.takeDirty()).toBe(true);
      expect(stream.takeDirty()).toBe(false);
    });

    it('ignores unrelated event types entirely (no state change, no dirty flag)', () => {
      const stream = createMessageStream();
      stream.applyEvent(started(0));
      stream.applyEvent(toolCallRequested(1));
      expect(stream.textFor(messageId)).toBe('');
      expect(stream.takeDirty()).toBe(false);
    });
  });

  describe('a realistic throttled-render sequence', () => {
    it('renders a partial mid-stream text once, then the final text once, with no duplication', () => {
      const stream = createMessageStream();
      const renders: string[] = [];

      function throttledTick(): void {
        if (stream.takeDirty()) renders.push(stream.textFor(messageId));
      }

      stream.applyEvent(delta(0, 'I checked '));
      throttledTick(); // fires: partial text so far
      throttledTick(); // no-op: nothing changed since the last tick

      stream.applyEvent(delta(1, 'the page and '));
      stream.applyEvent(delta(2, 'found the answer.'));
      stream.applyEvent(completed(3, 'I checked the page and found the answer.'));
      throttledTick(); // fires once: final text, not appended after the partial render

      expect(renders).toEqual(['I checked ', 'I checked the page and found the answer.']);
    });
  });
});
