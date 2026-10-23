import { describe, expect, it } from 'vitest';
import {
  credentialCaptureSchema,
  credentialsIpcResultSchema,
  parseCredentialsIpcResult,
} from '../../../src/shared';

/**
 * The saved-sign-ins contract: the renderer can only ever receive a count or an
 * error, and a capture payload cannot smuggle a field (an origin, most
 * importantly) into main.
 */

describe('credentialsIpcResultSchema', () => {
  it('parses an ok result', () => {
    expect(parseCredentialsIpcResult({ ok: true })).toEqual({ ok: true });
  });

  it('parses a typed error', () => {
    expect(
      parseCredentialsIpcResult({
        ok: false,
        error: { code: 'storage_error', message: 'nope' },
      }),
    ).toEqual({ ok: false, error: { code: 'storage_error', message: 'nope' } });
  });

  it.each([
    [{ ok: true, status: { count: 1 } }],
    [{ ok: true, extra: true }],
    [{ ok: false, error: { code: 'unknown', message: 'x' } }],
    [{ ok: false, error: { code: 'storage_error' } }],
    [{ ok: true, error: { code: 'storage_error', message: 'x' } }],
    ['ok'],
  ])('rejects %j', (candidate) => {
    expect(credentialsIpcResultSchema.safeParse(candidate).success).toBe(false);
  });
});

describe('credentialCaptureSchema', () => {
  it('accepts a username and a password, with an empty username allowed', () => {
    expect(credentialCaptureSchema.safeParse({ username: 'admin', password: 'x' }).success).toBe(
      true,
    );
    expect(credentialCaptureSchema.safeParse({ username: '', password: 'x' }).success).toBe(true);
  });

  it('rejects an empty password', () => {
    expect(credentialCaptureSchema.safeParse({ username: 'a', password: '' }).success).toBe(false);
  });

  it('rejects an oversized field', () => {
    expect(
      credentialCaptureSchema.safeParse({ username: 'a'.repeat(321), password: 'x' }).success,
    ).toBe(false);
    expect(
      credentialCaptureSchema.safeParse({ username: 'a', password: 'x'.repeat(1025) }).success,
    ).toBe(false);
  });

  it('rejects any field the payload does not define, such as a claimed origin', () => {
    expect(
      credentialCaptureSchema.safeParse({
        username: 'a',
        password: 'x',
        origin: 'https://evil.example.com',
      }).success,
    ).toBe(false);
  });
});
