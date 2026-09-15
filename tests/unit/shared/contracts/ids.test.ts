import { describe, expect, it } from 'vitest';
import {
  chatIdSchema,
  newChatId,
  newRequestId,
  newServerId,
  requestIdSchema,
  serverIdSchema,
  type IdGenerator,
} from '../../../../src/shared/contracts/ids';

/** Returns a generator yielding the supplied values in order, then throwing. */
function scriptedGenerator(...values: readonly string[]): IdGenerator {
  let index = 0;
  return () => {
    if (index >= values.length) throw new Error('scripted generator exhausted');
    return values[index++]!;
  };
}

describe('identifier schemas', () => {
  it('accepts an ordinary UUID, the shape production actually mints', () => {
    const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    expect(serverIdSchema.parse(uuid)).toBe(uuid);
  });

  it('rejects an empty identifier, which would silently correlate nothing', () => {
    expect(chatIdSchema.safeParse('').success).toBe(false);
  });

  it('rejects an identifier longer than 200 characters but accepts exactly 200', () => {
    expect(chatIdSchema.safeParse('a'.repeat(200)).success).toBe(true);
    expect(chatIdSchema.safeParse('a'.repeat(201)).success).toBe(false);
  });

  it.each([
    ['newline', 'abc\ndef'],
    ['carriage return', 'abc\rdef'],
    ['tab', 'abc\tdef'],
    ['NUL', 'abc\u0000def'],
    ['DEL', 'abc\u007fdef'],
    ['unit separator', 'abc\u001fdef'],
  ])('rejects an identifier containing a %s, which would corrupt log lines', (_label, value) => {
    expect(requestIdSchema.safeParse(value).success).toBe(false);
  });

  it('rejects surrounding whitespace so two ids differing only by padding cannot both exist', () => {
    expect(chatIdSchema.safeParse(' abc').success).toBe(false);
    expect(chatIdSchema.safeParse('abc ').success).toBe(false);
    expect(chatIdSchema.safeParse('a b').success).toBe(true);
  });

  it('accepts non-ASCII characters, which are not control characters', () => {
    expect(chatIdSchema.safeParse('chat-Ω-1').success).toBe(true);
  });

  it('rejects a non-string, since IPC payloads arrive as untrusted JSON', () => {
    expect(chatIdSchema.safeParse(42).success).toBe(false);
    expect(chatIdSchema.safeParse(null).success).toBe(false);
  });
});

describe('identifier minting', () => {
  it('returns the value the injected generator produced', () => {
    expect(newChatId(scriptedGenerator('chat-1'))).toBe('chat-1');
  });

  it('mints distinct values from successive calls to the same generator', () => {
    const generate = scriptedGenerator('a', 'b');
    expect(newServerId(generate)).not.toBe(newServerId(generate));
  });

  it('throws when the generator produces an invalid id rather than returning it', () => {
    expect(() => newRequestId(scriptedGenerator(''))).toThrow(/invalid requestId/);
    expect(() => newRequestId(scriptedGenerator('has\nnewline'))).toThrow(/control characters/);
  });

  it('names the identifier kind in the failure so the faulty call site is identifiable', () => {
    expect(() => newChatId(scriptedGenerator(''))).toThrow(/chatId/);
    expect(() => newServerId(scriptedGenerator(''))).toThrow(/serverId/);
  });
});
