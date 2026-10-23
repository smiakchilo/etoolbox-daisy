import { describe, expect, it, vi } from 'vitest';
import { decideCredentialCapture } from '../../../../src/main/credentials/capture';

/**
 * The origin decision that makes capture safe: a page cannot choose which
 * origin its password is stored under, because the origin comes from the
 * sending frame and from nowhere else.
 */

const noFallback = (): undefined => undefined;

describe('decideCredentialCapture', () => {
  it('stores the pair for the sending frame origin', () => {
    expect(
      decideCredentialCapture(
        {
          url: 'https://author.example.com/libs/granite/core/content/login.html',
          isMainFrame: true,
        },
        { username: 'admin', password: 'secret' },
        noFallback,
      ),
    ).toEqual({
      kind: 'store',
      origin: 'https://author.example.com',
      username: 'admin',
      password: 'secret',
    });
  });

  it('ignores a subframe, so an embedded form is not attributed to the page around it', () => {
    expect(
      decideCredentialCapture(
        { url: 'https://author.example.com/', isMainFrame: false },
        { username: 'admin', password: 'secret' },
        noFallback,
      ),
    ).toEqual({ kind: 'ignore', reason: 'not_main_frame' });
  });

  it('ignores a frame whose URL is not http(s)', () => {
    for (const url of ['file:///c:/app/index.html', 'about:blank', 'not a url']) {
      expect(
        decideCredentialCapture(
          { url, isMainFrame: true },
          { username: 'a', password: 'b' },
          noFallback,
        ),
      ).toEqual({ kind: 'ignore', reason: 'not_http' });
    }
  });

  it('ignores a malformed payload', () => {
    for (const payload of [
      { username: 'admin' },
      { password: 'secret' },
      { username: '', password: '' },
      { username: 'admin', password: 'x'.repeat(2000) },
      { username: 'admin', password: 'secret', origin: 'https://evil.example.com' },
      'nonsense',
    ]) {
      expect(
        decideCredentialCapture(
          { url: 'https://author.example.com/', isMainFrame: true },
          payload,
          noFallback,
        ),
      ).toEqual({ kind: 'ignore', reason: 'invalid_payload' });
    }
  });

  it("falls back to the origin's newest username for an identity provider's password step", () => {
    expect(
      decideCredentialCapture(
        { url: 'https://login.example.com/passwd', isMainFrame: true },
        { username: '', password: 'secret' },
        (origin) => (origin === 'https://login.example.com' ? 'someone@example.com' : undefined),
      ),
    ).toEqual({
      kind: 'store',
      origin: 'https://login.example.com',
      username: 'someone@example.com',
      password: 'secret',
    });
  });

  it('ignores a capture with no username anywhere', () => {
    expect(
      decideCredentialCapture(
        { url: 'https://author.example.com/', isMainFrame: true },
        { username: '  ', password: 'secret' },
        noFallback,
      ),
    ).toEqual({ kind: 'ignore', reason: 'no_username' });
  });

  it('never trusts an origin-shaped field in the payload', () => {
    const decision = decideCredentialCapture(
      { url: 'https://author.example.com/', isMainFrame: true },
      { username: 'admin', password: 'secret', origin: 'https://evil.example.com' },
      noFallback,
    );
    expect(decision.kind).toBe('ignore');
  });

  it('does not call the fallback when the payload carries a username', () => {
    const fallback = vi.fn(() => 'from-store');
    decideCredentialCapture(
      { url: 'https://author.example.com/', isMainFrame: true },
      { username: 'admin', password: 'secret' },
      fallback,
    );
    expect(fallback).not.toHaveBeenCalled();
  });
});
