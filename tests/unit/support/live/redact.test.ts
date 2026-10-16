import { describe, expect, it } from 'vitest';
import {
  isSensitiveKey,
  REDACTED,
  redactJsonl,
  redactText,
  redactValue,
} from '../../../support/live/redact';

// Fake secrets, long enough to match the token shapes; none is a real credential.
const GH_TOKEN = `ghp_${'a1B2c3D4e5'.repeat(3)}`;
const OPENROUTER_KEY = `sk-or-v1-${'0123456789abcdef'.repeat(2)}`;
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl';

describe('redactText', () => {
  it.each([
    ['a bearer token', 'Authorization: Bearer abcdef1234567890xyz'],
    ['a bearer token outside a header', 'sent bearer abcdef1234567890xyz upstream'],
    ['a basic authorization header', 'authorization: Basic dXNlcjpwYXNz'],
    [
      'an escaped JSON authorization',
      String.raw`{\"authorization\":\"Bearer abcdef1234567890xyz\"}`,
    ],
    ['a cookie header', 'Cookie: login-token=abc123; sessionid=zzz999'],
    ['a set-cookie header', 'Set-Cookie: login-token=abc123; Path=/'],
    ['a quoted key', '{"password":"hunter2-hunter2"}'],
    ['a single-quoted key', "password: 'hunter2-hunter2'"],
    ['an escaped quoted key', String.raw`{\"accessToken\":\"hunter2-hunter2\"}`],
    ['a bare key', 'password=hunter2-hunter2&x=1'],
    ['a GitHub token', `using ${GH_TOKEN} here`],
    ['an OpenRouter key', `key ${OPENROUTER_KEY}`],
    ['a JWT', `jwt ${JWT}`],
    ['URL userinfo', 'https://admin:hunter2-hunter2@author.example.com/x'],
  ])('removes %s', (_name, input) => {
    const output = redactText(input);
    expect(output).toContain(REDACTED);
    for (const secret of [
      'abcdef1234567890xyz',
      'dXNlcjpwYXNz',
      'abc123',
      'zzz999',
      'hunter2-hunter2',
      GH_TOKEN,
      OPENROUTER_KEY,
      JWT,
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it('keeps the surrounding structure readable', () => {
    expect(redactText('https://admin:hunter2-hunter2@author.example.com/x')).toContain(
      'author.example.com/x',
    );
  });

  it('leaves ordinary text and token counts alone', () => {
    const text = 'inputTokens: 120, outputTokens=34 for /content/site/page.html';
    expect(redactText(text)).toBe(text);
  });
});

describe('isSensitiveKey', () => {
  it.each(['token', 'accessToken', 'x-api-key', 'Set-Cookie', 'secretRef', 'Authorization'])(
    'flags %s',
    (key) => {
      expect(isSensitiveKey(key)).toBe(true);
    },
  );

  it.each(['inputTokens', 'outputTokens', 'path', 'tokenCount'])('does not flag %s', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('redactValue', () => {
  it('blanks the value of a sensitive key at any depth, keeping the rest', () => {
    const output = redactValue({
      agents: [{ id: 'copilot', token: { kind: 'stored', value: 'hunter2' }, model: 'm' }],
      inputTokens: 5,
    });
    expect(output).toEqual({
      agents: [{ id: 'copilot', token: REDACTED, model: 'm' }],
      inputTokens: 5,
    });
  });

  it('redacts secrets inside string values', () => {
    expect(JSON.stringify(redactValue({ note: `using ${GH_TOKEN}` }))).not.toContain(GH_TOKEN);
  });

  it('keeps null and numbers', () => {
    expect(redactValue({ token: null, n: 1 })).toEqual({ token: null, n: 1 });
  });
});

describe('redactJsonl', () => {
  it('keeps every line parseable even when a cookie header sits inside a string', () => {
    const lines = [
      JSON.stringify({ a: 1, body: 'Cookie: login-token=abc123; x=y', after: 'kept' }),
      JSON.stringify({ n: 2 }),
    ];
    const output = redactJsonl(`${lines.join('\n')}\n`);
    const parsed = output
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.['after']).toBe('kept');
    expect(output).not.toContain('abc123');
  });

  it('redacts a line that is not JSON as text', () => {
    expect(redactJsonl(`password=hunter2-hunter2`)).not.toContain('hunter2');
  });

  it('keeps blank lines and the trailing newline', () => {
    expect(redactJsonl('{"n":1}\n')).toBe('{"n":1}\n');
  });
});
