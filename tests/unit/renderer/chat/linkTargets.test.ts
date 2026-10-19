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
  resolvePartialPathActions,
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

// The visible title is production copy; only the action's id and href are certified.
function editAction(href: string): { id: 'edit'; title: string; href: string } {
  return { id: 'edit', title: expect.any(String) as string, href };
}
function crxAction(href: string): { id: 'crx'; title: string; href: string } {
  return { id: 'crx', title: expect.any(String) as string, href };
}
function pane(href: string, actions: ResolvedLink['actions']): ResolvedLink {
  return { openIn: 'pane', href, actions };
}
/** The segments of one string, linkified in the active-host context. */
function segments(text: string, context: LinkContext = activeContext) {
  return splitAemPathLinks(text, context).segments;
}
/** A full-path link segment, with the `navigable` flag the union now carries. */
function fullLink(value: string, resolved: ResolvedLink) {
  return { kind: 'link', value, resolved, navigable: true };
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

  it('previews a DAM asset and offers Edit -> assetdetails and its own CRX', () => {
    expect(classifyAemPath(AUTHOR, '/content/dam/x/y.jpg')).toEqual(
      pane(`${AUTHOR}/content/dam/x/y.jpg`, [
        editAction(`${AUTHOR}/assetdetails.html/content/dam/x/y.jpg`),
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/dam/x/y.jpg`),
      ]),
    );
  });

  it('previews a non-DAM asset and offers its own CRX', () => {
    expect(classifyAemPath(AUTHOR, '/content/site/en/page.1.json')).toEqual(
      pane(`${AUTHOR}/content/site/en/page.1.json`, [
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/en/page.1.json`),
      ]),
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
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/en/page/jcr%3Acontent`),
      ]),
    );
    expect(classifyAemPath(AUTHOR, '/content/hpe/us/en/page/jcr:content/myComponent/2')).toEqual(
      pane(`${AUTHOR}/content/hpe/us/en/page.html`, [
        editAction(`${AUTHOR}/editor.html/content/hpe/us/en/page.html`),
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/hpe/us/en/page/jcr%3Acontent/myComponent/2`),
      ]),
    );
    // A `.html` suffix on the resource is trimmed before the page is built.
    expect(classifyAemPath(AUTHOR, '/content/site/en/page/jcr:content/x.html')).toEqual(
      pane(`${AUTHOR}/content/site/en/page.html`, [
        editAction(`${AUTHOR}/editor.html/content/site/en/page.html`),
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/en/page/jcr%3Acontent/x`),
      ]),
    );
  });

  it('percent-encodes the path in every pane URL, the CRX fragment included', () => {
    // `:` is not safe in a URL path, so `jcr:content` is escaped in the content
    // view and in the CRX fragment, which CRXDE Lite decodes back to the JCR
    // path before selecting the node.
    expect(classifyAemPath(AUTHOR, '/apps/x/jcr:content/y')).toEqual(
      pane(`${AUTHOR}/apps/x/jcr%3Acontent/y`, [
        crxAction(`${AUTHOR}/crx/de/index.jsp#/apps/x/jcr%3Acontent/y`),
      ]),
    );
    // A DAM asset preview, its assetdetails Edit, and its CRX all encode the path.
    expect(classifyAemPath(AUTHOR, '/content/dam/x/jcr:content/y.jpg')).toEqual(
      pane(`${AUTHOR}/content/dam/x/jcr%3Acontent/y.jpg`, [
        editAction(`${AUTHOR}/assetdetails.html/content/dam/x/jcr%3Acontent/y.jpg`),
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/dam/x/jcr%3Acontent/y.jpg`),
      ]),
    );
    // Spaces and unicode are escaped too.
    expect(classifyAemPath(AUTHOR, '/content/caf\u00e9/site name/page')).toEqual(
      pane(`${AUTHOR}/content/caf%C3%A9/site%20name/page.html`, [
        editAction(`${AUTHOR}/editor.html/content/caf%C3%A9/site%20name/page.html`),
        crxAction(`${AUTHOR}/crx/de/index.jsp#/content/caf%C3%A9/site%20name/page`),
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
    expect(splitAemPathLinks('See /content/x now', emptyContext).segments).toEqual([
      { kind: 'text', value: 'See /content/x now' },
    ]);
  });

  it('wraps a bare path in prose, keeping the surrounding text', () => {
    expect(segments('See /content/site/en/page now')).toEqual([
      { kind: 'text', value: 'See ' },
      fullLink(
        '/content/site/en/page',
        pane(`${AUTHOR}/content/site/en/page.html`, [
          editAction(`${AUTHOR}/editor.html/content/site/en/page.html`),
          crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/en/page`),
        ]),
      ),
      { kind: 'text', value: ' now' },
    ]);
  });

  it('keeps the bracket and trims a trailing sentence period', () => {
    expect(segments('(/content/x).')).toEqual([
      { kind: 'text', value: '(' },
      fullLink(
        '/content/x',
        pane(`${AUTHOR}/content/x.html`, [
          editAction(`${AUTHOR}/editor.html/content/x.html`),
          crxAction(`${AUTHOR}/crx/de/index.jsp#/content/x`),
        ]),
      ),
      { kind: 'text', value: ').' },
    ]);
  });

  it('does not linkify a root-like segment inside a word', () => {
    expect(segments('not/contentx here')).toEqual([{ kind: 'text', value: 'not/contentx here' }]);
  });

  it('classifies a /content/dam path as a CRX-only non-page', () => {
    expect(segments('/content/dam/x')).toEqual([
      fullLink(
        '/content/dam/x',
        pane(`${AUTHOR}/content/dam/x`, [crxAction(`${AUTHOR}/crx/de/index.jsp#/content/dam/x`)]),
      ),
    ]);
  });

  it('keeps a typographic hyphen (U+2011) inside a bare path instead of stopping at it', () => {
    // Regression for the real chat: `templates/custom‑skeleton/...` was matched
    // only as far as `templates/custom`, so the anchor covered half the path and
    // its href pointed at the wrong node. The displayed text keeps the original
    // U+2011; the resolved link folds it to ASCII `-`.
    expect(segments('/content/site/custom\u2011skeleton/1')).toEqual([
      fullLink(
        '/content/site/custom\u2011skeleton/1',
        pane(`${AUTHOR}/content/site/custom-skeleton/1.html`, [
          editAction(`${AUTHOR}/editor.html/content/site/custom-skeleton/1.html`),
          crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/custom-skeleton/1`),
        ]),
      ),
    ]);
  });

  it('returns the last full path as the state to thread into the next string', () => {
    const result = splitAemPathLinks('See /content/site/a now', activeContext);
    expect(result.state).toEqual({ lastFullPath: '/content/site/a' });
    expect(result.segments).toEqual([
      { kind: 'text', value: 'See ' },
      fullLink(
        '/content/site/a',
        pane(`${AUTHOR}/content/site/a.html`, [
          editAction(`${AUTHOR}/editor.html/content/site/a.html`),
          crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/a`),
        ]),
      ),
      { kind: 'text', value: ' now' },
    ]);
  });
});

describe('linkTargets - partly linkified page-relative paths', () => {
  it('resolves a jcr:content/... value against the remembered page, CRX only', () => {
    expect(
      resolvePartialPathActions('/content/site/en/page', 'jcr:content/parsys/text', AUTHOR),
    ).toEqual([
      crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/en/page/jcr%3Acontent/parsys/text`),
    ]);
  });

  it('trims a remembered resource back to its owning page before prepending', () => {
    expect(
      resolvePartialPathActions(
        '/content/site/en/page/jcr:content/parsys',
        'jcr:content/other',
        AUTHOR,
      ),
    ).toEqual([crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/en/page/jcr%3Acontent/other`)]);
  });

  it('returns nothing without an active host or without a remembered path', () => {
    expect(resolvePartialPathActions('/content/site/a', 'jcr:content/x', undefined)).toEqual([]);
    expect(resolvePartialPathActions(undefined, 'jcr:content/x', AUTHOR)).toEqual([]);
  });

  it('ignores a value that is not page-relative', () => {
    expect(resolvePartialPathActions('/content/site/a', '/content/site/b', AUTHOR)).toEqual([]);
    expect(resolvePartialPathActions('/content/site/a', 'parsys/x', AUTHOR)).toEqual([]);
  });

  it('makes a page-relative path a non-navigable CRX link when a full path precedes it', () => {
    const result = splitAemPathLinks('jcr:content/parsys/text', activeContext, {
      lastFullPath: '/content/site/en/page',
    });
    expect(result.segments).toEqual([
      {
        kind: 'link',
        value: 'jcr:content/parsys/text',
        resolved: pane(
          `${AUTHOR}/crx/de/index.jsp#/content/site/en/page/jcr%3Acontent/parsys/text`,
          [crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/en/page/jcr%3Acontent/parsys/text`)],
        ),
        navigable: false,
      },
    ]);
    // A partial is not a full path: it never becomes the next carry-over.
    expect(result.state).toEqual({ lastFullPath: '/content/site/en/page' });
  });

  it('leaves a page-relative path as text when no full path precedes it', () => {
    expect(splitAemPathLinks('jcr:content/parsys/text', activeContext).segments).toEqual([
      { kind: 'text', value: 'jcr:content/parsys/text' },
    ]);
  });

  it('linkifies a full path and a following relative path in one string, in order', () => {
    const result = splitAemPathLinks('/content/site/a jcr:content/x', activeContext);
    expect(result.segments[0]).toMatchObject({
      kind: 'link',
      navigable: true,
      value: '/content/site/a',
    });
    expect(result.segments[1]).toEqual({ kind: 'text', value: ' ' });
    expect(result.segments[2]).toMatchObject({
      kind: 'link',
      navigable: false,
      value: 'jcr:content/x',
    });
  });
});

describe('linkTargets - absolute URLs', () => {
  it('resolves a URL on a configured host as a pane link', () => {
    expect(segments(`See ${AUTHOR}/content/site/en/page now`)).toEqual([
      { kind: 'text', value: 'See ' },
      fullLink(
        `${AUTHOR}/content/site/en/page`,
        pane(`${AUTHOR}/content/site/en/page.html`, [
          editAction(`${AUTHOR}/editor.html/content/site/en/page.html`),
          crxAction(`${AUTHOR}/crx/de/index.jsp#/content/site/en/page`),
        ]),
      ),
      { kind: 'text', value: ' now' },
    ]);
  });

  it('resolves a URL on another origin as an external link, even with no active host', () => {
    expect(segments('See https://example.com/x now', hostsOnlyContext)).toEqual([
      { kind: 'text', value: 'See ' },
      {
        kind: 'link',
        value: 'https://example.com/x',
        resolved: { openIn: 'external', href: 'https://example.com/x', actions: [] },
        navigable: true,
      },
      { kind: 'text', value: ' now' },
    ]);
  });

  it('trims a trailing sentence period from a URL', () => {
    expect(segments('See https://example.com/x.')).toEqual([
      { kind: 'text', value: 'See ' },
      {
        kind: 'link',
        value: 'https://example.com/x',
        resolved: { openIn: 'external', href: 'https://example.com/x', actions: [] },
        navigable: true,
      },
      { kind: 'text', value: '.' },
    ]);
  });

  it('does not make a URL the carry-over for a later page-relative path', () => {
    const result = splitAemPathLinks('https://example.com/x jcr:content/y', activeContext);
    expect(result.state).toEqual({ lastFullPath: undefined });
    // The relative path has no page to hang off, so it stays text.
    expect(result.segments[1]).toEqual({ kind: 'text', value: ' jcr:content/y' });
  });
});
