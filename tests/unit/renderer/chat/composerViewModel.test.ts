import { describe, expect, it } from 'vitest';
import {
  buildActionAnswer,
  buildAskUserAnswer,
  buildNoAnswer,
  computeComposerButtonState,
  describeCanSendBlockReason,
  isActionsRequest,
  isAskUserAnswerComplete,
  isTurnInFlight,
  shouldSubmitOnEnter,
  type AskUserDraft,
  type ComposerStatus,
} from '../../../../src/renderer/src/chat/composerViewModel';
import type { SessionStatus, UserInputRequest } from '../../../../src/shared';

function session(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return { state: 'idle', authenticated: true, browserReady: true, ...overrides };
}

function status(overrides: Partial<ComposerStatus> = {}): ComposerStatus {
  return { serviceState: 'ready', session: session(), agentActive: true, ...overrides };
}

describe('computeComposerButtonState', () => {
  it("shows 'connecting' whenever serviceState is 'starting', regardless of session state", () => {
    const result = computeComposerButtonState(
      status({ serviceState: 'starting', session: session({ state: 'idle' }) }),
    );
    expect(result).toEqual({ kind: 'connecting' });
  });

  it("does not conflate 'starting' with 'not authenticated': a merely-early user gets 'connecting', not a sign-in prompt", () => {
    const result = computeComposerButtonState(
      status({ serviceState: 'starting', session: session({ authenticated: false }) }),
    );
    expect(result).toEqual({ kind: 'connecting' });
  });

  describe("a restored conversation still resuming ('resuming')", () => {
    it("shows 'connecting' while the session is being resumed", () => {
      const result = computeComposerButtonState(status({ resuming: true }));
      expect(result).toEqual({ kind: 'connecting' });
    });

    it("outranks a would-be 'send-enabled': an idle, authenticated session is not sendable until the resume settles", () => {
      const result = computeComposerButtonState(
        status({ resuming: true, session: session({ state: 'idle', authenticated: true }) }),
      );
      expect(result).toEqual({ kind: 'connecting' });
    });

    it("'unavailable' still outranks 'resuming' (no agent at all)", () => {
      const result = computeComposerButtonState(
        status({ serviceState: 'unavailable', resuming: true }),
      );
      expect(result).toEqual({ kind: 'unavailable' });
    });

    it("an absent/false 'resuming' leaves the ordinary gate in charge", () => {
      expect(computeComposerButtonState(status({ session: session({ state: 'idle' }) }))).toEqual({
        kind: 'send-enabled',
      });
      expect(
        computeComposerButtonState(
          status({ resuming: false, session: session({ state: 'idle' }) }),
        ),
      ).toEqual({ kind: 'send-enabled' });
    });
  });

  describe('a turn in flight always shows Stop once the service is ready', () => {
    for (const state of ['sending', 'streaming', 'runningTool', 'cancelling'] as const) {
      it(`shows 'stop' for session state "${state}"`, () => {
        const result = computeComposerButtonState(status({ session: session({ state }) }));
        expect(result).toEqual({ kind: 'stop' });
      });
    }

    it("shows 'stop' even when authenticated reads false mid-turn, not a confusing 'not authenticated' block", () => {
      // The in-flight check must run BEFORE canSendMessage - see
      // composerViewModel.ts's doc comment on why. This is the discriminating
      // assertion for that ordering.
      const result = computeComposerButtonState(
        status({ session: session({ state: 'streaming', authenticated: false }) }),
      );
      expect(result).toEqual({ kind: 'stop' });
    });
  });

  describe("an automatic reflection in flight ('reflecting')", () => {
    for (const state of ['sending', 'streaming', 'runningTool'] as const) {
      it(`keeps Send for session state "${state}", so the user is never made to stop it`, () => {
        const result = computeComposerButtonState(
          status({ reflecting: true, session: session({ state }) }),
        );
        expect(result).toEqual({ kind: 'send-enabled' });
      });
    }

    it("shows 'agent-inactive' when no agent is active", () => {
      const result = computeComposerButtonState(
        status({ reflecting: true, agentActive: false, session: session({ state: 'streaming' }) }),
      );
      expect(result).toEqual({ kind: 'agent-inactive' });
    });

    it('a stale flag on a turn that is not running changes nothing', () => {
      const result = computeComposerButtonState(
        status({ reflecting: true, session: session({ state: 'error' }) }),
      );
      expect(result).toEqual({ kind: 'send-disabled', reason: 'session_error' });
    });
  });

  it("shows 'send-enabled' when idle and authenticated", () => {
    const result = computeComposerButtonState(status({ session: session({ state: 'idle' }) }));
    expect(result).toEqual({ kind: 'send-enabled' });
  });

  it("shows 'send-disabled' with reason 'session_closed' for a closed session", () => {
    const result = computeComposerButtonState(status({ session: session({ state: 'closed' }) }));
    expect(result).toEqual({ kind: 'send-disabled', reason: 'session_closed' });
  });

  it("shows 'send-disabled' with reason 'not_authenticated' when idle but signed out", () => {
    const result = computeComposerButtonState(
      status({ session: session({ state: 'idle', authenticated: false }) }),
    );
    expect(result).toEqual({ kind: 'send-disabled', reason: 'not_authenticated' });
  });

  it("shows 'send-disabled' with reason 'session_error' after an error", () => {
    const result = computeComposerButtonState(status({ session: session({ state: 'error' }) }));
    expect(result).toEqual({ kind: 'send-disabled', reason: 'session_error' });
  });

  describe("no usable agent selected ('agent-inactive')", () => {
    it("shows 'agent-inactive' when idle but no agent is active", () => {
      const result = computeComposerButtonState(
        status({ agentActive: false, session: session({ state: 'idle' }) }),
      );
      expect(result).toEqual({ kind: 'agent-inactive' });
    });

    it("still shows 'stop' for a turn already in flight when no agent is active", () => {
      // The in-flight check runs first, so a running turn can always be stopped
      // even if the agent's sign-in dropped mid-turn.
      const result = computeComposerButtonState(
        status({ agentActive: false, session: session({ state: 'streaming' }) }),
      );
      expect(result).toEqual({ kind: 'stop' });
    });

    it("'connecting' outranks 'agent-inactive' while the service is still starting", () => {
      const result = computeComposerButtonState(
        status({ serviceState: 'starting', agentActive: false }),
      );
      expect(result).toEqual({ kind: 'connecting' });
    });
  });
});

describe('isTurnInFlight', () => {
  it('is true exactly for the four in-flight states the composer shows Stop for', () => {
    for (const state of ['sending', 'streaming', 'runningTool', 'cancelling'] as const) {
      expect(isTurnInFlight(state)).toBe(true);
    }
    for (const state of ['idle', 'error', 'closed'] as const) {
      expect(isTurnInFlight(state)).toBe(false);
    }
  });
});

describe('describeCanSendBlockReason', () => {
  it('describes every reason with distinct, non-empty text', () => {
    const reasons = [
      'session_closed',
      'not_authenticated',
      'session_error',
      'turn_in_progress',
    ] as const;
    const descriptions = reasons.map((reason) => describeCanSendBlockReason(reason));
    for (const description of descriptions) {
      expect(description.length).toBeGreaterThan(0);
    }
    expect(new Set(descriptions).size).toBe(reasons.length);
  });
});

describe('shouldSubmitOnEnter', () => {
  function enter(overrides: Partial<Parameters<typeof shouldSubmitOnEnter>[0]> = {}) {
    return {
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      isComposing: false,
      ...overrides,
    };
  }

  it('submits on a plain Enter press', () => {
    expect(shouldSubmitOnEnter(enter())).toBe(true);
  });

  it('does not submit on any modified Enter (inserts a newline instead)', () => {
    expect(shouldSubmitOnEnter(enter({ shiftKey: true }))).toBe(false);
    expect(shouldSubmitOnEnter(enter({ ctrlKey: true }))).toBe(false);
    expect(shouldSubmitOnEnter(enter({ altKey: true }))).toBe(false);
    expect(shouldSubmitOnEnter(enter({ metaKey: true }))).toBe(false);
  });

  it('does not submit on Enter while an IME composition is active', () => {
    // The named plan requirement: Enter during composition must never send.
    expect(shouldSubmitOnEnter(enter({ isComposing: true }))).toBe(false);
  });

  it('does not submit on a modified Enter while composing either', () => {
    expect(shouldSubmitOnEnter(enter({ shiftKey: true, isComposing: true }))).toBe(false);
    expect(shouldSubmitOnEnter(enter({ ctrlKey: true, isComposing: true }))).toBe(false);
  });

  it('does not submit on a non-Enter key', () => {
    expect(shouldSubmitOnEnter(enter({ key: 'a' }))).toBe(false);
  });
});

describe('ask-user answer completeness', () => {
  const request = (overrides: Partial<UserInputRequest> = {}): UserInputRequest => ({
    question: 'Q',
    options: ['A', 'B', 'C'],
    multiple: false,
    freeInput: false,
    ...overrides,
  });
  const draft = (overrides: Partial<AskUserDraft> = {}): AskUserDraft => ({
    selections: [],
    freeform: '',
    freeInputActive: false,
    ...overrides,
  });

  it('requires exactly one selection for a single-choice question', () => {
    expect(isAskUserAnswerComplete(request(), draft({ selections: [] }))).toBe(false);
    expect(isAskUserAnswerComplete(request(), draft({ selections: ['A'] }))).toBe(true);
    expect(isAskUserAnswerComplete(request(), draft({ selections: ['A', 'B'] }))).toBe(false);
  });

  it('requires at least one selection for a multiple-choice question', () => {
    expect(isAskUserAnswerComplete(request({ multiple: true }), draft())).toBe(false);
    expect(
      isAskUserAnswerComplete(request({ multiple: true }), draft({ selections: ['A', 'B'] })),
    ).toBe(true);
  });

  it('requires non-whitespace text when free input is active or the question is free-input-only', () => {
    expect(
      isAskUserAnswerComplete(request({ freeInput: true }), draft({ freeInputActive: true })),
    ).toBe(false);
    expect(
      isAskUserAnswerComplete(
        request({ freeInput: true }),
        draft({ freeInputActive: true, freeform: '  x ' }),
      ),
    ).toBe(true);
    expect(isAskUserAnswerComplete(request({ options: undefined }), draft())).toBe(false);
    expect(isAskUserAnswerComplete(request({ options: undefined }), draft({ freeform: 'y' }))).toBe(
      true,
    );
  });

  it('builds a selection answer, or the trimmed free text when free input wins', () => {
    expect(
      buildAskUserAnswer(request({ multiple: true }), draft({ selections: ['A', 'B'] })),
    ).toEqual({
      selections: ['A', 'B'],
      freeform: null,
    });
    expect(
      buildAskUserAnswer(
        request({ freeInput: true }),
        draft({ freeInputActive: true, freeform: ' hi ' }),
      ),
    ).toEqual({ selections: [], freeform: 'hi' });
    expect(
      buildAskUserAnswer(request({ options: undefined }), draft({ freeform: 'typed' })),
    ).toEqual({
      selections: [],
      freeform: 'typed',
    });
  });
});

describe('ask-user actions', () => {
  const request = (overrides: Partial<UserInputRequest> = {}): UserInputRequest => ({
    actions: ['Load more'],
    multiple: false,
    freeInput: false,
    ...overrides,
  });

  it('recognises an actions request and no other', () => {
    expect(isActionsRequest(request())).toBe(true);
    expect(
      isActionsRequest({ question: 'Q', options: ['A'], multiple: false, freeInput: false }),
    ).toBe(false);
  });

  it('is never "complete" - an action answers directly, it is not submitted', () => {
    expect(
      isAskUserAnswerComplete(request(), { selections: [], freeform: '', freeInputActive: false }),
    ).toBe(false);
  });

  it('builds the action label as the sole selection with no freeform', () => {
    expect(buildActionAnswer('Load more')).toEqual({ selections: ['Load more'], freeform: null });
  });

  it('builds the cancel as an explicit "no answer" - empty selections and no freeform', () => {
    expect(buildNoAnswer()).toEqual({ selections: [], freeform: null });
  });
});
