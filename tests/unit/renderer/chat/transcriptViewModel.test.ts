import { describe, expect, it } from 'vitest';
import {
  describeRequiredAction,
  describeToolCallStatus,
} from '../../../../src/renderer/src/chat/transcriptViewModel';
import type { ToolCallStatus } from '../../../../src/renderer/src/chat/transcriptStore';
import { REQUIRED_ACTIONS, requestIdSchema, type ToolError } from '../../../../src/shared';

const requestId = requestIdSchema.parse('req-1');

function toolError(overrides: Partial<ToolError> = {}): ToolError {
  return {
    code: 'NOT_FOUND',
    message: 'not found',
    requestId,
    retryable: false,
    requiredAction: 'none',
    ...overrides,
  };
}

describe('describeToolCallStatus', () => {
  it('describes every status with distinct, non-empty text', () => {
    const statuses: readonly ToolCallStatus[] = [
      { kind: 'requested' },
      { kind: 'approved' },
      { kind: 'rejected', reason: 'no' },
      { kind: 'succeeded', data: null },
      { kind: 'failed', error: toolError() },
    ];
    const descriptions = statuses.map((status) => describeToolCallStatus(status));
    for (const description of descriptions) {
      expect(description.length).toBeGreaterThan(0);
    }
    expect(new Set(descriptions).size).toBe(statuses.length);
  });

  it("labels a failed status literally 'FAILED', distinct from a succeeded 'Completed'", () => {
    // implementation-plan.md step 07: a failed tool call must be visually
    // and structurally distinguishable from a completed one.
    expect(describeToolCallStatus({ kind: 'failed', error: toolError() })).toBe('FAILED');
    expect(describeToolCallStatus({ kind: 'succeeded', data: null })).not.toBe('FAILED');
  });
});

describe('describeRequiredAction', () => {
  it("returns undefined for 'none' (nothing for the user to do)", () => {
    expect(describeRequiredAction('none')).toBeUndefined();
  });

  it('returns distinct, non-empty guidance text for every other required action', () => {
    const actionable = REQUIRED_ACTIONS.filter((action) => action !== 'none');
    const descriptions = actionable.map((action) => describeRequiredAction(action));
    for (const description of descriptions) {
      expect(description).toBeDefined();
      expect(description?.length).toBeGreaterThan(0);
    }
    expect(new Set(descriptions).size).toBe(actionable.length);
  });
});
