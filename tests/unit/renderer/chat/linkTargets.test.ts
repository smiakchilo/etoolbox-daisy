import { describe, expect, it } from 'vitest';
import {
  absoluteMessageHref,
  classifyAemPath,
  hasNonHtmlExtension,
  isAemNativePath,
  isDamPath,
  parseLinkActions,
  resolveAbsoluteLink,
  resolveMessageLink,
  resolveRelativePath,
  serializeLinkActions,
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
  });

  it('trims a jcr:content resource link to its owning page, keeping CRX on the resource', () => {
    expect(classifyAemPath(AUTHOR, '/content/site/en/page/jcr:content')).toEqual(
      pane(`${AUTHOR}/content/site/en/page.html`, [
        editAction(`${AUTHOR}/editor.html/content/site/en/page.html`),
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/en/page/jcr:content`),
      ]),
    );
    expect(classifyAemPath(AUTHOR, '/content/hpe/us/en/page/jcr:content/myComponent/2')).toEqual(
      pane(`${AUTHOR}/content/hpe/us/en/page.html`, [
        editAction(`${AUTHOR}/editor.html/content/hpe/us/en/page.html`),
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/hpe/us/en/page/jcr:content/myComponent/2`),
      ]),
    );
    // A `.html` suffix on the resource is trimmed before the page is built.
    expect(classifyAemPath(AUTHOR, '/content/site/en/page/jcr:content/x.html')).toEqual(
      pane(`${AUTHOR}/content/site/en/page.html`, [
        editAction(`${AUTHOR}/editor.html/content/site/en/page.html`),
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/en/page/jcr:content/x`),
      ]),
    );
  });

  it('percent-encodes the path in content-view URLs, but not in the CRX fragment', () => {
    // `:` is not safe in a URL path, so `jcr:content` is escaped there - while
    // the CRX fragment keeps the raw JCR path, which CRXDE Lite reads verbatim.
    expect(classifyAemPath(AUTHOR, '/apps/x/jcr:content/y')).toEqual(
      pane(`${AUTHOR}/apps/x/jcr%3Acontent/y`, [
        crxAction(`${AUTHOR}/crx/de/index.jsp#/apps/x/jcr:content/y`),
      ]),
    );
    // A DAM asset preview and its assetdetails Edit both encode the path.
    expect(classifyAemPath(AUTHOR, '/content/dam/x/jcr:content/y.jpg')).toEqual(
      pane(`${AUTHOR}/content/dam/x/jcr%3Acontent/y.jpg`, [
        editAction(`${AUTHOR}/assetdetails.html/content/dam/x/jcr%3Acontent/y.jpg`),
      ]),
    );
    // Spaces and unicode are escaped too.
    expect(classifyAemPath(AUTHOR, '/content/caf\u00e9/site name/page')).toEqual(
      pane(`${AUTHOR}/content/caf%C3%A9/site%20name/page.html`, [
        editAction(`${AUTHOR}/editor.html/content/caf%C3%A9/site%20name/page.html`),
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/caf\u00e9/site name/page`),
      ]),
    );
    // An already percent-encoded path must not be double-encoded.
    expect(classifyAemPath(AUTHOR, '/content/caf%C3%A9/page')).toEqual(
      pane(`${AUTHOR}/content/caf%C3%A9/page.html`, [
        editAction(`${AUTHOR}/editor.html/content/caf%C3%A9/page.html`),
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/caf%C3%A9/page`),
      ]),
    );
  });

  it('folds a typographic hyphen in a path to the ASCII node the repository stores', () => {
    // Regression: the model wrote `custom‑skeleton` with U+2011 NON-BREAKING
    // HYPHEN. If the dash is not folded, the link names a node that does not
    // exist (and the bare-path matcher stops at `custom` - see the linkification
    // suite below).
    expect(
      classifyAemPath(AUTHOR, '/content/site/custom\u2011skeleton/column-container/1'),
    ).toEqual(
      pane(`${AUTHOR}/content/site/custom-skeleton/column-container/1.html`, [
        editAction(`${AUTHOR}/editor.html/content/site/custom-skeleton/column-container/1.html`),
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/custom-skeleton/column-container/1`),
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

describe('linkTargets - absoluteMessageHref', () => {
  it('keeps an absolute URL and resolves a relative path against the active host', () => {
    expect(absoluteMessageHref(`${AUTHOR}/content/x`, activeContext)).toBe(`${AUTHOR}/content/x`);
    expect(absoluteMessageHref('/content/site/en/page', activeContext)).toBe(
      `${AUTHOR}/content/site/en/page`,
    );
    expect(absoluteMessageHref('https://other.example/x', activeContext)).toBe(
      'https://other.example/x',
    );
  });

  it('preserves a jcr:content resource path rather than trimming it to the page', () => {
    // The whole point: the normalised href keeps the resource so the
    // post-sanitization pass can recover CRX's exact target.
    expect(absoluteMessageHref('/content/a/b/jcr:content/x', activeContext)).toBe(
      `${AUTHOR}/content/a/b/jcr:content/x`,
    );
  });

  it('is undefined for an unresolvable href', () => {
    expect(absoluteMessageHref('/content/x', hostsOnlyContext)).toBeUndefined();
    expect(absoluteMessageHref('//evil.example/x', activeContext)).toBeUndefined();
    expect(absoluteMessageHref('/system/console', activeContext)).toBeUndefined();
    expect(absoluteMessageHref('mailto:a@example.com', activeContext)).toBeUndefined();
  });
});

describe('linkTargets - link action serialization', () => {
  it('round-trips the exact actions a link was classified with', () => {
    const resolved = classifyAemPath(AUTHOR, '/content/a/b/jcr:content/x');
    expect(parseLinkActions(serializeLinkActions(resolved.actions))).toEqual(resolved.actions);
  });

  it('drops malformed or unrecognised action data instead of throwing', () => {
    expect(parseLinkActions(null)).toEqual([]);
    expect(parseLinkActions('not json')).toEqual([]);
    expect(parseLinkActions('{"id":"edit"}')).toEqual([]);
    expect(parseLinkActions('[{"id":"delete","title":"x","href":"y"}]')).toEqual([]);
    expect(parseLinkActions('[{"id":"edit","title":"Edit"}]')).toEqual([]);
    expect(parseLinkActions('[{"id":"edit","title":"Edit","href":"https://a/x"}]')).toEqual([
      { id: 'edit', title: 'Edit', href: 'https://a/x' },
    ]);
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

  it('keeps a typographic hyphen (U+2011) inside a bare path instead of stopping at it', () => {
    // Regression for the real chat: `templates/custom‑skeleton/...` was matched
    // only as far as `templates/custom`, so the anchor covered half the path and
    // its href pointed at the wrong node. The displayed text keeps the original
    // U+2011; the resolved link folds it to ASCII `-`.
    expect(splitAemPathLinks('/content/site/custom\u2011skeleton/1', AUTHOR)).toEqual([
      {
        kind: 'link',
        value: '/content/site/custom\u2011skeleton/1',
        resolved: pane(`${AUTHOR}/content/site/custom-skeleton/1.html`, [
          editAction(`${AUTHOR}/editor.html/content/site/custom-skeleton/1.html`),
          crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/custom-skeleton/1`),
        ]),
      },
    ]);
  });
});
