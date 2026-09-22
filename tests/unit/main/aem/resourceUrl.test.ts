import { describe, expect, it } from 'vitest';
import { buildResourceUrl } from '../../../../src/shared';
import type { JcrPathRejectionReason } from '../../../../src/shared';

const ORIGIN = 'https://author.example';

describe('buildResourceUrl - happy path', () => {
  it('builds the depth-0 URL (own properties only) when includeChildren is false', () => {
    const result = buildResourceUrl({
      origin: ORIGIN,
      path: '/content/site',
      includeChildren: false,
    });
    expect(result).toEqual({ ok: true, value: 'https://author.example/content/site.0.json' });
  });

  it('builds the depth-1 URL (immediate children too) when includeChildren is true', () => {
    const result = buildResourceUrl({
      origin: ORIGIN,
      path: '/content/site',
      includeChildren: true,
    });
    expect(result).toEqual({ ok: true, value: 'https://author.example/content/site.1.json' });
  });

  it('round-trips a jcr: namespaced node name, percent-encoding the colon', () => {
    const result = buildResourceUrl({
      origin: ORIGIN,
      path: '/content/site/jcr:content',
      includeChildren: false,
    });
    expect(result).toEqual({
      ok: true,
      value: 'https://author.example/content/site/jcr%3Acontent.0.json',
    });
  });

  it('round-trips other namespaced names (cq:, rep:)', () => {
    const result = buildResourceUrl({
      origin: ORIGIN,
      path: '/conf/site/settings/wcm/policies/rep:policy',
      includeChildren: false,
    });
    expect(result).toEqual({
      ok: true,
      value: 'https://author.example/conf/site/settings/wcm/policies/rep%3Apolicy.0.json',
    });
  });

  it('round-trips a Unicode node name as its UTF-8 percent-encoded bytes', () => {
    // "café" is C3 A9 in UTF-8 for the 'é' - a well-known, hand-verifiable
    // encoding, so this does not merely re-run encodeURIComponent against
    // itself.
    const result = buildResourceUrl({
      origin: ORIGIN,
      path: '/content/café',
      includeChildren: false,
    });
    expect(result).toEqual({ ok: true, value: 'https://author.example/content/caf%C3%A9.0.json' });
  });

  it('addresses the SAME node whether the path arrives raw or percent-encoded', () => {
    // The decisive property of decoding exactly once before re-encoding:
    // `parseJcrPath` validated the DECODED form, so the request must ask for
    // that same decoded form. Encoding the raw candidate instead would send
    // `caf%25C3%25A9` and address a node literally named `caf%C3%A9` - a
    // string nobody validated and which does not exist.
    const raw = buildResourceUrl({ origin: ORIGIN, path: '/content/café', includeChildren: false });
    const encoded = buildResourceUrl({
      origin: ORIGIN,
      path: '/content/caf%C3%A9',
      includeChildren: false,
    });
    expect(encoded).toEqual(raw);
    expect(encoded).toEqual({ ok: true, value: 'https://author.example/content/caf%C3%A9.0.json' });
  });

  it("addresses a node whose name really contains '%' when it is sent as %25", () => {
    // Decode-once makes a literal '%' addressable at all: '%25' decodes to
    // '%', which re-encodes back to '%25'. Encoding the raw candidate would
    // have produced '%2525' and asked for a node named '%25'.
    const result = buildResourceUrl({
      origin: ORIGIN,
      path: '/content/100%25',
      includeChildren: false,
    });
    expect(result).toEqual({ ok: true, value: 'https://author.example/content/100%25.0.json' });
  });

  it('treats an encoded separator as a real separator, matching what was validated', () => {
    // '%2F' decodes to '/', and `parseJcrPath` applied its traversal and
    // metacharacter rules to that decoded string - so the URL builder must
    // split on it too, or the two would once again disagree about the path.
    const result = buildResourceUrl({
      origin: ORIGIN,
      path: '/content/a%2Fb',
      includeChildren: false,
    });
    expect(result).toEqual({ ok: true, value: 'https://author.example/content/a/b.0.json' });
  });

  it("keeps dots in an ordinary DAM file name intact ('.' is left unescaped)", () => {
    const result = buildResourceUrl({
      origin: ORIGIN,
      path: '/content/dam/my.file.pdf',
      includeChildren: false,
    });
    expect(result).toEqual({
      ok: true,
      value: 'https://author.example/content/dam/my.file.pdf.0.json',
    });
  });
});

describe('buildResourceUrl - rejects every invalid path, with the exact reason parseJcrPath gives', () => {
  const cases: readonly [string, string, JcrPathRejectionReason][] = [
    ["a '..' traversal segment", '/content/../etc', 'contains_traversal_segment'],
    ['an embedded scheme', '/http://evil/x', 'contains_scheme'],
    ['a request path parameter (;v=)', "/content/site;v='1.0'", 'contains_request_path_parameter'],
    ['a trailing slash (empty segment)', '/content/site/', 'contains_empty_segment'],
    ['an .infinity selector', '/content/site.infinity', 'contains_sling_selector'],
    ['an already-present .json extension', '/content/site.json', 'contains_json_extension'],
    ['an empty path', '', 'empty'],
  ];

  it.each(cases)('rejects %s (%j) as invalid_path/%s', (_label, path, expectedReason) => {
    const result = buildResourceUrl({ origin: ORIGIN, path, includeChildren: false });
    expect(result).toEqual({
      ok: false,
      error: { kind: 'invalid_path', reason: expectedReason },
    });
  });
});

describe('buildResourceUrl - rejects every invalid origin as invalid_origin', () => {
  const cases: readonly [string, string][] = [
    ['a path', 'https://author.example/some/path'],
    ['a query string', 'https://author.example?x=1'],
    ['userinfo', 'https://user:pass@author.example'],
    ['a non-http(s) scheme', 'ftp://author.example'],
    ['a fragment', 'https://author.example#top'],
    ['not a URL at all', 'not a url'],
  ];

  it.each(cases)('rejects an origin containing %s', (_label, origin) => {
    const result = buildResourceUrl({ origin, path: '/content/site', includeChildren: false });
    expect(result).toEqual({ ok: false, error: { kind: 'invalid_origin' } });
  });
});

describe('buildResourceUrl - the host cannot be smuggled through the path', () => {
  it('never produces a URL whose origin differs from the validated server origin', () => {
    // A colon inside a path segment is legitimate (jcr:content) but must
    // never be reinterpreted as introducing a scheme/host: it is percent-
    // encoded, not passed through literally.
    const result = buildResourceUrl({
      origin: ORIGIN,
      path: '/https:evil.example',
      includeChildren: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const url = new URL(result.value);
      expect(url.origin).toBe(ORIGIN);
      expect(url.hostname).toBe('author.example');
    }
  });

  it('keeps the origin fixed even for an origin/path combination chosen to look like a different host', () => {
    const result = buildResourceUrl({
      origin: 'https://a.example',
      path: '/content/x',
      includeChildren: false,
    });
    expect(result).toEqual({ ok: true, value: 'https://a.example/content/x.0.json' });
    if (result.ok) {
      expect(new URL(result.value).origin).toBe('https://a.example');
    }
  });
});

describe('buildResourceUrl - defence in depth', () => {
  it('reports unencodable_path for a lone UTF-16 surrogate, which parseJcrPath does not reject but encodeURIComponent cannot encode', () => {
    // "\uD800" is a high surrogate with no low-surrogate partner - not a
    // control character and not a structural metacharacter, so
    // parseJcrPath accepts it, but encodeURIComponent throws a URIError on
    // it. This proves the module reports a classified error instead of
    // letting that exception escape.
    const result = buildResourceUrl({
      origin: ORIGIN,
      path: '/content/\uD800',
      includeChildren: false,
    });
    expect(result).toEqual({ ok: false, error: { kind: 'unencodable_path' } });
  });
});
