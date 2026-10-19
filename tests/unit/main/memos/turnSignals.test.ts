import { describe, expect, it } from 'vitest';
import {
  MAX_TURN_SIGNALS,
  REPEATED_CALL_THRESHOLD,
  SIGNAL_TEXT_MAX_LENGTH,
  createTurnSignalCollector,
} from '../../../../src/main/memos/turnSignals';
import {
  type AgentEvent,
  type ChatId,
  type JsonValue,
  type RequestId,
  type ToolCallId,
  type ToolErrorCode,
  type TurnId,
  type UserInputRequestId,
  MEMO_TOOL_NAME,
  createToolError,
} from '../../../../src/shared';

const chatId = 'chat-1' as ChatId;
const turnId = 'turn-1' as TurnId;
let sequence = 0;

function requested(
  id: string,
  toolName: string,
  args: Readonly<Record<string, JsonValue>> = {},
): AgentEvent {
  return {
    type: 'tool.call.requested',
    chatId,
    sequence: sequence++,
    toolCallId: id as ToolCallId,
    toolName,
    arguments: args,
  };
}

function failed(id: string, code: ToolErrorCode, message: string): AgentEvent {
  return {
    type: 'tool.result',
    chatId,
    sequence: sequence++,
    toolCallId: id as ToolCallId,
    outcome: { ok: false, error: createToolError(code, message, 'request-1' as RequestId) },
  };
}

function question(): AgentEvent {
  return {
    type: 'user.input.requested',
    chatId,
    sequence: sequence++,
    turnId,
    requestId: `input-${String(sequence)}` as UserInputRequestId,
    question: 'Which one?',
    options: ['A', 'B'],
    multiple: false,
    freeInput: false,
  };
}

function stateChanged(state: 'cancelling' | 'idle'): AgentEvent {
  return { type: 'session.state.changed', chatId, sequence: sequence++, turnId, state };
}

describe('createTurnSignalCollector', () => {
  it('reports nothing for a turn without trouble', () => {
    const collector = createTurnSignalCollector(turnId);
    collector.observe(requested('call-1', 'aem_get_json'), false);
    collector.observe(stateChanged('idle'), false);

    expect(collector.reflectionSignals()).toEqual([]);
  });

  it('reports a failed call with its tool name and error text', () => {
    const collector = createTurnSignalCollector(turnId);
    collector.observe(requested('call-1', 'aem_get_json'), false);
    collector.observe(failed('call-1', 'NOT_FOUND', 'Nothing at /content/x'), false);

    const [signal] = collector.reflectionSignals();
    expect(signal).toContain('aem_get_json');
    expect(signal).toContain('Nothing at /content/x');
  });

  it('clips a long error text', () => {
    const collector = createTurnSignalCollector(turnId);
    collector.observe(requested('call-1', 'aem_get_json'), false);
    collector.observe(
      failed('call-1', 'NOT_FOUND', 'x'.repeat(SIGNAL_TEXT_MAX_LENGTH + 100)),
      false,
    );

    const [signal] = collector.reflectionSignals();
    expect(signal?.length).toBeLessThan(SIGNAL_TEXT_MAX_LENGTH + 50);
  });

  it.each<ToolErrorCode>(['CANCELLED', 'STALE_CONTEXT', 'AUTH_REQUIRED'])(
    'ignores a %s failure, which says nothing about how the agent worked',
    (code) => {
      const collector = createTurnSignalCollector(turnId);
      collector.observe(requested('call-1', 'aem_get_json'), false);
      collector.observe(failed('call-1', code, 'stopped'), false);

      expect(collector.reflectionSignals()).toEqual([]);
    },
  );

  it('ignores a nested call’s failure, which the composite reports on its own', () => {
    const collector = createTurnSignalCollector(turnId);
    collector.observe(requested('call-1', 'aem_query'), true);
    collector.observe(failed('call-1', 'NOT_FOUND', 'nothing'), true);

    expect(collector.reflectionSignals()).toEqual([]);
  });

  it('reports a turn error', () => {
    const collector = createTurnSignalCollector(turnId);
    collector.observe(
      {
        type: 'error',
        chatId,
        sequence: sequence++,
        turnId,
        error: createToolError('UNEXPECTED_RESPONSE', 'model failed', 'request-1' as RequestId),
      },
      false,
    );

    expect(collector.reflectionSignals()[0]).toContain('model failed');
  });

  it('reports the same model call repeated, once, at the threshold, whatever the argument order', () => {
    const collector = createTurnSignalCollector(turnId);
    for (let call = 0; call < REPEATED_CALL_THRESHOLD + 2; call += 1) {
      const args = call % 2 === 0 ? { a: 1, b: 2 } : { b: 2, a: 1 };
      collector.observe(requested(`call-${String(call)}`, 'aem_query', args), false);
    }

    expect(collector.reflectionSignals()).toHaveLength(1);
  });

  it('does not count calls below the threshold, different arguments, or nested calls', () => {
    const collector = createTurnSignalCollector(turnId);
    for (let call = 0; call < REPEATED_CALL_THRESHOLD - 1; call += 1) {
      collector.observe(requested(`model-${String(call)}`, 'aem_query', { a: 1 }), false);
    }
    collector.observe(requested('other', 'aem_query', { a: 2 }), false);
    for (let call = 0; call < REPEATED_CALL_THRESHOLD + 1; call += 1) {
      collector.observe(requested(`nested-${String(call)}`, 'ask_user', { a: 1 }), true);
    }

    expect(collector.reflectionSignals()).toEqual([]);
  });

  it('reports a question asked again after the user dismissed one', () => {
    const collector = createTurnSignalCollector(turnId);
    collector.observe(question(), false);
    collector.noteDismissedInput();
    collector.observe(question(), false);
    collector.observe(question(), false);

    expect(collector.reflectionSignals()).toHaveLength(1);
  });

  it('reports nothing for a dismissed question that was not asked again', () => {
    const collector = createTurnSignalCollector(turnId);
    collector.observe(question(), false);
    collector.noteDismissedInput();

    expect(collector.reflectionSignals()).toEqual([]);
  });

  it('caps the signals', () => {
    const collector = createTurnSignalCollector(turnId);
    for (let call = 0; call < MAX_TURN_SIGNALS + 3; call += 1) {
      const id = `call-${String(call)}`;
      collector.observe(requested(id, 'aem_get_json', { call }), false);
      collector.observe(failed(id, 'NOT_FOUND', 'nothing'), false);
    }

    expect(collector.reflectionSignals()).toHaveLength(MAX_TURN_SIGNALS);
  });

  it('reports nothing for a turn the user stopped', () => {
    const collector = createTurnSignalCollector(turnId);
    collector.observe(requested('call-1', 'aem_get_json'), false);
    collector.observe(failed('call-1', 'NOT_FOUND', 'nothing'), false);
    collector.observe(stateChanged('cancelling'), false);

    expect(collector.reflectionSignals()).toEqual([]);
  });

  it('reports nothing for a turn in which a memo was written, even by a nested call', () => {
    const collector = createTurnSignalCollector(turnId);
    collector.observe(requested('call-1', 'aem_get_json'), false);
    collector.observe(failed('call-1', 'NOT_FOUND', 'nothing'), false);
    collector.observe(requested('call-2', MEMO_TOOL_NAME), true);

    expect(collector.reflectionSignals()).toEqual([]);
  });
});
