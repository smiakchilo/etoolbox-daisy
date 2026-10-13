import { describe, expect, it } from 'vitest';
import { replayJournalIntoTranscript } from '../../../../src/renderer/src/chat/journalReplay';
import { createTranscriptStore } from '../../../../src/renderer/src/chat/transcriptStore';
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
  SdkSessionId,
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
  sdkSessionId: 'sdk-1' as SdkSessionId,
  serverId: 'server-1' as ServerId,
  startedAt: 1,
};

function userPrompt(turnId: string, prompt: string): ChatJournalRecord {
  return {
    recordType: 'user.prompt',
    at: 2,
    chatId: CHAT,
    turnId: turnId as TurnId,
    prompt,
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
