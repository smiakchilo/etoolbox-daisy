import { describe, expect, it } from 'vitest';
import {
  agentEventSchema,
  createDeltaFoldState,
  EventSequencer,
  foldTextDelta,
  renderFoldedText,
  type AssistantTextDeltaEvent,
} from '../../../../src/shared/contracts/agentEvents';
import { chatIdSchema, messageIdSchema } from '../../../../src/shared/contracts/ids';

function validMessageStarted(overrides: Record<string, unknown> = {}) {
  return {
    type: 'assistant.message.started',
    chatId: 'chat-1',
    sequence: 0,
    turnId: 'turn-1',
    messageId: 'msg-1',
    ...overrides,
  };
}

function validTextDelta(overrides: Record<string, unknown> = {}) {
  return {
    type: 'assistant.text.delta',
    chatId: 'chat-1',
    sequence: 1,
    turnId: 'turn-1',
    messageId: 'msg-1',
    delta: 'hello',
    ...overrides,
  };
}

function validMessageCompleted(overrides: Record<string, unknown> = {}) {
  return {
    type: 'assistant.message.completed',
    chatId: 'chat-1',
    sequence: 2,
    turnId: 'turn-1',
    messageId: 'msg-1',
    content: 'hello there',
    ...overrides,
  };
}

function validToolCallRequested(overrides: Record<string, unknown> = {}) {
  return {
    type: 'tool.call.requested',
    chatId: 'chat-1',
    sequence: 3,
    toolCallId: 'call-1',
    toolName: 'aem_get_json',
    arguments: { path: '/content/foo' },
    ...overrides,
  };
}

function validToolCallApproved(overrides: Record<string, unknown> = {}) {
  return {
    type: 'tool.call.approved',
    chatId: 'chat-1',
    sequence: 4,
    toolCallId: 'call-1',
    ...overrides,
  };
}

function validToolCallRejected(overrides: Record<string, unknown> = {}) {
  return {
    type: 'tool.call.rejected',
    chatId: 'chat-1',
    sequence: 4,
    toolCallId: 'call-1',
    reason: 'Not on the tool allowlist.',
    ...overrides,
  };
}

function validToolResult(overrides: Record<string, unknown> = {}) {
  return {
    type: 'tool.result',
    chatId: 'chat-1',
    sequence: 5,
    toolCallId: 'call-1',
    outcome: { ok: true, data: { properties: {} } },
    ...overrides,
  };
}

function validError(overrides: Record<string, unknown> = {}) {
  return {
    type: 'error',
    chatId: 'chat-1',
    sequence: 6,
    error: {
      code: 'NETWORK_ERROR',
      message: 'The request failed.',
      requestId: 'req-1',
      retryable: true,
      requiredAction: 'none',
    },
    ...overrides,
  };
}

function validSessionStateChanged(overrides: Record<string, unknown> = {}) {
  return {
    type: 'session.state.changed',
    chatId: 'chat-1',
    sequence: 7,
    state: 'idle',
    ...overrides,
  };
}

describe('agentEventSchema: valid variants', () => {
  it.each([
    ['assistant.message.started', validMessageStarted()],
    ['assistant.text.delta', validTextDelta()],
    ['assistant.message.completed', validMessageCompleted()],
    ['tool.call.requested', validToolCallRequested()],
    ['tool.call.approved', validToolCallApproved()],
    ['tool.call.rejected', validToolCallRejected()],
    ['tool.result (success)', validToolResult()],
    [
      'tool.result (failure)',
      validToolResult({ outcome: { ok: false, error: validError().error } }),
    ],
    ['error', validError()],
    ['session.state.changed', validSessionStateChanged()],
  ])('accepts a well-formed %s event', (_label, candidate) => {
    const result = agentEventSchema.safeParse(candidate);
    expect(result.success).toBe(true);
  });
});

function omitKey(candidate: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...candidate };
  delete copy[key];
  return copy;
}

describe('agentEventSchema: routing correlation ids are mandatory', () => {
  it('rejects an event missing chatId - it would be unroutable', () => {
    expect(agentEventSchema.safeParse(omitKey(validMessageStarted(), 'chatId')).success).toBe(
      false,
    );
  });

  it('rejects an event missing sequence', () => {
    expect(agentEventSchema.safeParse(omitKey(validToolResult(), 'sequence')).success).toBe(false);
  });

  it('rejects a message-scoped event missing messageId', () => {
    expect(agentEventSchema.safeParse(omitKey(validTextDelta(), 'messageId')).success).toBe(false);
  });

  it('rejects a message-scoped event missing turnId', () => {
    expect(agentEventSchema.safeParse(omitKey(validMessageCompleted(), 'turnId')).success).toBe(
      false,
    );
  });

  it('rejects a tool-scoped event missing toolCallId', () => {
    expect(
      agentEventSchema.safeParse(omitKey(validToolCallRequested(), 'toolCallId')).success,
    ).toBe(false);
  });

  it('accepts an error event with no turnId/toolCallId (a session-level error)', () => {
    expect(agentEventSchema.safeParse(validError()).success).toBe(true);
  });

  it('accepts a session.state.changed event with no turnId (session.start/shutdown)', () => {
    expect(agentEventSchema.safeParse(validSessionStateChanged()).success).toBe(true);
  });
});

describe('agentEventSchema: does not forward raw SDK payloads', () => {
  it('rejects an event carrying an extra unknown key', () => {
    const withExtraField = validMessageStarted({ parentId: 'raw-sdk-uuid-leak' });
    expect(agentEventSchema.safeParse(withExtraField).success).toBe(false);
  });

  it('rejects tool.call.requested arguments containing a non-JSON value (e.g. a function)', () => {
    const candidate = validToolCallRequested({ arguments: { onClick: () => undefined } });
    expect(agentEventSchema.safeParse(candidate).success).toBe(false);
  });

  it('rejects an unknown event type outright', () => {
    expect(
      agentEventSchema.safeParse({
        type: 'assistant.reasoning_delta',
        chatId: 'chat-1',
        sequence: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects an empty assistant.text.delta chunk', () => {
    expect(agentEventSchema.safeParse(validTextDelta({ delta: '' })).success).toBe(false);
  });

  it('rejects a negative sequence number', () => {
    expect(agentEventSchema.safeParse(validMessageStarted({ sequence: -1 })).success).toBe(false);
  });

  it('rejects a non-integer sequence number', () => {
    expect(agentEventSchema.safeParse(validMessageStarted({ sequence: 1.5 })).success).toBe(false);
  });
});

describe('EventSequencer', () => {
  it('reports a fresh sequence number as ok', () => {
    const sequencer = new EventSequencer();
    const chatId = chatIdSchema.parse('chat-a');
    expect(sequencer.check({ chatId, sequence: 0 })).toEqual({ kind: 'ok', sequence: 0 });
    expect(sequencer.check({ chatId, sequence: 1 })).toEqual({ kind: 'ok', sequence: 1 });
  });

  it('reports the same sequence number seen twice as a duplicate', () => {
    const sequencer = new EventSequencer();
    const chatId = chatIdSchema.parse('chat-a');
    sequencer.check({ chatId, sequence: 0 });
    expect(sequencer.check({ chatId, sequence: 0 })).toEqual({ kind: 'duplicate', sequence: 0 });
  });

  it('reports a jump ahead as a gap, naming the expected and received sequence', () => {
    const sequencer = new EventSequencer();
    const chatId = chatIdSchema.parse('chat-a');
    sequencer.check({ chatId, sequence: 0 });
    expect(sequencer.check({ chatId, sequence: 3 })).toEqual({
      kind: 'gap',
      expected: 1,
      received: 3,
    });
  });

  it('reports a late arrival that fills a previously reported gap as ok, not another gap', () => {
    const sequencer = new EventSequencer();
    const chatId = chatIdSchema.parse('chat-a');
    sequencer.check({ chatId, sequence: 0 });
    sequencer.check({ chatId, sequence: 3 }); // gap, 1 and 2 missing
    expect(sequencer.check({ chatId, sequence: 1 })).toEqual({ kind: 'ok', sequence: 1 });
    expect(sequencer.check({ chatId, sequence: 2 })).toEqual({ kind: 'ok', sequence: 2 });
  });

  it('keeps sequence tracking independent per chat: identical sequence numbers in two chats are not duplicates of each other', () => {
    const sequencer = new EventSequencer();
    const chatA = chatIdSchema.parse('chat-a');
    const chatB = chatIdSchema.parse('chat-b');

    // Interleaved delivery, as would happen with two concurrent chats.
    expect(sequencer.check({ chatId: chatA, sequence: 0 })).toEqual({ kind: 'ok', sequence: 0 });
    expect(sequencer.check({ chatId: chatB, sequence: 0 })).toEqual({ kind: 'ok', sequence: 0 });
    expect(sequencer.check({ chatId: chatA, sequence: 1 })).toEqual({ kind: 'ok', sequence: 1 });
    expect(sequencer.check({ chatId: chatB, sequence: 1 })).toEqual({ kind: 'ok', sequence: 1 });

    // A duplicate in chat A must not be masked, or cross-contaminated, by chat B's state.
    expect(sequencer.check({ chatId: chatA, sequence: 1 })).toEqual({
      kind: 'duplicate',
      sequence: 1,
    });
    expect(sequencer.check({ chatId: chatB, sequence: 2 })).toEqual({ kind: 'ok', sequence: 2 });
  });

  it('still detects a duplicate of an early sequence after thousands more have been seen - bounded memory does not defeat detection of confirmed-contiguous sequences', () => {
    const sequencer = new EventSequencer();
    const chatId = chatIdSchema.parse('chat-a');
    for (let sequence = 0; sequence <= 5000; sequence += 1) {
      sequencer.check({ chatId, sequence });
    }
    // Sequence 0 is far below the low-water mark by now; it is still
    // recognized as a duplicate even though it was not individually
    // retained the whole time - see the low-water-mark comment in the class.
    expect(sequencer.check({ chatId, sequence: 0 })).toEqual({ kind: 'duplicate', sequence: 0 });
    expect(sequencer.check({ chatId, sequence: 4999 })).toEqual({
      kind: 'duplicate',
      sequence: 4999,
    });
  });

  it('at the window boundary, an in-window arrival is still a recoverable gap; one past it forces abandonment of the unrecoverable range, exactly once', () => {
    const sequencer = new EventSequencer(4);
    const chatId = chatIdSchema.parse('chat-a');
    sequencer.check({ chatId, sequence: 0 }); // ok; low-water mark advances to 1; sequence 1 never arrives

    // 5 is exactly at the configured window boundary (5 - lowWaterMark(1) === windowSize(4))
    // and the missing sequence 1 could still arrive and fill it - a recoverable gap.
    expect(sequencer.check({ chatId, sequence: 2 })).toEqual({
      kind: 'gap',
      expected: 1,
      received: 2,
    });
    expect(sequencer.check({ chatId, sequence: 3 })).toEqual({ kind: 'ok', sequence: 3 });
    expect(sequencer.check({ chatId, sequence: 4 })).toEqual({ kind: 'ok', sequence: 4 });
    expect(sequencer.check({ chatId, sequence: 5 })).toEqual({ kind: 'ok', sequence: 5 });

    // 6 is one past the boundary: sequence 1 can never be waited for without
    // growing the tracked window without bound, so this class gives up on it
    // explicitly, exactly once, naming the abandoned range.
    expect(sequencer.check({ chatId, sequence: 6 })).toEqual({
      kind: 'gap_abandoned',
      from: 1,
      to: 1,
    });

    // Recovery: the next in-order events are ordinary `ok`, not a repeat of
    // the anomaly - a single lost event does not poison the rest of the chat.
    expect(sequencer.check({ chatId, sequence: 7 })).toEqual({ kind: 'ok', sequence: 7 });
    expect(sequencer.check({ chatId, sequence: 8 })).toEqual({ kind: 'ok', sequence: 8 });

    // A late re-delivery of the abandoned sequence is a plain `duplicate` -
    // not a third kind of anomaly.
    expect(sequencer.check({ chatId, sequence: 1 })).toEqual({ kind: 'duplicate', sequence: 1 });
  });

  it("forgets a chat's tracking state once released, so a previously-seen sequence is treated as fresh again", () => {
    const sequencer = new EventSequencer();
    const chatId = chatIdSchema.parse('chat-a');
    sequencer.check({ chatId, sequence: 0 });
    expect(sequencer.check({ chatId, sequence: 0 })).toEqual({ kind: 'duplicate', sequence: 0 });

    sequencer.release(chatId);

    expect(sequencer.check({ chatId, sequence: 0 })).toEqual({ kind: 'ok', sequence: 0 });
  });

  it("treats the first sequence ever observed for a chat as that chat's baseline, not as thousands of gaps below sequence 0 - a resumed chat after a process restart looks exactly like this", () => {
    const sequencer = new EventSequencer(4);
    const chatId = chatIdSchema.parse('chat-a');

    // This class never saw sequences 0..3999; it has no basis to claim they
    // were lost, so the first observation must establish the baseline, not
    // trigger a fabricated `gap_abandoned` for everything before it.
    expect(sequencer.check({ chatId, sequence: 4000 })).toEqual({ kind: 'ok', sequence: 4000 });
    expect(sequencer.check({ chatId, sequence: 4001 })).toEqual({ kind: 'ok', sequence: 4001 });
  });

  it('treats a straggler after release() as a fresh baseline rather than reporting the gap the release created', () => {
    const sequencer = new EventSequencer(4);
    const chatId = chatIdSchema.parse('chat-a');
    sequencer.check({ chatId, sequence: 0 });
    sequencer.check({ chatId, sequence: 1 });

    sequencer.release(chatId);

    // A late-arriving event for this chatId after release is indistinguishable
    // from a brand-new chat to this class, and must be treated the same way:
    // as the new baseline, reported ok - not as a mass `gap_abandoned` for the
    // sequences the release itself caused this class to stop tracking.
    expect(sequencer.check({ chatId, sequence: 3000 })).toEqual({ kind: 'ok', sequence: 3000 });
  });
});

describe('delta folding', () => {
  const messageId = messageIdSchema.parse('msg-1');

  function delta(sequence: number, text: string): AssistantTextDeltaEvent {
    return agentEventSchema.parse(
      validTextDelta({ sequence, delta: text, messageId: 'msg-1' }),
    ) as AssistantTextDeltaEvent;
  }

  it('folds in-order deltas into the concatenated message', () => {
    let state = createDeltaFoldState(messageId);
    state = foldTextDelta(state, delta(0, 'Hello'));
    state = foldTextDelta(state, delta(1, ', '));
    state = foldTextDelta(state, delta(2, 'world'));
    expect(renderFoldedText(state)).toBe('Hello, world');
  });

  it('folds out-of-order deltas into the same correct text, regardless of arrival order', () => {
    let state = createDeltaFoldState(messageId);
    state = foldTextDelta(state, delta(2, 'world'));
    state = foldTextDelta(state, delta(0, 'Hello'));
    state = foldTextDelta(state, delta(1, ', '));
    expect(renderFoldedText(state)).toBe('Hello, world');
  });

  it('ignores a duplicate delta re-delivered at the same sequence, rather than duplicating its text', () => {
    let state = createDeltaFoldState(messageId);
    state = foldTextDelta(state, delta(0, 'Hello'));
    state = foldTextDelta(state, delta(1, ' world'));
    state = foldTextDelta(state, delta(0, 'Hello')); // re-delivered
    expect(renderFoldedText(state)).toBe('Hello world');
  });

  it('tolerates an empty-string delta (defensive: the schema itself forbids constructing one)', () => {
    let state = createDeltaFoldState(messageId);
    state = foldTextDelta(state, {
      type: 'assistant.text.delta',
      chatId: chatIdSchema.parse('chat-1'),
      sequence: 0,
      turnId: delta(1, 'x').turnId,
      messageId,
      delta: '',
    });
    state = foldTextDelta(state, delta(1, 'hello'));
    expect(renderFoldedText(state)).toBe('hello');
  });

  it('does not mutate the state object it was given', () => {
    const state = createDeltaFoldState(messageId);
    const next = foldTextDelta(state, delta(0, 'Hello'));
    expect(state.chunks.size).toBe(0);
    expect(next.chunks.size).toBe(1);
  });

  it('throws when a delta for a different messageId is folded into this state, rather than silently mixing messages', () => {
    const state = createDeltaFoldState(messageId);
    const otherMessageDelta = agentEventSchema.parse(
      validTextDelta({ messageId: 'msg-2' }),
    ) as AssistantTextDeltaEvent;
    expect(() => foldTextDelta(state, otherMessageDelta)).toThrow(/does not belong/);
  });
});
