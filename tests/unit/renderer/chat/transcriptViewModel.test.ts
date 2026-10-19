import { describe, expect, it } from 'vitest';
import {
  describeInterruption,
  describeRequiredAction,
  describeToolCallStatus,
  isDeterministicTablePrompt,
  latestReasoningLine,
  splitLeadingSkill,
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
  it('describes every labelled status with distinct, non-empty text', () => {
    const statuses: readonly ToolCallStatus[] = [
      { kind: 'requested' },
      { kind: 'approved' },
      { kind: 'rejected', reason: 'no' },
      { kind: 'succeeded', data: null },
      { kind: 'failed', error: toolError() },
      { kind: 'abandoned' },
    ];
    const descriptions = statuses.map((status) => describeToolCallStatus(status));
    for (const description of descriptions) {
      expect(description ?? '').not.toBe('');
    }
    expect(new Set(descriptions).size).toBe(statuses.length);
  });

  it('shows no status word for a call the turn was waiting on the user for', () => {
    // Nothing was in flight while the question was on screen, so calling it
    // "Interrupted" would be a lie; the billet shows only the tool name.
    expect(describeToolCallStatus({ kind: 'abandonedAwaitingInput' })).toBeUndefined();
  });

  it('distinguishes a failed status from a succeeded one', () => {
    // implementation-plan.md step 07: a failed tool call must be visually
    // and structurally distinguishable from a completed one.
    expect(describeToolCallStatus({ kind: 'failed', error: toolError() })).not.toBe(
      describeToolCallStatus({ kind: 'succeeded', data: null }),
    );
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

describe('latestReasoningLine', () => {
  it('returns "" for empty or whitespace-only input', () => {
    expect(latestReasoningLine('')).toBe('');
    expect(latestReasoningLine('   \n  \n ')).toBe('');
  });

  it('returns the only line when the reasoning has no line break', () => {
    expect(latestReasoningLine('a single thought')).toBe('a single thought');
  });

  it('returns the last non-empty line, so the reader sees the newest thought', () => {
    expect(latestReasoningLine('first\nsecond\nthird')).toBe('third');
    // A trailing newline must not produce an empty rolling line.
    expect(latestReasoningLine('first\nsecond\n')).toBe('second');
  });

  it('trims each line before choosing the last one', () => {
    expect(latestReasoningLine('first\n   second   ')).toBe('second');
  });
});

describe('describeInterruption', () => {
  it('words each interruption cause with distinct, non-empty text', () => {
    const stopped = describeInterruption('stopped');
    const navigation = describeInterruption('navigation');

    expect(stopped.length).toBeGreaterThan(0);
    expect(navigation.length).toBeGreaterThan(0);
    expect(stopped).not.toBe(navigation);
  });
});

describe('splitLeadingSkill', () => {
  it('splits a leading known skill token from the rest of the prompt', () => {
    expect(splitLeadingSkill('/search Waldo', ['search'])).toEqual({
      leading: '/search',
      trailing: ' Waldo',
      skill: true,
    });
  });

  it('treats a skill with no trailing text as a skill with an empty tail', () => {
    expect(splitLeadingSkill('/search', ['search'])).toEqual({
      leading: '/search',
      trailing: '',
      skill: true,
    });
  });

  it('leaves a leading token that names no known skill as plain text', () => {
    expect(splitLeadingSkill('/content/wknd', ['search'])).toEqual({
      leading: '',
      trailing: '/content/wknd',
      skill: false,
    });
  });

  it('leaves an ordinary prompt untouched', () => {
    expect(splitLeadingSkill('search for Waldo', ['search'])).toEqual({
      leading: '',
      trailing: 'search for Waldo',
      skill: false,
    });
  });

  it('does not treat leading whitespace before the slash as a skill reference', () => {
    expect(splitLeadingSkill(' /search Waldo', ['search'])).toEqual({
      leading: '',
      trailing: ' /search Waldo',
      skill: false,
    });
  });
});

describe('isDeterministicTablePrompt', () => {
  it('recognises the search skills, with or without trailing text', () => {
    expect(isDeterministicTablePrompt('/search waldo')).toBe(true);
    expect(isDeterministicTablePrompt('/search')).toBe(true);
    expect(isDeterministicTablePrompt('/semantic-search good waldo')).toBe(true);
    expect(isDeterministicTablePrompt('/search-component LM Content Block')).toBe(true);
    expect(isDeterministicTablePrompt('/search-page Generic Page')).toBe(true);
  });

  it('does not suppress any other prompt', () => {
    expect(isDeterministicTablePrompt('search for waldo')).toBe(false);
    expect(isDeterministicTablePrompt('/other-skill x')).toBe(false);
    expect(isDeterministicTablePrompt('plain question')).toBe(false);
  });
});
