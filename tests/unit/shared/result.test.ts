import { describe, expect, it } from 'vitest';
import { err, isOk, ok, unwrap } from '../../../src/shared/result';

describe('Result helper', () => {
  it('wraps a success value so isOk narrows and unwrap returns it', () => {
    const result = ok(42);
    expect(isOk(result)).toBe(true);
    expect(unwrap(result)).toBe(42);
  });

  it('wraps an error value so isOk reports false', () => {
    const result = err('boom');
    expect(isOk(result)).toBe(false);
  });

  it('throws with the error payload when unwrap() is called on an error result', () => {
    const result = err('boom');
    expect(() => unwrap(result)).toThrow(/boom/);
  });
});
