import { describe, expect, it } from 'vitest';
import {
  computeComposerButtonState,
  describeCanSendBlockReason,
  shouldSubmitOnEnter,
  type ComposerStatus,
} from '../../../../src/renderer/src/chat/composerViewModel';
import type { SessionStatus } from '../../../../src/shared';

function session(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return { state: 'idle', authenticated: true, browserReady: true, ...overrides };
}

function status(overrides: Partial<ComposerStatus> = {}): ComposerStatus {
  return { serviceState: 'ready', session: session(), ...overrides };
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
  it('submits on a plain Enter press', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true);
  });

  it('does not submit on Shift+Enter (inserts a newline instead)', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false);
  });

  it('does not submit on Enter while an IME composition is active', () => {
    // The named plan requirement: Enter during composition must never send.
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
  });

  it('does not submit on Shift+Enter while composing either', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: true, isComposing: true })).toBe(false);
  });

  it('does not submit on a non-Enter key', () => {
    expect(shouldSubmitOnEnter({ key: 'a', shiftKey: false, isComposing: false })).toBe(false);
  });
});
