/**
 * Builders for journal JSONL fixtures, shaped like what the app writes. They
 * produce plain records (the tests parse them back through the real schema), so
 * a fixture that drifts from the contract fails loudly in `parseJournalText`.
 */

export interface FixtureToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
  /** Omit for a call that never got a result. */
  readonly result?:
    | { readonly ok: true; readonly data: unknown }
    | { readonly ok: false; readonly code: string; readonly message: string };
}

const CHAT = 'chat-1';
const TURN = 'turn-1';

let sequence = 0;

function event(at: number, body: Record<string, unknown>): Record<string, unknown> {
  sequence += 1;
  return { recordType: 'agent.event', at, event: { chatId: CHAT, sequence, ...body } };
}

export function headerRecord(at = 1_000, serverId?: string): Record<string, unknown> {
  return {
    recordType: 'header',
    schemaVersion: 1,
    chatId: CHAT,
    sessionId: 'session-1',
    startedAt: at,
    ...(serverId === undefined ? {} : { serverId }),
  };
}

export function promptRecord(at: number, prompt: string): Record<string, unknown> {
  return { recordType: 'user.prompt', at, chatId: CHAT, turnId: TURN, prompt };
}

export function toolRecords(at: number, call: FixtureToolCall): Record<string, unknown>[] {
  const records = [
    event(at, {
      type: 'tool.call.requested',
      toolCallId: call.id,
      toolName: call.name,
      arguments: call.arguments ?? {},
    }),
  ];
  if (call.result !== undefined) {
    records.push(
      event(at + 10, {
        type: 'tool.result',
        toolCallId: call.id,
        outcome: call.result.ok
          ? { ok: true, data: call.result.data }
          : {
              ok: false,
              error: {
                code: call.result.code,
                message: call.result.message,
                requestId: 'request-1',
                retryable: false,
                requiredAction: 'none',
              },
            },
      }),
    );
  }
  return records;
}

export function assistantRecord(at: number, content: string): Record<string, unknown> {
  return event(at, {
    type: 'assistant.message.completed',
    turnId: TURN,
    messageId: `message-${String(at)}`,
    content,
  });
}

export function usageRecord(
  at: number,
  usage: { inputTokens?: number; outputTokens?: number; model?: string },
): Record<string, unknown> {
  return event(at, { type: 'model.usage', turnId: TURN, ...usage });
}

export function modelChangedRecord(at: number, model: string): Record<string, unknown> {
  return event(at, { type: 'model.changed', model, cause: 'session-open' });
}

export function questionRecord(at: number, question: string): Record<string, unknown> {
  return event(at, {
    type: 'user.input.requested',
    turnId: TURN,
    requestId: 'ask-1',
    question,
    multiple: false,
    freeInput: true,
  });
}

export function turnSummaryRecord(
  at: number,
  outcome: 'completed' | 'error' | 'interrupted' = 'completed',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    recordType: 'turn.summary',
    at,
    chatId: CHAT,
    turnId: TURN,
    outcome,
    durationMs: 500,
    toolCallCount: 0,
    toolDurationMs: 0,
    modelCallCount: 1,
    modelCallFailureCount: 0,
    ...extra,
  };
}

export function toJsonl(records: readonly Record<string, unknown>[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}
