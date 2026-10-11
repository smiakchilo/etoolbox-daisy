// noinspection HtmlUnknownTarget

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { createMarkdownRenderer } from '../../../../src/renderer/src/chat/renderMarkdown';
import { parseLinkActions } from '../../../../src/renderer/src/chat/linkTargets';

// `tsconfig.test.json` compiles this test suite against the `ES2023` lib
// only (no `dom`), matching the Node-oriented rest of `tests/**`. Rather than
// relying on vitest's `@vitest-environment jsdom` pragma — which changes the
// *runtime* global scope but does nothing for the *type checker*, and would
// leave `window`/`document`/`DOMParser` as unresolvable names under
// `tsc --build` — we construct a `JSDOM` instance explicitly. Importing the
// `jsdom` package pulls in `@types/jsdom`, whose declaration file carries
// `/// <reference lib="dom" />`, which is what actually makes `Window`,
// `Document`, and `DOMParser` resolve for this file.
//
// `dom.window` is passed to the factory exactly like a real renderer
// `Window` would be; the module under test never reaches for an ambient
// global itself, so this is a faithful exercise of the public contract.
//
// `@types/jsdom`'s `DOMWindow` is a structural approximation of `Window`
// (it deliberately omits/narrows a few circular members such as `top`) and
// does not claim to satisfy `typeof globalThis`, so a direct cast is
// rejected as non-overlapping; going through `unknown` is the standard,
// deliberate escape hatch for "this is the runtime shape the real code
// expects, but the two ambient type sources don't structurally align".
const dom = new JSDOM();
const renderer = createMarkdownRenderer(dom.window as unknown as Window & typeof globalThis);

/** Parses `html` into a detached document so assertions query real DOM nodes. */
function parse(html: string): Document {
  return new dom.window.DOMParser().parseFromString(html, 'text/html');
}

const AUTHOR = 'https://author.example';
const ACTIVE_CONTEXT = { hostOrigins: [AUTHOR], activeOrigin: AUTHOR };
const HOSTS_ONLY_CONTEXT = { hostOrigins: [AUTHOR], activeOrigin: undefined };

describe('createMarkdownRenderer - AEM link rewriting (link context)', () => {
  it('rewrites a relative /content page link to its rendered URL and marks it as a pane link', () => {
    const doc = parse(renderer.render('[Page](/content/site/en/page)', ACTIVE_CONTEXT));
    const anchor = doc.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe(`${AUTHOR}/content/site/en/page.html`);
    expect(anchor?.hasAttribute('data-daisy-link')).toBe(true);
    expect(anchor?.hasAttribute('data-daisy-external')).toBe(false);
    expect(anchor?.textContent).toBe('Page');
  });

  it('previews a relative /content/dam asset', () => {
    const doc = parse(renderer.render('[Asset](/content/dam/x/y.jpg)', ACTIVE_CONTEXT));
    expect(doc.querySelector('a')?.getAttribute('href')).toBe(`${AUTHOR}/content/dam/x/y.jpg`);
  });

  it('opens a /content/dam non-asset raw (CRX popover only)', () => {
    const doc = parse(renderer.render('[Asset](/content/dam/x/y)', ACTIVE_CONTEXT));
    expect(doc.querySelector('a')?.getAttribute('href')).toBe(`${AUTHOR}/content/dam/x/y`);
  });

  it('trims a jcr:content resource link to its owning page but keeps CRX on the resource', () => {
    const doc = parse(renderer.render('[C](/content/a/b/jcr:content/x)', ACTIVE_CONTEXT));
    const anchor = doc.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe(`${AUTHOR}/content/a/b.html`);
    expect(anchor?.hasAttribute('data-daisy-link')).toBe(true);
    // The popover actions are stamped from the *original* resource path, so
    // re-classifying the trimmed href can never retarget CRX at the page.
    expect(parseLinkActions(anchor?.getAttribute('data-daisy-actions') ?? null)).toEqual([
      { id: 'edit', title: 'Edit', href: `${AUTHOR}/editor.html/content/a/b.html` },
      { id: 'crx', title: 'CRX', href: `${AUTHOR}/crx/de/index.jsp#/content/a/b/jcr%3Acontent/x` },
    ]);
  });

  it('linkifies a bare jcr:content path with the same page href and resource CRX', () => {
    const doc = parse(renderer.render('See /content/a/b/jcr:content/x now.', ACTIVE_CONTEXT));
    const anchor = doc.querySelector('a[data-daisy-link]');
    expect(anchor?.getAttribute('href')).toBe(`${AUTHOR}/content/a/b.html`);
    expect(parseLinkActions(anchor?.getAttribute('data-daisy-actions') ?? null)).toEqual([
      { id: 'edit', title: 'Edit', href: `${AUTHOR}/editor.html/content/a/b.html` },
      { id: 'crx', title: 'CRX', href: `${AUTHOR}/crx/de/index.jsp#/content/a/b/jcr%3Acontent/x` },
    ]);
  });

  it('percent-encodes jcr:content in the content-view href and the CRX fragment alike', () => {
    const doc = parse(renderer.render('See /apps/x/jcr:content/y now.', ACTIVE_CONTEXT));
    const anchor = doc.querySelector('a[data-daisy-link]');
    expect(anchor?.getAttribute('href')).toBe(`${AUTHOR}/apps/x/jcr%3Acontent/y`);
    expect(parseLinkActions(anchor?.getAttribute('data-daisy-actions') ?? null)).toEqual([
      { id: 'crx', title: 'CRX', href: `${AUTHOR}/crx/de/index.jsp#/apps/x/jcr%3Acontent/y` },
    ]);
  });

  it('linkifies a bare AEM path in prose', () => {
    const doc = parse(renderer.render('See /content/site/en/page for details.', ACTIVE_CONTEXT));
    const anchor = doc.querySelector('a[data-daisy-link]');
    expect(anchor?.getAttribute('href')).toBe(`${AUTHOR}/content/site/en/page.html`);
    expect(doc.body.textContent?.trim()).toBe('See /content/site/en/page for details.');
  });

  it('linkifies a bare AEM path that starts a paragraph', () => {
    // Regression: a path at the start of an HTML block is preceded by `>` (the
    // opening tag), so a fast-path probe requiring a whitespace/bracket
    // boundary would skip the linkification passes and leave it as text.
    const doc = parse(
      renderer.render('Waldo is in:\n\n/content/site/en/page\n\nThat node.', ACTIVE_CONTEXT),
    );
    const anchor = doc.querySelector('a[data-daisy-link]');
    expect(anchor?.getAttribute('href')).toBe(`${AUTHOR}/content/site/en/page.html`);
    expect(doc.body.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Waldo is in: /content/site/en/page That node.',
    );
  });

  it('linkifies a bare AEM path inside inline code', () => {
    const doc = parse(renderer.render('`/content/inline`', ACTIVE_CONTEXT));
    const anchor = doc.querySelector('a[data-daisy-link]');
    expect(anchor?.getAttribute('href')).toBe(`${AUTHOR}/content/inline.html`);
    expect(doc.querySelector('code')?.textContent).toBe('/content/inline');
  });

  it('linkifies a path with a U+2011 hyphen over its full length, folding it in the href', () => {
    const doc = parse(
      renderer.render('See /content/site/custom\u2011skeleton/1 now.', ACTIVE_CONTEXT),
    );
    const anchor = doc.querySelector('a[data-daisy-link]');
    // The anchor covers the whole path, not just the part before the hyphen...
    expect(anchor?.textContent).toBe('/content/site/custom\u2011skeleton/1');
    // ...and it links to the ASCII node the repository actually stores.
    expect(anchor?.getAttribute('href')).toBe(`${AUTHOR}/content/site/custom-skeleton/1.html`);
  });

  it('linkifies a bare AEM path inside a fenced code block', () => {
    const doc = parse(renderer.render('```\n/content/fenced\n```\n', ACTIVE_CONTEXT));
    const anchor = doc.querySelector('a[data-daisy-link]');
    expect(anchor?.getAttribute('href')).toBe(`${AUTHOR}/content/fenced.html`);
    // The fenced block keeps its trailing newline; the path itself is the anchor.
    expect(doc.querySelector('pre code')?.textContent?.trim()).toBe('/content/fenced');
  });

  it('linkifies the jcr:content path a model wraps in inline code (reported case)', () => {
    // Regression: a JCR path written as `` **Node:** `/content/.../jcr:content` ``
    // used to stay plain text because the linkifier skipped `code`/`pre`
    // content, while the same path bare in prose became a link.
    const doc = parse(
      renderer.render(
        '**Node:** `/content/hpe/base/blueprint/regression/components/' +
          'new-country-selector-template/home-page-5/jcr:content`',
        ACTIVE_CONTEXT,
      ),
    );
    const anchor = doc.querySelector('a[data-daisy-link]');
    expect(anchor?.getAttribute('href')).toBe(
      `${AUTHOR}/content/hpe/base/blueprint/regression/components/` +
        'new-country-selector-template/home-page-5.html',
    );
    expect(parseLinkActions(anchor?.getAttribute('data-daisy-actions') ?? null)).toEqual([
      {
        id: 'edit',
        title: 'Edit',
        href:
          `${AUTHOR}/editor.html/content/hpe/base/blueprint/regression/components/` +
          'new-country-selector-template/home-page-5.html',
      },
      {
        id: 'crx',
        title: 'CRX',
        href:
          `${AUTHOR}/crx/de/index.jsp#/content/hpe/base/blueprint/regression/components/` +
          'new-country-selector-template/home-page-5/jcr%3Acontent',
      },
    ]);
  });

  it('does not linkify a path inside an existing anchor', () => {
    // A nested `<a>` is invalid, and the outer anchor already carries its own
    // target, so the anchor's own text is left alone.
    const doc = parse(renderer.render('[see /content/x](https://other.example/y)', ACTIVE_CONTEXT));
    expect(doc.querySelectorAll('a[data-daisy-link]')).toHaveLength(0);
    expect(doc.querySelectorAll('a')).toHaveLength(1);
    expect(doc.querySelector('a')?.textContent).toBe('see /content/x');
  });

  it('rewrites an absolute configured-host page link to its rendered URL', () => {
    const doc = parse(renderer.render(`[P](${AUTHOR}/content/x.html)`, ACTIVE_CONTEXT));
    expect(doc.querySelector('a')?.getAttribute('href')).toBe(`${AUTHOR}/content/x.html`);
    expect(doc.querySelector('a')?.hasAttribute('data-daisy-link')).toBe(true);
  });

  it('marks an external link as opening in the browser', () => {
    const doc = parse(renderer.render('[E](https://other.example/x)', ACTIVE_CONTEXT));
    const anchor = doc.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://other.example/x');
    expect(anchor?.hasAttribute('data-daisy-external')).toBe(true);
    expect(anchor?.hasAttribute('data-daisy-link')).toBe(false);
    expect(anchor?.getAttribute('title')).toBe('Opens in your browser');
  });

  it('does not make a relative path clickable when no host is active', () => {
    const doc = parse(renderer.render('[Page](/content/site/en/page)', HOSTS_ONLY_CONTEXT));
    // The sanitizer strips the relative href and no marker is added, so the
    // link degrades to its plain text.
    expect(doc.querySelector('a')?.getAttribute('href')).toBeNull();
    expect(doc.querySelector('a')?.hasAttribute('data-daisy-link')).toBe(false);
    expect(doc.body.textContent).toContain('Page');
  });

  it('keeps a bare path as plain text when no host is active', () => {
    const html = renderer.render('See /content/site/en/page', HOSTS_ONLY_CONTEXT);
    expect(parse(html).querySelectorAll('a')).toHaveLength(0);
  });

  it('still marks an external link with no configured hosts at all', () => {
    const doc = parse(renderer.render('[E](https://other.example/x)'));
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('https://other.example/x');
    expect(doc.querySelector('a')?.hasAttribute('data-daisy-external')).toBe(true);
    // A relative path is still inert with no context.
    expect(
      parse(renderer.render('[P](/content/x)')).querySelector('a')?.getAttribute('href'),
    ).toBeNull();
  });
});

describe('createMarkdownRenderer', () => {
  describe('GFM tables', () => {
    it('renders a table to real DOM elements with the expected cell text', () => {
      const html = renderer.render('| Name | Age |\n| --- | --- |\n| Ada | 36 |\n');
      const doc = parse(html);

      const table = doc.querySelector('table');
      expect(table).not.toBeNull();
      expect(doc.querySelectorAll('thead th')).toHaveLength(2);
      const headerTexts = Array.from(doc.querySelectorAll('thead th')).map((th) => th.textContent);
      expect(headerTexts).toEqual(['Name', 'Age']);

      const rowCells = Array.from(doc.querySelectorAll('tbody tr td')).map((td) => td.textContent);
      expect(rowCells).toEqual(['Ada', '36']);

      // The table must never degrade to a literal "|---|" separator string.
      expect(html).not.toContain('---');
    });

    it('preserves colspan/rowspan on table cells', () => {
      const html = renderer.render(
        '<table><tbody><tr><td colspan="2" rowspan="3">merged</td></tr></tbody></table>',
      );
      const doc = parse(html);
      const cell = doc.querySelector('td');
      expect(cell?.getAttribute('colspan')).toBe('2');
      expect(cell?.getAttribute('rowspan')).toBe('3');
    });

    it('preserves GFM column alignment', () => {
      const html = renderer.render('| A | B |\n| :-- | --: |\n| x | y |\n');
      const doc = parse(html);
      const headers = Array.from(doc.querySelectorAll('thead th'));
      expect(headers[0]?.getAttribute('align')).toBe('left');
      expect(headers[1]?.getAttribute('align')).toBe('right');
    });
  });

  describe('script exclusion', () => {
    it('produces no script element for a <script> tag in the markdown body', () => {
      const html = renderer.render('Hello <script>alert(1)</script> world');
      const doc = parse(html);
      expect(doc.querySelectorAll('script')).toHaveLength(0);
      expect(html.toLowerCase()).not.toContain('<script');
    });

    // noinspection CommaExpressionJS
    it('renders a fenced code block containing <script> as escaped text, not a live element', () => {
      const html = renderer.render('```\n<script>alert(1)</script>\n```\n');
      const doc = parse(html);
      expect(doc.querySelectorAll('script')).toHaveLength(0);

      const codeElement = doc.querySelector('pre code');
      expect(codeElement).not.toBeNull();
      expect(codeElement?.textContent).toContain('<script>alert(1)</script>');
    });
  });

  describe('href scheme policy', () => {
    it('drops a javascript: href', () => {
      const html = renderer.render('[x](javascript:alert(1))');
      expect(html.toLowerCase()).not.toContain('javascript:');
      const doc = parse(html);
      expect(doc.querySelector('a')?.getAttribute('href')).toBeNull();
    });

    it('drops a mixed-case JaVaScRiPt: href', () => {
      const html = renderer.render('<a href="JaVaScRiPt:alert(1)">click</a>');
      expect(html.toLowerCase()).not.toContain('javascript:');
    });

    it('drops an HTML-entity-obfuscated java&#115;cript: href', () => {
      const html = renderer.render('<a href="java&#115;cript:alert(1)">click</a>');
      expect(html.toLowerCase()).not.toContain('javascript:');
      const doc = parse(html);
      expect(doc.querySelector('a')?.getAttribute('href')).toBeNull();
    });

    it('drops an href obfuscated with leading whitespace/control characters', () => {
      const html = renderer.render('<a href="&#9;&#10;javascript:alert(1)">click</a>');
      expect(html.toLowerCase()).not.toContain('javascript:');
    });

    it('drops a data: href', () => {
      const html = renderer.render('<a href="data:text/html,<script>alert(1)</script>">click</a>');
      expect(html.toLowerCase()).not.toContain('data:');
    });

    it('drops a scheme-relative href', () => {
      const html = renderer.render('<a href="//evil.example/phish">click</a>');
      const doc = parse(html);
      expect(doc.querySelector('a')?.getAttribute('href')).toBeNull();
    });

    it('keeps an https:// href intact', () => {
      const html = renderer.render('[docs](https://example.com/path)');
      const doc = parse(html);
      expect(doc.querySelector('a')?.getAttribute('href')).toBe('https://example.com/path');
    });

    it('keeps a mailto: href intact', () => {
      const html = renderer.render('[mail](mailto:person@example.com)');
      const doc = parse(html);
      expect(doc.querySelector('a')?.getAttribute('href')).toBe('mailto:person@example.com');
    });
  });

  describe('remote images', () => {
    // noinspection HtmlRequiredAltAttribute
    it('never lets an <img> perform a network fetch: no beacon URL survives in any attribute', () => {
      const html = renderer.render('![tracker](https://evil.example/beacon.png "title")');
      expect(html.toLowerCase()).not.toContain('evil.example');

      const doc = parse(html);
      const img = doc.querySelector('img');
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBeNull();
      expect(img?.getAttribute('alt')).toBe('tracker');
    });

    it('drops a data: image src the same way', () => {
      const html = renderer.render('<img src="data:image/png;base64,AAAA" alt="inline">');
      const doc = parse(html);
      expect(doc.querySelector('img')?.getAttribute('src')).toBeNull();
      expect(doc.querySelector('img')?.getAttribute('alt')).toBe('inline');
    });
  });

  describe('inline event handlers', () => {
    it('strips an onclick handler from a link but may keep its text', () => {
      const html = renderer.render('<a href="#" onclick="alert(1)">click me</a>');
      expect(html.toLowerCase()).not.toContain('onclick');
      const doc = parse(html);
      expect(doc.querySelector('a')?.getAttribute('onclick')).toBeNull();
      expect(doc.body.textContent).toContain('click me');
    });

    it('strips onerror from an img tag', () => {
      // noinspection HtmlDeprecatedAttribute
      const html = renderer.render('<img src="x" onerror="alert(1)" alt="pic">');
      expect(html.toLowerCase()).not.toContain('onerror');
    });
  });

  describe('active-content tags do not survive', () => {
    it('removes an <iframe>', () => {
      const html = renderer.render('<iframe src="https://evil.example"></iframe>');
      const doc = parse(html);
      expect(doc.querySelectorAll('iframe')).toHaveLength(0);
      expect(html.toLowerCase()).not.toContain('evil.example');
    });

    it('removes an <object>', () => {
      const html = renderer.render('<object data="https://evil.example"></object>');
      const doc = parse(html);
      expect(doc.querySelectorAll('object')).toHaveLength(0);
    });

    it('removes an <embed>', () => {
      const html = renderer.render('<embed src="https://evil.example">');
      const doc = parse(html);
      expect(doc.querySelectorAll('embed')).toHaveLength(0);
    });

    it('removes an <svg onload=...> entirely, including its children', () => {
      const html = renderer.render('<svg onload="alert(1)"><circle r="1"/></svg>');
      const doc = parse(html);
      expect(doc.querySelectorAll('svg')).toHaveLength(0);
      expect(html.toLowerCase()).not.toContain('onload');
    });

    it('removes a <math> element', () => {
      const html = renderer.render('<math><mtext>x</mtext></math>');
      const doc = parse(html);
      expect(doc.querySelectorAll('math')).toHaveLength(0);
    });

    it('removes form/input/button/link/meta/base', () => {
      // noinspection JSUnresolvedLibraryURL
      const html = renderer.render(
        '<form action="https://evil.example"><input name="x"><button>go</button></form>' +
          '<link rel="stylesheet" href="https://evil.example/x.css">' +
          '<meta http-equiv="refresh" content="0;url=https://evil.example">' +
          '<base href="https://evil.example/">',
      );
      const doc = parse(html);
      for (const tag of ['form', 'input', 'button', 'link', 'meta', 'base']) {
        expect(doc.querySelectorAll(tag)).toHaveLength(0);
      }
    });

    it('removes target from a link', () => {
      const html = renderer.render('<a href="https://example.com" target="_blank">go</a>');
      const doc = parse(html);
      expect(doc.querySelector('a')?.getAttribute('target')).toBeNull();
    });
  });

  describe('ordinary prose formatting survives', () => {
    it('renders headings, bold, italic, lists, blockquote, and inline code', () => {
      const markdown = [
        '# Title',
        '',
        'Some **bold** and *italic* text with `inline code`.',
        '',
        '- one',
        '- two',
        '',
        '> a quote',
        '',
      ].join('\n');
      const html = renderer.render(markdown);
      const doc = parse(html);

      expect(doc.querySelector('h1')?.textContent).toBe('Title');
      expect(doc.querySelector('strong')?.textContent).toBe('bold');
      expect(doc.querySelector('em')?.textContent).toBe('italic');
      expect(doc.querySelector('code')?.textContent).toBe('inline code');
      expect(Array.from(doc.querySelectorAll('li')).map((li) => li.textContent)).toEqual([
        'one',
        'two',
      ]);
      expect(doc.querySelector('blockquote')?.textContent?.trim()).toBe('a quote');
    });

    it('renders an ordered list, a horizontal rule, and strikethrough', () => {
      const html = renderer.render('1. first\n2. second\n\n---\n\n~~gone~~\n');
      const doc = parse(html);
      expect(Array.from(doc.querySelectorAll('ol li')).map((li) => li.textContent)).toEqual([
        'first',
        'second',
      ]);
      expect(doc.querySelectorAll('hr')).toHaveLength(1);
      expect(doc.querySelector('del')?.textContent).toBe('gone');
    });
  });
});
