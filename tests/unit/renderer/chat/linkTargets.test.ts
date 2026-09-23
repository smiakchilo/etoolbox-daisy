import { describe, expect, it } from 'vitest';
import {
  classifyAemPath,
  hasNonHtmlExtension,
  isAemNativePath,
  isDamPath,
  resolveAbsoluteLink,
  resolveMessageLink,
  resolveRelativePath,
  splitAemPathLinks,
  type LinkContext,
  type ResolvedLink,
} from '../../../../src/renderer/src/chat/linkTargets';

const AUTHOR = 'https://author.example';

const activeContext: LinkContext = { hostOrigins: [AUTHOR], activeOrigin: AUTHOR };
const hostsOnlyContext: LinkContext = { hostOrigins: [AUTHOR], activeOrigin: undefined };
const emptyContext: LinkContext = { hostOrigins: [], activeOrigin: undefined };

function editAction(href: string): { id: 'edit'; title: string; href: string } {
  return { id: 'edit', title: 'Edit', href };
}
function crxAction(href: string): { id: 'crx'; title: string; href: string } {
  return { id: 'crx', title: 'CRX', href };
}
function pane(href: string, actions: ResolvedLink['actions']): ResolvedLink {
  return { openIn: 'pane', href, actions };
}

describe('linkTargets - path classification', () => {
  it('recognizes exactly the seven AEM roots', () => {
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

  it('detects an extension other than .html', () => {
    expect(hasNonHtmlExtension('/content/dam/x.jpg')).toBe(true);
    expect(hasNonHtmlExtension('/content/site/en/page.1.json')).toBe(true);
    expect(hasNonHtmlExtension('/content/site/en/page.html')).toBe(false);
    expect(hasNonHtmlExtension('/content/site/en/page')).toBe(false);
    expect(hasNonHtmlExtension('/content/foo.bar/page')).toBe(false);
  });
});

describe('linkTargets - classifyAemPath', () => {
  it('makes a /content page open its rendered .html and offer Edit + CRX', () => {
    expect(classifyAemPath(AUTHOR, '/content/site/en/page')).toEqual(
      pane(`${AUTHOR}/content/site/en/page.html`, [
        editAction(`${AUTHOR}/editor.html/content/site/en/page.html`),
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/en/page`),
      ]),
    );
    expect(classifyAemPath(AUTHOR, '/content/site/en/page.html')).toEqual(
      pane(`${AUTHOR}/content/site/en/page.html`, [
        editAction(`${AUTHOR}/editor.html/content/site/en/page.html`),
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/en/page`),
      ]),
    );
  });

  it('previews a DAM asset and offers Edit -> assetdetails', () => {
    expect(classifyAemPath(AUTHOR, '/content/dam/x/y.jpg')).toEqual(
      pane(`${AUTHOR}/content/dam/x/y.jpg`, [
        editAction(`${AUTHOR}/assetdetails.html/content/dam/x/y.jpg`),
      ]),
    );
  });

  it('previews a non-DAM asset with no actions', () => {
    expect(classifyAemPath(AUTHOR, '/content/site/en/page.1.json')).toEqual(
      pane(`${AUTHOR}/content/site/en/page.1.json`, []),
    );
  });

  it('opens a .html/extensionless non-page raw and offers CRX only, including under /content/dam', () => {
    expect(classifyAemPath(AUTHOR, '/content/dam/x/y')).toEqual(
      pane(`${AUTHOR}/content/dam/x/y`, [crxAction(`${AUTHOR}/crx/de/index.jsp#/content/dam/x/y`)]),
    );
    expect(classifyAemPath(AUTHOR, '/apps/x/y')).toEqual(
      pane(`${AUTHOR}/apps/x/y`, [crxAction(`${AUTHOR}/crx/de/index.jsp#/apps/x/y`)]),
    );
    expect(classifyAemPath(AUTHOR, '/content/site/en/page/jcr:content')).toEqual(
      pane(`${AUTHOR}/content/site/en/page/jcr:content`, [
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/en/page/jcr:content`),
      ]),
    );
  });
});

describe('linkTargets - resolving a relative path', () => {
  it('resolves against the active host', () => {
    expect(resolveRelativePath('/content/site/en/page', AUTHOR)).toEqual(
      pane(`${AUTHOR}/content/site/en/page.html`, [
        editAction(`${AUTHOR}/editor.html/content/site/en/page.html`),
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/en/page`),
      ]),
    );
  });

  it('is not clickable with no active host', () => {
    expect(resolveRelativePath('/content/site/en/page', undefined)).toBeUndefined();
  });

  it('ignores a scheme-relative or non-AEM relative path', () => {
    expect(resolveRelativePath('//evil.example/x', AUTHOR)).toBeUndefined();
    expect(resolveRelativePath('/system/console', AUTHOR)).toBeUndefined();
    expect(resolveRelativePath('https://author.example/content/x', AUTHOR)).toBeUndefined();
  });

  it('strips a query and fragment before classifying', () => {
    expect(resolveRelativePath('/content/site/en/page?wcmmode=disabled#x', AUTHOR)).toEqual(
      pane(`${AUTHOR}/content/site/en/page.html`, [
        editAction(`${AUTHOR}/editor.html/content/site/en/page.html`),
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/en/page`),
      ]),
    );
  });
});

describe('linkTargets - resolving an absolute link', () => {
  it('opens a configured host page in the pane and offers its actions', () => {
    expect(resolveAbsoluteLink(`${AUTHOR}/content/site/en/page.html`, activeContext)).toEqual(
      pane(`${AUTHOR}/content/site/en/page.html`, [
        editAction(`${AUTHOR}/editor.html/content/site/en/page.html`),
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/en/page`),
      ]),
    );
  });

  it('leaves a configured host non-AEM URL unchanged, query included', () => {
    expect(
      resolveAbsoluteLink(`${AUTHOR}/bin/querybuilder.json?path=/content`, activeContext),
    ).toEqual(pane(`${AUTHOR}/bin/querybuilder.json?path=/content`, []));
  });

  it('opens an unconfigured origin externally', () => {
    expect(resolveAbsoluteLink('https://other.example/x', activeContext)).toEqual({
      openIn: 'external',
      href: 'https://other.example/x',
      actions: [],
    });
  });

  it('refuses a mailto link', () => {
    expect(resolveAbsoluteLink('mailto:a@example.com', activeContext)).toBeUndefined();
  });
});

describe('linkTargets - resolveMessageLink', () => {
  it('handles an absolute host link, a relative path, and an external link', () => {
    expect(resolveMessageLink(`${AUTHOR}/content/x`, activeContext)).toEqual(
      pane(`${AUTHOR}/content/x.html`, [
        editAction(`${AUTHOR}/editor.html/content/x.html`),
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/x`),
      ]),
    );
    expect(resolveMessageLink('/content/x', activeContext)).toEqual(
      pane(`${AUTHOR}/content/x.html`, [
        editAction(`${AUTHOR}/editor.html/content/x.html`),
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/x`),
      ]),
    );
    expect(resolveMessageLink('https://other.example/x', activeContext)?.openIn).toBe('external');
  });

  it('returns undefined for a relative path with no active host', () => {
    expect(resolveMessageLink('/content/x', hostsOnlyContext)).toBeUndefined();
    expect(resolveMessageLink('/content/x', emptyContext)).toBeUndefined();
  });
});

describe('linkTargets - bare path linkification', () => {
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
        resolved: pane(`${AUTHOR}/content/site/en/page.html`, [
          editAction(`${AUTHOR}/editor.html/content/site/en/page.html`),
          crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/en/page`),
        ]),
      },
      { kind: 'text', value: ' now' },
    ]);
  });

  it('keeps the bracket and trims a trailing sentence period', () => {
    expect(splitAemPathLinks('(/content/x).', AUTHOR)).toEqual([
      { kind: 'text', value: '(' },
      {
        kind: 'link',
        value: '/content/x',
        resolved: pane(`${AUTHOR}/content/x.html`, [
          editAction(`${AUTHOR}/editor.html/content/x.html`),
          crxAction(`${AUTHOR}/crx/de/index.jsp#/content/x`),
        ]),
      },
      { kind: 'text', value: ').' },
    ]);
  });

  it('does not linkify a root-like segment inside a word', () => {
    expect(splitAemPathLinks('not/contentx here', AUTHOR)).toEqual([
      { kind: 'text', value: 'not/contentx here' },
    ]);
  });

  it('classifies a /content/dam path as a CRX-only non-page', () => {
    expect(splitAemPathLinks('/content/dam/x', AUTHOR)).toEqual([
      {
        kind: 'link',
        value: '/content/dam/x',
        resolved: pane(`${AUTHOR}/content/dam/x`, [
          crxAction(`${AUTHOR}/crx/de/index.jsp#/content/dam/x`),
        ]),
      },
    ]);
  });
});
