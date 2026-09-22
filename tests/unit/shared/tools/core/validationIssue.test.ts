import { describe, expect, it } from 'vitest';
import { firstIssueMessage } from '../../../../../src/shared/tools/core/validationIssue';

/**
 * Unit tests for `src/shared/tools/core/validationIssue.ts` - the renderer that
 * turns a zod issue into the single line a model sees in a tool error.
 *
 * The property that matters is that the offending field is named: zod's own
 * message says only what kind of failure occurred ("expected string, received
 * number"), so the path prefix is the entire reason this helper exists.
 */
describe('firstIssueMessage', () => {
  it('prefixes the issue path so the offending field is named', () => {
    const message = firstIssueMessage(
      [
        {
          path: ['predicates', 'limit'],
          message: 'Invalid input: expected string, received number',
        },
      ],
      'fallback',
    );
    expect(message).toBe('predicates.limit: Invalid input: expected string, received number');
  });

  it('renders a path-less issue as its bare message', () => {
    expect(firstIssueMessage([{ path: [], message: 'Unrecognized key: x' }], 'fallback')).toBe(
      'Unrecognized key: x',
    );
  });

  it('renders an issue without a path property as its bare message', () => {
    expect(firstIssueMessage([{ message: 'bad' }], 'fallback')).toBe('bad');
  });

  it('falls back when there is no first issue', () => {
    expect(firstIssueMessage([], 'fallback')).toBe('fallback');
  });

  it('falls back when the first issue message is empty', () => {
    expect(firstIssueMessage([{ path: ['limit'], message: '' }], 'fallback')).toBe('fallback');
  });

  it('caps a pathological message', () => {
    const message = firstIssueMessage([{ path: ['limit'], message: 'x'.repeat(1000) }], 'fallback');
    expect(message.length).toBe(500);
  });
});
