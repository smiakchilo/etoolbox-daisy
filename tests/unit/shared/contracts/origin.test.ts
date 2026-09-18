import { describe, expect, it } from 'vitest';
import {
  parseOrigin,
  parseNavigationTarget,
  isCanonicalOrigin,
  originSchema,
  originsMatch,
} from '../../../../src/shared';

describe('parseOrigin', () => {
  it.each([
    ['https://author.example.com', 'https://author.example.com'],
    ['https://author.example.com/', 'https://author.example.com'],
    ['http://localhost:4502', 'http://localhost:4502'],
    ['http://localhost:4502/', 'http://localhost:4502'],
  ])('canonicalizes %s to %s', (input, expected) => {
    const result = parseOrigin(input);
    expect(result.ok && result.origin).toBe(expected);
  });

  it('lowercases the scheme and host so one server yields one stored string', () => {
    const result = parseOrigin('HTTPS://Author.Example.COM');
    expect(result.ok && result.origin).toBe('https://author.example.com');
  });

  it('drops a default port so the same server entered two ways compares equal', () => {
    expect(parseOrigin('https://a.example:443')).toEqual(parseOrigin('https://a.example'));
    expect(parseOrigin('http://a.example:80')).toEqual(parseOrigin('http://a.example'));
  });

  it('keeps a non-default port, which distinguishes author from publish', () => {
    const result = parseOrigin('http://localhost:4503');
    expect(result.ok && result.origin).toBe('http://localhost:4503');
  });

  it('trims surrounding whitespace from a pasted address', () => {
    const result = parseOrigin('  https://a.example  ');
    expect(result.ok && result.origin).toBe('https://a.example');
  });

  it.each([
    ['an empty string', '', 'malformed'],
    ['whitespace only', '   ', 'malformed'],
    ['a bare hostname with no scheme', 'author.example.com', 'malformed'],
    ['a file URL', 'file:///c:/temp', 'unsupported_scheme'],
    ['a javascript URL', 'javascript:alert(1)', 'unsupported_scheme'],
    ['an ftp URL', 'ftp://a.example', 'unsupported_scheme'],
    ['embedded credentials', 'https://user:pass@a.example', 'contains_userinfo'],
    ['a username only', 'https://user@a.example', 'contains_userinfo'],
    [
      'a login form path',
      'https://a.example/libs/granite/core/content/login.html',
      'contains_path',
    ],
    ['a reverse-proxy path prefix', 'https://a.example/aem', 'contains_path'],
    ['a query string', 'https://a.example/?resource=%2Fcontent', 'contains_query'],
    ['a fragment', 'https://a.example/#/sites.html', 'contains_fragment'],
  ])('rejects %s with reason %s', (_label, input, reason) => {
    const result = parseOrigin(input);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe(reason);
  });

  it('rejects rather than strips credentials, so the mistake is visible to the user', () => {
    // Stripping would turn a password the user believed was configured into a
    // request that omits it, and would have put the password into settings.
    const result = parseOrigin('https://admin:admin@localhost:4502');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('contains_userinfo');
  });
});

describe('isCanonicalOrigin', () => {
  it('verifies rather than repairs, so a drifted stored value is reported', () => {
    expect(isCanonicalOrigin('https://a.example')).toBe(true);
    expect(isCanonicalOrigin('https://a.example/')).toBe(false);
    expect(isCanonicalOrigin('https://A.example')).toBe(false);
    expect(isCanonicalOrigin('https://a.example:443')).toBe(false);
  });
});

describe('originSchema', () => {
  it('accepts a canonical origin and rejects one needing normalization', () => {
    expect(originSchema.safeParse('https://a.example').success).toBe(true);
    expect(originSchema.safeParse('https://a.example/').success).toBe(false);
    expect(originSchema.safeParse('not a url').success).toBe(false);
  });
});

describe('originsMatch', () => {
  it('treats differently-written forms of the same server as equal', () => {
    expect(originsMatch('https://A.Example/', 'https://a.example')).toBe(true);
    expect(originsMatch('https://a.example:443', 'https://a.example')).toBe(true);
  });

  it('treats a different port or scheme as a different server', () => {
    expect(originsMatch('http://localhost:4502', 'http://localhost:4503')).toBe(false);
    expect(originsMatch('http://a.example', 'https://a.example')).toBe(false);
  });

  it('reports no match when either side is unparseable, never defaulting to true', () => {
    expect(originsMatch('garbage', 'https://a.example')).toBe(false);
    expect(originsMatch('garbage', 'garbage')).toBe(false);
  });
});

describe('parseNavigationTarget', () => {
  it('accepts a path, query and fragment - the parts that name a page rather than a server', () => {
    expect(parseNavigationTarget('https://author.example/editor.html/content/site.html')).toEqual({
      ok: true,
      origin: 'https://author.example',
      url: 'https://author.example/editor.html/content/site.html',
    });
    expect(parseNavigationTarget('https://author.example/sites.html?a=1#b')).toEqual({
      ok: true,
      origin: 'https://author.example',
      url: 'https://author.example/sites.html?a=1#b',
    });
  });

  it('accepts exactly the strings parseOrigin accepts, so anything storable is also navigable', () => {
    for (const candidate of [
      'https://author.example',
      'http://legacy.internal:4502',
      'https://AUTHOR.example:443/',
    ]) {
      const stored = parseOrigin(candidate);
      const navigable = parseNavigationTarget(candidate);
      expect(stored.ok).toBe(true);
      expect(navigable.ok).toBe(true);
      if (stored.ok && navigable.ok) {
        expect(navigable.origin).toBe(stored.origin);
      }
    }
  });

  it('reports the origin separately from the url, so authorization is never decided on the full string', () => {
    const parsed = parseNavigationTarget('https://author.example/a/b?c=d');
    expect(parsed.ok && parsed.origin).toBe('https://author.example');
  });

  it('keeps every security-relevant rejection parseOrigin makes', () => {
    expect(parseNavigationTarget('ftp://author.example/x')).toEqual({
      ok: false,
      reason: 'unsupported_scheme',
    });
    expect(parseNavigationTarget('file:///c:/secret.txt')).toEqual({
      ok: false,
      reason: 'unsupported_scheme',
    });
    expect(parseNavigationTarget('javascript:alert(1)')).toEqual({
      ok: false,
      reason: 'unsupported_scheme',
    });
    // Refused rather than stripped: a silently dropped credential would turn
    // into a request the user believed was authenticated.
    expect(parseNavigationTarget('https://user:pass@author.example/x')).toEqual({
      ok: false,
      reason: 'contains_userinfo',
    });
    expect(parseNavigationTarget('not a url')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseNavigationTarget('   ')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('does not treat a host-shaped path segment as the origin', () => {
    const parsed = parseNavigationTarget('https://evil.example/https://author.example');
    expect(parsed.ok && parsed.origin).toBe('https://evil.example');
  });
});
