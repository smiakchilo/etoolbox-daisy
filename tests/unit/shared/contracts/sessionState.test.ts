import { describe, expect, it } from 'vitest';
import {
  agentEventSchema,
  SESSION_STREAM_STATES,
} from '../../../../src/shared';
import {
  applyAgentEvent,
  applyTransition,
  canRunAemTool,
  canSendMessage,
  canTransition,
  type SessionStatus,
} from '../../../../src/shared';

function idleStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return { state: 'idle', authenticated: true, browserReady: true, ...overrides };
}

function event(overrides: Record<string, unknown>) {
  return agentEventSchema.parse({
    chatId: 'chat-1',
    sequence: 0,
    ...overrides,
  });
}

describe('canTransition / applyTransition: legal transitions', () => {
  it.each([
    ['idle', 'idle'],
    ['idle', 'sending'],
    ['idle', 'error'],
    ['idle', 'closed'],
    ['sending', 'streaming'],
    ['sending', 'runningTool'],
    ['sending', 'cancelling'],
    ['sending', 'error'],
    ['streaming', 'runningTool'],
    ['streaming', 'idle'],
    ['streaming', 'cancelling'],
    ['streaming', 'error'],
    ['runningTool', 'streaming'],
    ['runningTool', 'cancelling'],
    ['runningTool', 'error'],
    ['cancelling', 'idle'],
    ['cancelling', 'error'],
    ['error', 'idle'],
    ['error', 'closed'],
  ] as const)('accepts %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    const result = applyTransition(from, to);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(to);
  });
});

describe('canTransition / applyTransition: representative illegal transitions', () => {
  it.each([
    ['idle', 'streaming'],
    ['idle', 'runningTool'],
    ['idle', 'cancelling'],
    ['sending', 'idle'],
    ['streaming', 'sending'],
    ['runningTool', 'idle'],
    ['runningTool', 'sending'],
    ['cancelling', 'sending'],
    ['cancelling', 'streaming'],
    ['cancelling', 'runningTool'],
    ['error', 'streaming'],
    ['error', 'runningTool'],
    ['error', 'sending'],
    ['error', 'cancelling'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    const result = applyTransition(from, to);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.from).toBe(from);
      expect(result.error.to).toBe(to);
      expect(result.error.message).toMatch(/illegal/i);
    }
  });
});

describe('closed is terminal', () => {
  it.each(SESSION_STREAM_STATES)('rejects closed -> %s, including closed itself', (target) => {
    expect(canTransition('closed', target)).toBe(false);
  });
});

describe('full lifecycle: idle -> sending -> streaming -> runningTool -> streaming -> idle', () => {
  it('walks the whole cycle via direct transitions and agent events', () => {
    let status = idleStatus();

    const sendResult = applyTransition(status.state, 'sending');
    expect(sendResult.ok).toBe(true);
    if (sendResult.ok) status = { ...status, state: sendResult.value };
    expect(status.state).toBe('sending');

    const started = applyAgentEvent(
      status,
      event({
        type: 'assistant.message.started',
        turnId: 'turn-1',
        messageId: 'msg-1',
        sequence: 1,
      }),
    );
    expect(started.ok).toBe(true);
    if (started.ok) status = started.value;
    expect(status.state).toBe('streaming');

    const delta = applyAgentEvent(
      status,
      event({
        type: 'assistant.text.delta',
        turnId: 'turn-1',
        messageId: 'msg-1',
        delta: 'hi',
        sequence: 2,
      }),
    );
    expect(delta.ok).toBe(true);
    if (delta.ok) status = delta.value;
    expect(status.state).toBe('streaming');

    const requested = applyAgentEvent(
      status,
      event({
        type: 'tool.call.requested',
        toolCallId: 'call-1',
        toolName: 'aem_get_json',
        arguments: { path: '/content' },
        sequence: 3,
      }),
    );
    expect(requested.ok).toBe(true);
    if (requested.ok) status = requested.value;
    expect(status.state).toBe('runningTool');

    const result = applyAgentEvent(
      status,
      event({
        type: 'tool.result',
        toolCallId: 'call-1',
        outcome: { ok: true, data: { properties: {} } },
        sequence: 4,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) status = result.value;
    expect(status.state).toBe('streaming');

    const completed = applyAgentEvent(
      status,
      event({
        type: 'assistant.message.completed',
        turnId: 'turn-1',
        messageId: 'msg-1',
        content: 'hi, done',
        sequence: 5,
      }),
    );
    expect(completed.ok).toBe(true);
    if (completed.ok) status = completed.value;
    expect(status.state).toBe('streaming');

    const turnEnded = applyAgentEvent(
      status,
      event({ type: 'session.state.changed', turnId: 'turn-1', state: 'idle', sequence: 6 }),
    );
    expect(turnEnded.ok).toBe(true);
    if (turnEnded.ok) status = turnEnded.value;
    expect(status.state).toBe('idle');
  });
});

describe('full lifecycle: idle -> sending -> runningTool -> streaming -> idle (a turn whose first activity is a tool call)', () => {
  it('accepts a tool call with no preceding assistant.message.started', () => {
    let status = idleStatus();

    const sendResult = applyTransition(status.state, 'sending');
    expect(sendResult.ok).toBe(true);
    if (sendResult.ok) status = { ...status, state: sendResult.value };
    expect(status.state).toBe('sending');

    const requested = applyAgentEvent(
      status,
      event({
        type: 'tool.call.requested',
        toolCallId: 'call-1',
        toolName: 'aem_get_json',
        arguments: { path: '/content' },
        sequence: 1,
      }),
    );
    expect(requested.ok).toBe(true);
    if (requested.ok) status = requested.value;
    expect(status.state).toBe('runningTool');

    const result = applyAgentEvent(
      status,
      event({
        type: 'tool.result',
        toolCallId: 'call-1',
        outcome: { ok: true, data: {} },
        sequence: 2,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) status = result.value;
    expect(status.state).toBe('streaming');

    const turnEnded = applyAgentEvent(
      status,
      event({ type: 'session.state.changed', turnId: 'turn-1', state: 'idle', sequence: 3 }),
    );
    expect(turnEnded.ok).toBe(true);
    if (turnEnded.ok) status = turnEnded.value;
    expect(status.state).toBe('idle');
  });
});

describe('cancellation', () => {
  it.each(['sending', 'streaming', 'runningTool'] as const)(
    'accepts cancellation from %s',
    (from) => {
      expect(canTransition(from, 'cancelling')).toBe(true);
    },
  );

  it('rejects cancellation from idle - there is nothing in flight to cancel', () => {
    expect(canTransition('idle', 'cancelling')).toBe(false);
  });
});

describe('an error arriving mid-stream', () => {
  it.each(['sending', 'streaming', 'runningTool', 'cancelling'] as const)(
    'moves a %s session to error',
    (from) => {
      const status: SessionStatus = { state: from, authenticated: true, browserReady: true };
      const result = applyAgentEvent(
        status,
        event({
          type: 'error',
          error: {
            code: 'NETWORK_ERROR',
            message: 'boom',
            requestId: 'req-1',
            retryable: true,
            requiredAction: 'none',
          },
          sequence: 9,
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.state).toBe('error');
    },
  );

  it('reports (does not silently apply) a late tool.result delivered after the chat already moved to cancelling', () => {
    const status: SessionStatus = { state: 'cancelling', authenticated: true, browserReady: true };
    const result = applyAgentEvent(
      status,
      event({
        type: 'tool.result',
        toolCallId: 'call-1',
        outcome: { ok: true, data: {} },
        sequence: 9,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.from).toBe('cancelling');
      expect(result.error.to).toBe('streaming');
    }
  });
});

describe('canSendMessage', () => {
  it('blocks when the session is closed, regardless of auth/browser readiness', () => {
    const result = canSendMessage({ state: 'closed', authenticated: true, browserReady: true });
    expect(result).toEqual({ canSend: false, reason: 'session_closed' });
  });

  it('blocks when the user is not authenticated, even if idle and the browser is ready', () => {
    const result = canSendMessage({ state: 'idle', authenticated: false, browserReady: true });
    expect(result).toEqual({ canSend: false, reason: 'not_authenticated' });
  });

  it('allows sending when the browser is not ready - the composer is not gated on it (requirements-decisions.md section 3 is about the tool bridge, not the composer)', () => {
    const result = canSendMessage({ state: 'idle', authenticated: true, browserReady: false });
    expect(result).toEqual({ canSend: true });
  });

  it('blocks with turn_in_progress while already streaming, even if the browser is not ready too', () => {
    const result = canSendMessage({ state: 'streaming', authenticated: true, browserReady: false });
    expect(result).toEqual({ canSend: false, reason: 'turn_in_progress' });
  });

  it('blocks with session_error while the session is in the error state', () => {
    const result = canSendMessage({ state: 'error', authenticated: true, browserReady: true });
    expect(result).toEqual({ canSend: false, reason: 'session_error' });
  });

  it('allows sending when idle, authenticated, and the browser is ready', () => {
    const result = canSendMessage({ state: 'idle', authenticated: true, browserReady: true });
    expect(result).toEqual({ canSend: true });
  });
});

describe('canRunAemTool', () => {
  it.each([
    ['idle', true],
    ['sending', true],
    ['streaming', true],
    ['runningTool', true],
    ['cancelling', false],
    ['error', false],
    ['closed', false],
  ] as const)(
    'with browserReady=true and authenticated=true, state %s reports canRun=%s',
    (state, expectedCanRun) => {
      const result = canRunAemTool({ state, authenticated: true, browserReady: true });
      expect(result.canRun).toBe(expectedCanRun);
    },
  );

  it('blocks when the session is closed', () => {
    const result = canRunAemTool({ state: 'closed', authenticated: true, browserReady: true });
    expect(result).toEqual({ canRun: false, reason: 'session_closed' });
  });

  it('blocks with its own reason while cancelling, distinct from session_closed - cancelling is transient teardown of in-flight AEM work (requirements-decisions.md line 167, lines 200-201), not the end of the session', () => {
    const result = canRunAemTool({ state: 'cancelling', authenticated: true, browserReady: true });
    expect(result).toEqual({ canRun: false, reason: 'cancelling' });
  });

  it('does not permit a new AEM request to start while cancelling, even though browserReady is true - this is the regression the orchestrator caught', () => {
    const status: SessionStatus = { state: 'cancelling', authenticated: true, browserReady: true };
    expect(canRunAemTool(status).canRun).toBe(false);
  });

  it('blocks with session_error while the session is in the error state, symmetrically with canSendMessage', () => {
    const result = canRunAemTool({ state: 'error', authenticated: true, browserReady: true });
    expect(result).toEqual({ canRun: false, reason: 'session_error' });
  });

  it('blocks when the browser is not ready, even though canSendMessage would allow sending in the same status', () => {
    const status: SessionStatus = { state: 'idle', authenticated: true, browserReady: false };
    expect(canRunAemTool(status)).toEqual({ canRun: false, reason: 'browser_not_ready' });
    expect(canSendMessage(status)).toEqual({ canSend: true });
  });

  it("is unaffected by authentication while streaming - only the bridge's own readiness and the cancelling/error/closed states matter", () => {
    const result = canRunAemTool({ state: 'streaming', authenticated: false, browserReady: true });
    expect(result).toEqual({ canRun: true });
  });

  it('allows the tool call when the session is open and the browser is ready', () => {
    const result = canRunAemTool({ state: 'idle', authenticated: true, browserReady: true });
    expect(result).toEqual({ canRun: true });
  });
});
