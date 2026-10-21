import { describe, expect, it } from 'vitest';
import { replayJournalIntoTranscript } from '../../../../src/renderer/src/chat/journalReplay';
import { createTranscriptStore } from '../../../../src/renderer/src/chat/transcriptStore';
import { agentEventSchema, MEMO_REFLECTION_TOOL_NAME } from '../../../../src/shared';
import type {
  ChatId,
  ChatJournalAbandonedToolCallRecord,
  ChatJournalAgentEventRecord,
  ChatJournalClosedRecord,
  ChatJournalHeaderRecord,
  ChatJournalInterruptionRecord,
  ChatJournalPartialMessageRecord,
  ChatJournalRecord,
  MessageId,
  SessionId,
  ServerId,
  ToolCallId,
  TurnId,
} from '../../../../src/shared';

/**
 * The replay is a pure projection from journal records onto a transcript
 * store, so it is exercised directly - no DOM, no pane, no IPC.
 */

const CHAT = 'chat-1' as ChatId;

const header: ChatJournalHeaderRecord = {
  recordType: 'header',
  schemaVersion: 1,
  chatId: CHAT,
  sessionId: 'sdk-1' as SessionId,
  serverId: 'server-1' as ServerId,
  startedAt: 1,
};

function userPrompt(turnId: string, prompt: string, origin?: 'reflection'): ChatJournalRecord {
  return {
    recordType: 'user.prompt',
    at: 2,
    chatId: CHAT,
    turnId: turnId as TurnId,
    prompt,
    ...(origin !== undefined ? { origin } : {}),
  };
}

function completedMessage(turnId: string, messageId: string, content: string): ChatJournalRecord {
  return {
    recordType: 'agent.event',
    at: 3,
    event: {
      type: 'assistant.message.completed',
      chatId: CHAT,
      sequence: 0,
      turnId: turnId as TurnId,
      messageId: messageId as MessageId,
      content,
    },
  };
}

describe('replayJournalIntoTranscript', () => {
  it('rebuilds user prompts and completed assistant messages in order', () => {
    const store = createTranscriptStore();
    replayJournalIntoTranscript(
      [header, userPrompt('turn-1', 'hello'), completedMessage('turn-1', 'msg-1', 'hi there')],
      store,
    );

    expect(store.items()).toEqual([
      { kind: 'userPrompt', turnId: 'turn-1' },
      { kind: 'message', messageId: 'msg-1', turnId: 'turn-1' },
    ]);
    expect(store.textForUserPrompt('turn-1' as TurnId)).toBe('hello');
    expect(store.textForMessage('msg-1' as MessageId)).toBe('hi there');
  });

  it("does not paint a reflection's prompt, and hides its prose behind the marker billet", () => {
    const store = createTranscriptStore();
    const reflectionPrompt = userPrompt('turn-2', 'Reflect on the previous turn', 'reflection');
    const sending: ChatJournalRecord = {
      recordType: 'agent.event',
      at: 3,
      event: {
        type: 'session.state.changed',
        chatId: CHAT,
        sequence: 1,
        turnId: 'turn-2' as TurnId,
        state: 'sending',
      },
    };
    const marker: ChatJournalRecord = {
      recordType: 'agent.event',
      at: 3,
      event: {
        type: 'tool.call.requested',
        chatId: CHAT,
        sequence: 2,
        toolCallId: 'marker-1' as ToolCallId,
        toolName: MEMO_REFLECTION_TOOL_NAME,
        arguments: {},
      },
    };
    replayJournalIntoTranscript(
      [
        header,
        userPrompt('turn-1', 'hello'),
        completedMessage('turn-1', 'msg-1', 'hi there'),
        reflectionPrompt,
        sending,
        marker,
        completedMessage('turn-2', 'msg-2', 'Nothing to remember.'),
      ],
      store,
    );

    expect(store.items()).toEqual([
      { kind: 'userPrompt', turnId: 'turn-1' },
      { kind: 'message', messageId: 'msg-1', turnId: 'turn-1' },
      { kind: 'toolCall', toolCallId: 'marker-1' },
    ]);
  });

  it('skips turn.summary records and journaled model diagnostics events', () => {
    const store = createTranscriptStore();
    const summary: ChatJournalRecord = {
      recordType: 'turn.summary',
      at: 6,
      chatId: CHAT,
      turnId: 'turn-1' as TurnId,
      outcome: 'completed',
      durationMs: 5,
      toolCallCount: 0,
      toolDurationMs: 0,
      modelCallCount: 1,
      modelCallFailureCount: 0,
    };
    const usage: ChatJournalAgentEventRecord = {
      recordType: 'agent.event',
      at: 5,
      event: { type: 'model.usage', chatId: CHAT, sequence: 3, inputTokens: 1 },
    };
    replayJournalIntoTranscript(
      [userPrompt('turn-1', 'hello'), usage, completedMessage('turn-1', 'msg-1', 'hi'), summary],
      store,
    );
    expect(store.items()).toEqual([
      { kind: 'userPrompt', turnId: 'turn-1' },
      { kind: 'message', messageId: 'msg-1', turnId: 'turn-1' },
    ]);
  });

  it('replays tool calls through the same store the live stream uses', () => {
    const store = createTranscriptStore();
    const requested: ChatJournalAgentEventRecord = {
      recordType: 'agent.event',
      at: 4,
      event: {
        type: 'tool.call.requested',
        chatId: CHAT,
        sequence: 1,
        toolCallId: 'tool-1' as ToolCallId,
        toolName: 'aem_get_json',
        arguments: { path: '/content/site' },
      },
    };
    const result: ChatJournalAgentEventRecord = {
      recordType: 'agent.event',
      at: 5,
      event: {
        type: 'tool.result',
        chatId: CHAT,
        sequence: 2,
        toolCallId: 'tool-1' as ToolCallId,
        outcome: { ok: true, data: { ok: true } },
      },
    };

    replayJournalIntoTranscript([userPrompt('turn-1', 'read the page'), requested, result], store);

    const tool = store.toolCallFor('tool-1' as ToolCallId);
    expect(tool?.toolName).toBe('aem_get_json');
    expect(tool?.status).toEqual({ kind: 'succeeded', data: { ok: true } });
  });

  it('settles an unresolved replayed tool call as abandoned, not still running', () => {
    // The app closed mid-turn: the journal has the call's requested/approved
    // events but never a result. A repaired transcript must not show a spinner
    // that can never stop.
    const store = createTranscriptStore();
    const requested: ChatJournalAgentEventRecord = {
      recordType: 'agent.event',
      at: 4,
      event: {
        type: 'tool.call.requested',
        chatId: CHAT,
        sequence: 1,
        toolCallId: 'tool-open' as ToolCallId,
        toolName: 'aem_semantic_search',
        arguments: { terms: 'waldo' },
      },
    };
    const approved: ChatJournalAgentEventRecord = {
      recordType: 'agent.event',
      at: 5,
      event: {
        type: 'tool.call.approved',
        chatId: CHAT,
        sequence: 2,
        toolCallId: 'tool-open' as ToolCallId,
      },
    };

    replayJournalIntoTranscript([userPrompt('turn-1', 'search'), requested, approved], store);

    expect(store.toolCallFor('tool-open' as ToolCallId)?.status).toEqual({ kind: 'abandoned' });
  });

  it('settles a call the journal interrupted before it appended the notice', () => {
    // The reported defect: a turn cancelled by a navigation leaves the running
    // composite's requested/approved events and then an `interruption` record.
    // Replaying the notice used to drop the "is anything running?" index, so the
    // final settle had nothing to settle and the billet span forever - even
    // after a restart.
    const store = createTranscriptStore();
    const requested: ChatJournalAgentEventRecord = {
      recordType: 'agent.event',
      at: 4,
      event: agentEventSchema.parse({
        type: 'tool.call.requested',
        chatId: CHAT,
        sequence: 1,
        toolCallId: 'composite',
        toolName: 'aem_query_format_ask',
        arguments: { terms: 'waldo' },
      }),
    };
    const approved: ChatJournalAgentEventRecord = {
      recordType: 'agent.event',
      at: 5,
      event: agentEventSchema.parse({
        type: 'tool.call.approved',
        chatId: CHAT,
        sequence: 2,
        toolCallId: 'composite',
      }),
    };
    const interruption: ChatJournalInterruptionRecord = {
      recordType: 'interruption',
      at: 6,
      chatId: CHAT,
      reason: 'navigation',
    };

    replayJournalIntoTranscript(
      [userPrompt('turn-1', 'search'), requested, approved, interruption],
      store,
    );

    expect(store.toolCallFor('composite' as ToolCallId)?.status).toEqual({ kind: 'abandoned' });
    expect(store.items().map((item) => item.kind)).toEqual([
      'userPrompt',
      'toolCall',
      'interruption',
    ]);
  });

  it('settles unfinished calls with no status word when the turn ended waiting on the user', () => {
    // The app closed while a "Load more" question was on screen. Nothing was in
    // flight, so neither the composite that owns the question nor the ask_user
    // call itself is "Interrupted" - the transcript shows no status word for
    // either (see `abandonRunningToolCalls`' `awaitingInput`).
    const store = createTranscriptStore();
    const composite: ChatJournalAgentEventRecord = {
      recordType: 'agent.event',
      at: 4,
      event: agentEventSchema.parse({
        type: 'tool.call.requested',
        chatId: CHAT,
        sequence: 1,
        toolCallId: 'composite',
        toolName: 'aem_query_format_ask',
        arguments: { terms: 'waldo' },
      }),
    };
    const ask: ChatJournalAgentEventRecord = {
      recordType: 'agent.event',
      at: 5,
      event: agentEventSchema.parse({
        type: 'tool.call.requested',
        chatId: CHAT,
        sequence: 2,
        toolCallId: 'ask-1',
        toolName: 'ask_user',
        arguments: { actions: ['Load more'], multiple: false, freeInput: false },
      }),
    };
    const question: ChatJournalAgentEventRecord = {
      recordType: 'agent.event',
      at: 6,
      event: agentEventSchema.parse({
        type: 'user.input.requested',
        chatId: CHAT,
        sequence: 3,
        turnId: 'turn-1',
        requestId: 'req-1',
        actions: ['Load more'],
        multiple: false,
        freeInput: false,
      }),
    };

    replayJournalIntoTranscript([userPrompt('turn-1', 'search'), composite, ask, question], store);

    expect(store.toolCallFor('composite' as ToolCallId)?.status).toEqual({
      kind: 'abandonedAwaitingInput',
    });
    expect(store.toolCallFor('ask-1' as ToolCallId)?.status).toEqual({
      kind: 'abandonedAwaitingInput',
    });
  });

  it('settles a pending total flag the replay left on a format_table call', () => {
    // The turn stopped while a background count was in flight: the journal's
    // last `format_table` call still carries `totalPending: true`. A restored
    // transcript must show the fallback total with no spinner, not spin forever.
    const store = createTranscriptStore();
    const requested: ChatJournalAgentEventRecord = {
      recordType: 'agent.event',
      at: 4,
      event: {
        type: 'tool.call.requested',
        chatId: CHAT,
        sequence: 1,
        toolCallId: 'table-open' as ToolCallId,
        toolName: 'format_table',
        arguments: { data: { rows: [] }, mode: 'new', totalPending: true },
      },
    };
    const result: ChatJournalAgentEventRecord = {
      recordType: 'agent.event',
      at: 5,
      event: {
        type: 'tool.result',
        chatId: CHAT,
        sequence: 2,
        toolCallId: 'table-open' as ToolCallId,
        outcome: { ok: true, data: { operation: 'format_table', resultType: 'success' } },
      },
    };

    replayJournalIntoTranscript([userPrompt('turn-1', 'search'), requested, result], store);

    expect(store.toolCallFor('table-open' as ToolCallId)?.args['totalPending']).toBe(false);
  });

  it('replays a durable interruption record as a historical, non-resumable notice', () => {
    const interruption: ChatJournalInterruptionRecord = {
      recordType: 'interruption',
      at: 9,
      chatId: CHAT,
      reason: 'stopped',
    };
    const store = createTranscriptStore();
    replayJournalIntoTranscript([header, userPrompt('turn-1', 'go'), interruption], store);

    // `resumable: false` is the whole point: a restored notice is history and
    // must never offer the live pane's Resume action.
    expect(store.items()).toEqual([
      { kind: 'userPrompt', turnId: 'turn-1' },
      {
        kind: 'interruption',
        interruptionId: 'interruption-1',
        reason: 'stopped',
        resumable: false,
      },
    ]);
  });

  it('ignores header, partial-message, abandoned-tool and closed records', () => {
    const partial: ChatJournalPartialMessageRecord = {
      recordType: 'assistant.message.partial',
      at: 6,
      chatId: CHAT,
      turnId: 'turn-1' as TurnId,
      messageId: 'msg-partial' as MessageId,
      content: 'half a thought',
    };
    const abandoned: ChatJournalAbandonedToolCallRecord = {
      recordType: 'tool.call.abandoned',
      at: 7,
      chatId: CHAT,
      toolCallId: 'tool-1' as ToolCallId,
      toolName: 'aem_query',
    };
    const closed: ChatJournalClosedRecord = { recordType: 'chat.closed', at: 8, chatId: CHAT };

    const store = createTranscriptStore();
    replayJournalIntoTranscript([header, partial, abandoned, closed], store);

    expect(store.items()).toEqual([]);
  });

  it('leaves an already-empty store empty', () => {
    const store = createTranscriptStore();
    replayJournalIntoTranscript([], store);
    expect(store.items()).toEqual([]);
  });
});
