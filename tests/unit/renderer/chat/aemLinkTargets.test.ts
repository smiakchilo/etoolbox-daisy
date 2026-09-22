import { describe, expect, it } from 'vitest';
import {
  buildAemEditUrl,
  isAemNativePath,
  isDamPath,
  resolveAbsoluteMessageLink,
  resolveMessageLink,
  resolveRelativeAemPath,
  splitAemPathLinks,
  type LinkContext,
} from '../../../../src/renderer/src/chat/aemLinkTargets';

const AUTHOR = 'https://author.example';

const activeContext: LinkContext = { hostOrigins: [AUTHOR], activeOrigin: AUTHOR };
const hostsOnlyContext: LinkContext = { hostOrigins: [AUTHOR], activeOrigin: undefined };
const emptyContext: LinkContext = { hostOrigins: [], activeOrigin: undefined };

describe('aemLinkTargets - path classification', () => {
  it('recognises exactly the seven AEM roots', () => {
    for (const root of ['content', 'apps', 'libs', 'conf', 'var', 'etc', 'home']) {
      expect(isAemNativePath(`/${root}`)).toBe(true);
      expect(isAemNativePath(`/${root}/child`)).toBe(true);
    }
  });

  it('rejects a root-like segment that only shares a prefix', () => {
    expect(isAemNativePath('/contentx')).toBe(false);
    expect(isAemNativePath('/system/console')).toBe(false);
    expect(isAemNativePath('/')).toBe(false);
    expect(isAemNativePath('content/x')).toBe(false);
  });

  it('treats /content/dam as the non-page content subtree', () => {
    expect(isDamPath('/content/dam')).toBe(true);
    expect(isDamPath('/content/dam/x')).toBe(true);
    expect(isDamPath('/content/damage')).toBe(false);
    expect(isDamPath('/content/site')).toBe(false);
  });
});

describe('aemLinkTargets - edit-mode URL', () => {
  it('opens a /content page in the page editor, normalising the .html suffix', () => {
    expect(buildAemEditUrl(AUTHOR, '/content/site/en/page')).toBe(
      `${AUTHOR}/editor.html/content/site/en/page.html`,
    );
    expect(buildAemEditUrl(AUTHOR, '/content/site/en/page.html')).toBe(
      `${AUTHOR}/editor.html/content/site/en/page.html`,
    );
    expect(buildAemEditUrl(AUTHOR, '/content/site/en/page/')).toBe(
      `${AUTHOR}/editor.html/content/site/en/page.html`,
    );
  });

  it('opens /content/dam and the non-content roots in CRXDE Lite', () => {
    expect(buildAemEditUrl(AUTHOR, '/content/dam/x/y')).toBe(
      `${AUTHOR}/crx/de/index.jsp#/content/dam/x/y`,
    );
    expect(buildAemEditUrl(AUTHOR, '/apps/x/y')).toBe(`${AUTHOR}/crx/de/index.jsp#/apps/x/y`);
    expect(buildAemEditUrl(AUTHOR, '/conf/x')).toBe(`${AUTHOR}/crx/de/index.jsp#/conf/x`);
  });
});

describe('aemLinkTargets - resolving a relative path', () => {
  it('resolves against the active host', () => {
    expect(resolveRelativeAemPath('/content/site/en/page', AUTHOR)).toBe(
      `${AUTHOR}/editor.html/content/site/en/page.html`,
    );
    expect(resolveRelativeAemPath('/apps/x', AUTHOR)).toBe(`${AUTHOR}/crx/de/index.jsp#/apps/x`);
  });

  it('is not clickable with no active host', () => {
    expect(resolveRelativeAemPath('/content/site/en/page', undefined)).toBeUndefined();
  });

  it('ignores a scheme-relative or non-AEM relative path', () => {
    expect(resolveRelativeAemPath('//evil.example/x', AUTHOR)).toBeUndefined();
    expect(resolveRelativeAemPath('/system/console', AUTHOR)).toBeUndefined();
    expect(resolveRelativeAemPath('https://author.example/content/x', AUTHOR)).toBeUndefined();
  });

  it('strips a query and fragment before building the edit URL', () => {
    expect(resolveRelativeAemPath('/content/site/en/page?wcmmode=disabled#x', AUTHOR)).toBe(
      `${AUTHOR}/editor.html/content/site/en/page.html`,
    );
  });
});

describe('aemLinkTargets - resolving an absolute link', () => {
  it('opens a configured host page in edit mode', () => {
    expect(resolveAbsoluteMessageLink(`${AUTHOR}/content/site/en/page.html`, activeContext)).toBe(
      `${AUTHOR}/editor.html/content/site/en/page.html`,
    );
  });

  it('leaves a configured host non-page URL unchanged, query included', () => {
    expect(
      resolveAbsoluteMessageLink(`${AUTHOR}/bin/querybuilder.json?path=/content`, activeContext),
    ).toBe(`${AUTHOR}/bin/querybuilder.json?path=/content`);
  });

  it('refuses an unconfigured origin and a mailto link', () => {
    expect(resolveAbsoluteMessageLink('https://other.example/x', activeContext)).toBeUndefined();
    expect(resolveAbsoluteMessageLink('mailto:a@example.com', activeContext)).toBeUndefined();
  });
});

describe('aemLinkTargets - resolveMessageLink', () => {
  it('handles both an absolute host link and a relative path', () => {
    expect(resolveMessageLink(`${AUTHOR}/content/x`, activeContext)).toBe(
      `${AUTHOR}/editor.html/content/x.html`,
    );
    expect(resolveMessageLink('/content/x', activeContext)).toBe(
      `${AUTHOR}/editor.html/content/x.html`,
    );
  });

  it('returns undefined for an external link or a relative path with no active host', () => {
    expect(resolveMessageLink('https://other.example/x', activeContext)).toBeUndefined();
    expect(resolveMessageLink('/content/x', hostsOnlyContext)).toBeUndefined();
    expect(resolveMessageLink('/content/x', emptyContext)).toBeUndefined();
  });
});

describe('aemLinkTargets - bare path linkification', () => {
  it('does nothing with no active host', () => {
    expect(splitAemPathLinks('See /content/x now', undefined)).toEqual([
      { kind: 'text', value: 'See /content/x now' },
    ]);
  });

  it('wraps a bare path in prose, keeping the surrounding text', () => {
    expect(splitAemPathLinks('See /content/site/en/page now', AUTHOR)).toEqual([
      { kind: 'text', value: 'See ' },
      {
        kind: 'link',
        value: '/content/site/en/page',
        url: `${AUTHOR}/editor.html/content/site/en/page.html`,
      },
      { kind: 'text', value: ' now' },
    ]);
  });

  it('keeps the bracket and trims a trailing sentence period', () => {
    expect(splitAemPathLinks('(/content/x).', AUTHOR)).toEqual([
      { kind: 'text', value: '(' },
      { kind: 'link', value: '/content/x', url: `${AUTHOR}/editor.html/content/x.html` },
      { kind: 'text', value: ').' },
    ]);
  });

  it('does not linkify a root-like segment inside a word', () => {
    expect(splitAemPathLinks('not/contentx here', AUTHOR)).toEqual([
      { kind: 'text', value: 'not/contentx here' },
    ]);
  });

  it('routes a /content/dam path to CRXDE', () => {
    expect(splitAemPathLinks('/content/dam/x', AUTHOR)).toEqual([
      { kind: 'link', value: '/content/dam/x', url: `${AUTHOR}/crx/de/index.jsp#/content/dam/x` },
    ]);
  });
});
