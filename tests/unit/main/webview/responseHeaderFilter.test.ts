import { describe, expect, it } from 'vitest';
import {
  INLINE_RENDERABLE_ATTACHMENT_RULE,
  type ResponseHeaderMap,
  type ResponseHeaderRule,
  contentTypeMatches,
  createResponseHeaderFilter,
  hostMatches,
} from '../../../../src/main/webview';

/**
 * The response-header filter is the decision that lets a DAM asset link actually
 * preview (AEM serves the asset as an attachment, which Chromium would download
 * and the session cancels), and it must stay a rule list rather than a one-off
 * branch so a host- or content-specific case is a data addition.
 */

const ATTACHMENT_IMAGE: ResponseHeaderMap = {
  'content-type': ['image/jpeg'],
  'content-disposition': ['attachment; filename="photo.jpg"'],
  'content-length': ['1234'],
};

describe('createResponseHeaderFilter - default rule', () => {
  it('drops the attachment disposition from a renderable response and keeps every other header', () => {
    const filter = createResponseHeaderFilter();

    expect(
      filter.filter({
        url: 'https://author.example/content/dam/x/photo.jpg',
        responseHeaders: ATTACHMENT_IMAGE,
      }),
    ).toEqual({
      headers: { 'content-type': ['image/jpeg'], 'content-length': ['1234'] },
      ruleIds: [INLINE_RENDERABLE_ATTACHMENT_RULE.id],
    });
    // The map Electron handed over is never mutated.
    expect(ATTACHMENT_IMAGE['content-disposition']).toEqual(['attachment; filename="photo.jpg"']);
  });

  it('matches header names case-insensitively', () => {
    const filter = createResponseHeaderFilter();
    expect(
      filter.filter({
        url: 'https://author.example/content/dam/x/photo.jpg',
        responseHeaders: { 'Content-Type': ['IMAGE/PNG'], 'CONTENT-DISPOSITION': ['ATTACHMENT'] },
      }),
    ).toEqual({
      headers: { 'Content-Type': ['IMAGE/PNG'] },
      ruleIds: ['inline-renderable-attachment'],
    });
  });

  it('leaves an inline disposition, a missing disposition and a missing type alone', () => {
    const filter = createResponseHeaderFilter();
    const url = 'https://author.example/content/dam/x/photo.jpg';

    expect(
      filter.filter({
        url,
        responseHeaders: { 'content-type': ['image/jpeg'], 'content-disposition': ['inline'] },
      }),
    ).toBeUndefined();
    expect(
      filter.filter({ url, responseHeaders: { 'content-type': ['image/jpeg'] } }),
    ).toBeUndefined();
    expect(
      filter.filter({ url, responseHeaders: { 'content-disposition': ['attachment'] } }),
    ).toBeUndefined();
  });

  it('leaves a type the pane cannot render alone, so the download guard still cancels it', () => {
    const filter = createResponseHeaderFilter();
    for (const contentType of ['application/zip', 'application/octet-stream', '']) {
      expect(
        filter.filter({
          url: 'https://author.example/content/dam/x/archive',
          responseHeaders: { 'content-type': [contentType], 'content-disposition': ['attachment'] },
        }),
      ).toBeUndefined();
    }
  });
});

describe('hostMatches', () => {
  const url = 'https://author-p123-e456.adobeaemcloud.com/content/x';

  it('matches a canonical origin exactly, including its scheme and port', () => {
    expect(hostMatches('https://author-p123-e456.adobeaemcloud.com', url)).toBe(true);
    expect(hostMatches('http://author-p123-e456.adobeaemcloud.com', url)).toBe(false);
    expect(hostMatches('https://author.example:4502', 'http://author.example:4502/x')).toBe(false);
    expect(hostMatches('http://author.example:4502', 'http://author.example:4502/x')).toBe(true);
  });

  it('matches a host:port or a bare hostname (any port, either scheme)', () => {
    expect(hostMatches('author.example:4502', 'http://author.example:4502/x')).toBe(true);
    expect(hostMatches('author.example:4502', 'http://author.example:8080/x')).toBe(false);
    expect(hostMatches('author.example', 'https://author.example:8443/x')).toBe(true);
    expect(hostMatches('other.example', 'https://author.example/x')).toBe(false);
  });

  it('supports a wildcard', () => {
    expect(hostMatches('*.adobeaemcloud.com', url)).toBe(true);
    expect(hostMatches('author-p123-*', url)).toBe(true);
    expect(hostMatches('*.example.com', 'https://evil-example.com/x')).toBe(false);
  });

  it('refuses an empty pattern or an unparseable URL', () => {
    expect(hostMatches('  ', url)).toBe(false);
    expect(hostMatches('author.example', 'not a url')).toBe(false);
  });
});

describe('contentTypeMatches', () => {
  it('matches an exact type, a family and the wildcard, ignoring parameters and case', () => {
    expect(contentTypeMatches('image/jpeg', 'image/jpeg')).toBe(true);
    expect(contentTypeMatches('IMAGE/JPEG', 'image/jpeg; charset=binary')).toBe(true);
    expect(contentTypeMatches('image/*', 'image/png')).toBe(true);
    expect(contentTypeMatches('image/', 'image/svg+xml')).toBe(true);
    expect(contentTypeMatches('*/*', 'application/pdf')).toBe(true);
    expect(contentTypeMatches('*', 'application/pdf')).toBe(true);
  });

  it('does not match a different type, an absent type or a bare family with no subtype', () => {
    expect(contentTypeMatches('image/*', 'application/pdf')).toBe(false);
    expect(contentTypeMatches('image/jpeg', 'image/png')).toBe(false);
    expect(contentTypeMatches('image/*', undefined)).toBe(false);
    expect(contentTypeMatches('image/*', '')).toBe(false);
  });
});

describe('createResponseHeaderFilter - custom rules', () => {
  it('scopes a rule to its own hosts and leaves another host untouched', () => {
    const rule: ResponseHeaderRule = {
      id: 'inline-dam-on-one-host',
      hosts: ['author.example:4502'],
      disposition: 'attachment',
      contentTypes: ['image/*'],
      mutations: [{ kind: 'remove', name: 'content-disposition' }],
    };
    const filter = createResponseHeaderFilter([rule]);

    expect(
      filter.filter({
        url: 'http://author.example:4502/content/dam/x.jpg',
        responseHeaders: ATTACHMENT_IMAGE,
      }),
    ).toEqual({
      headers: { 'content-type': ['image/jpeg'], 'content-length': ['1234'] },
      ruleIds: ['inline-dam-on-one-host'],
    });
    expect(
      filter.filter({ url: 'https://other.example/x.jpg', responseHeaders: ATTACHMENT_IMAGE }),
    ).toBeUndefined();
  });

  it('swaps a header value when the host mislabels a renderable response', () => {
    const rule: ResponseHeaderRule = {
      id: 'fix-mislabelled-html',
      hosts: ['legacy.example'],
      contentTypes: ['application/octet-stream'],
      mutations: [{ kind: 'set', name: 'Content-Type', values: ['text/html; charset=utf-8'] }],
    };
    const filter = createResponseHeaderFilter([rule]);

    expect(
      filter.filter({
        url: 'https://legacy.example/page',
        responseHeaders: { 'content-type': ['application/octet-stream'] },
      }),
    ).toEqual({
      headers: { 'Content-Type': ['text/html; charset=utf-8'] },
      ruleIds: ['fix-mislabelled-html'],
    });
  });

  it('applies every matching rule in order, so rules can compose', () => {
    const filter = createResponseHeaderFilter([
      { id: 'first', mutations: [{ kind: 'remove', name: 'content-disposition' }] },
      { id: 'second', mutations: [{ kind: 'set', name: 'cache-control', values: ['no-store'] }] },
    ]);

    expect(
      filter.filter({ url: 'https://author.example/x.jpg', responseHeaders: ATTACHMENT_IMAGE }),
    ).toEqual({
      headers: {
        'content-type': ['image/jpeg'],
        'content-length': ['1234'],
        'cache-control': ['no-store'],
      },
      ruleIds: ['first', 'second'],
    });
  });

  it('treats an empty criteria list as "any"', () => {
    const filter = createResponseHeaderFilter([
      {
        id: 'always',
        hosts: [],
        contentTypes: [],
        mutations: [{ kind: 'remove', name: 'x-test' }],
      },
    ]);

    expect(
      filter.filter({ url: 'https://anything.example/', responseHeaders: { 'x-test': ['1'] } }),
    ).toEqual({ headers: {}, ruleIds: ['always'] });
  });

  it('does nothing with no rules', () => {
    const filter = createResponseHeaderFilter([]);
    expect(
      filter.filter({ url: 'https://author.example/x.jpg', responseHeaders: ATTACHMENT_IMAGE }),
    ).toBeUndefined();
  });
});
