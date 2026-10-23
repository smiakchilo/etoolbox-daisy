import { describe, expect, it, vi } from 'vitest';
import {
  createHostLoginListener,
  hostAuthOrigin,
  type HostAuthChallenge,
} from '../../../../src/main/credentials/hostAuth';

/**
 * Host (origin) authentication from the vault. The property under test is the
 * match: a challenge is answered only for the origin whose credential is
 * stored, and never for the proxy or for a different scheme/port.
 */

function challenge(overrides: Partial<HostAuthChallenge> = {}): HostAuthChallenge {
  return { isProxy: false, host: 'author.example.com', port: 4502, scheme: 'basic', ...overrides };
}

describe('hostAuthOrigin', () => {
  it('names the origin of the URL that produced the challenge', () => {
    expect(hostAuthOrigin('http://author.example.com:4502/content/page.html', challenge())).toBe(
      'http://author.example.com:4502',
    );
  });

  it('compares effective ports, so a default port spelled out still matches', () => {
    expect(hostAuthOrigin('https://author.example.com/content', challenge({ port: 443 }))).toBe(
      'https://author.example.com',
    );
    expect(hostAuthOrigin('http://author.example.com/', challenge({ port: 80 }))).toBe(
      'http://author.example.com',
    );
  });

  it('refuses a proxy challenge', () => {
    expect(
      hostAuthOrigin('http://author.example.com:4502/', challenge({ isProxy: true })),
    ).toBeUndefined();
  });

  it('refuses a challenge whose scheme does not take a password', () => {
    expect(
      hostAuthOrigin('http://author.example.com:4502/', challenge({ scheme: 'negotiate' })),
    ).toBeUndefined();
    expect(
      hostAuthOrigin('http://author.example.com:4502/', challenge({ scheme: 'unknown' })),
    ).toBeUndefined();
  });

  it('answers basic, digest and ntlm alike', () => {
    for (const scheme of ['basic', 'digest', 'ntlm', 'BASIC']) {
      expect(hostAuthOrigin('http://author.example.com:4502/', challenge({ scheme }))).toBe(
        'http://author.example.com:4502',
      );
    }
  });

  it('refuses a port that does not match the challenge', () => {
    expect(hostAuthOrigin('http://author.example.com:4503/', challenge())).toBeUndefined();
  });

  it('refuses a host that does not match the challenge', () => {
    expect(hostAuthOrigin('http://other.example.com:4502/', challenge())).toBeUndefined();
  });

  it('refuses a URL it cannot read a scheme from rather than guessing one', () => {
    expect(hostAuthOrigin(undefined, challenge())).toBeUndefined();
    expect(hostAuthOrigin('not a url', challenge())).toBeUndefined();
    expect(hostAuthOrigin('file:///c:/x', challenge())).toBeUndefined();
  });
});

describe('createHostLoginListener', () => {
  function harness(lookup: (origin: string) => { username: string; password: string } | undefined) {
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn<(username?: string, password?: string) => void>();
    const listener = createHostLoginListener({ lookup });
    return { event, callback, listener };
  }

  it('supplies the stored credential for the challenged origin', () => {
    const { event, callback, listener } = harness((origin) =>
      origin === 'http://author.example.com:4502'
        ? { username: 'admin', password: 'secret' }
        : undefined,
    );

    listener(
      event,
      undefined,
      { url: 'http://author.example.com:4502/content/page.html' },
      challenge(),
      callback,
    );

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith('admin', 'secret');
  });

  it('declines a proxy challenge without touching preventDefault or the callback', () => {
    const { event, callback, listener } = harness(() => ({
      username: 'admin',
      password: 'secret',
    }));

    listener(
      event,
      undefined,
      { url: 'http://author.example.com:4502/' },
      challenge({ isProxy: true }),
      callback,
    );

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('declines an origin with no saved credential', () => {
    const { event, callback, listener } = harness(() => undefined);

    listener(event, undefined, { url: 'http://author.example.com:4502/' }, challenge(), callback);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('declines a challenge with no request URL, rather than guessing a scheme', () => {
    const { event, callback, listener } = harness(() => ({
      username: 'admin',
      password: 'secret',
    }));

    listener(event, undefined, undefined, challenge(), callback);

    expect(callback).not.toHaveBeenCalled();
  });

  it('answers with the http origin’s credential only for http', () => {
    const { event, callback, listener } = harness((origin) =>
      origin === 'http://author.example.com:4502'
        ? { username: 'admin', password: 'secret' }
        : undefined,
    );

    listener(event, undefined, { url: 'https://author.example.com:4502/' }, challenge(), callback);

    expect(callback).not.toHaveBeenCalled();
  });
});
