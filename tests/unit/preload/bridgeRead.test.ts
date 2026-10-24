import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { performBridgeRead } from '../../../src/preload/bridgeRead';
import {
  DOM_READ_HTML_LIMIT,
  DOM_READ_REDACTED_VALUE,
  DOM_READ_TEXT_LIMIT,
  DOM_READ_TOTAL_LIMIT,
  type WebviewBridgeReadCommand,
} from '../../../src/shared/contracts/webviewBridge';

// A JSDOM instance is built explicitly (not the vitest jsdom pragma) so that the
// type checker sees the `dom` lib, as renderMarkdown.test.ts does.
function pageWith(body: string, title = 'A page'): Document {
  const dom = new JSDOM('', { url: 'https://author.example/content/site/page.html' });
  dom.window.document.title = title;
  dom.window.document.body.innerHTML = body;
  return dom.window.document;
}

function command(overrides: Partial<WebviewBridgeReadCommand> = {}): WebviewBridgeReadCommand {
  return { requestId: 'req-1', selector: 'a', limit: 20, ...overrides };
}

describe('performBridgeRead - what it reads', () => {
  it('returns tag, normalised text and the named attributes, with the match count', () => {
    const doc = pageWith(
      '<a href="/one" rel="nofollow">  First \n  link </a><a href="/two">Second</a>',
    );

    const result = performBridgeRead(command({ attributes: ['href', 'rel', 'missing'] }), doc);

    expect(result).toEqual({
      status: 'ok',
      url: 'https://author.example/content/site/page.html',
      title: 'A page',
      matched: 2,
      truncated: false,
      items: [
        { tag: 'a', text: 'First link', attributes: { href: '/one', rel: 'nofollow' } },
        { tag: 'a', text: 'Second', attributes: { href: '/two' } },
      ],
    });
  });

  it('omits the attributes field when none of the named attributes is present', () => {
    const result = performBridgeRead(command({ attributes: ['href'] }), pageWith('<a>x</a>'));

    expect(result).toMatchObject({ items: [{ tag: 'a', text: 'x' }] });
    expect((result as { items: object[] }).items[0]).not.toHaveProperty('attributes');
  });

  it('returns markup instead of text when asked, and never both', () => {
    const result = performBridgeRead(
      command({ selector: 'p', include: 'html' }),
      pageWith('<p>One <b>bold</b></p>'),
    );

    expect(result).toMatchObject({ items: [{ tag: 'p', html: '<p>One <b>bold</b></p>' }] });
    expect((result as { items: object[] }).items[0]).not.toHaveProperty('text');
  });
});

describe('performBridgeRead - bounds', () => {
  it('returns at most `limit` items but still reports the whole match count', () => {
    const doc = pageWith('<a>1</a><a>2</a><a>3</a>');

    const result = performBridgeRead(command({ limit: 2 }), doc);

    expect(result).toMatchObject({ status: 'ok', matched: 3, truncated: true });
    expect((result as { items: unknown[] }).items).toHaveLength(2);
  });

  it('caps one item text and marks the result truncated', () => {
    const doc = pageWith(`<p>${'x'.repeat(DOM_READ_TEXT_LIMIT + 10)}</p>`);

    const result = performBridgeRead(command({ selector: 'p' }), doc);

    expect(result).toMatchObject({ truncated: true });
    expect((result as { items: { text: string }[] }).items[0]?.text).toHaveLength(
      DOM_READ_TEXT_LIMIT,
    );
  });

  it('allows a longer cap for markup than for text', () => {
    const doc = pageWith(`<p>${'x'.repeat(DOM_READ_HTML_LIMIT)}</p>`);

    const result = performBridgeRead(command({ selector: 'p', include: 'html' }), doc);

    const html = (result as { items: { html: string }[] }).items[0]?.html ?? '';
    expect(html.length).toBeGreaterThan(DOM_READ_TEXT_LIMIT);
    expect(html.length).toBeLessThanOrEqual(DOM_READ_HTML_LIMIT);
  });

  it('stops filling items when the total budget is spent', () => {
    const each = DOM_READ_HTML_LIMIT;
    const count = Math.ceil(DOM_READ_TOTAL_LIMIT / each) + 2;
    const doc = pageWith(`<p>${'y'.repeat(each)}</p>`.repeat(count));

    const result = performBridgeRead(command({ selector: 'p', include: 'html', limit: 200 }), doc);

    const items = (result as { items: { html: string }[] }).items;
    expect(result).toMatchObject({ truncated: true });
    expect(items.reduce((sum, item) => sum + item.html.length, 0)).toBeLessThanOrEqual(
      DOM_READ_TOTAL_LIMIT,
    );
    expect(items.length).toBeLessThan(count);
  });
});

describe('performBridgeRead - refusals', () => {
  it('reports an invalid selector instead of throwing', () => {
    expect(performBridgeRead(command({ selector: 'a[' }), pageWith('<a>x</a>'))).toEqual({
      status: 'invalid_selector',
    });
  });

  it('reports an unknown frame', () => {
    expect(performBridgeRead(command({ frame: '#editor' }), pageWith('<a>x</a>'))).toEqual({
      status: 'frame_unavailable',
    });
  });

  it('reports a frame selector that matches something other than an iframe', () => {
    expect(performBridgeRead(command({ frame: 'a' }), pageWith('<a>x</a>'))).toEqual({
      status: 'frame_unavailable',
    });
  });

  it('reports an invalid frame selector as an unavailable frame', () => {
    expect(performBridgeRead(command({ frame: 'a[' }), pageWith('<a>x</a>'))).toEqual({
      status: 'frame_unavailable',
    });
  });
});

describe('performBridgeRead - redaction', () => {
  it('withholds a password field value and a CSRF hidden field value', () => {
    const doc = pageWith(
      '<input type="password" name="j_password" value="hunter2">' +
        '<input type="hidden" name="csrf" value="abc123">',
    );

    const result = performBridgeRead(command({ selector: 'input', attributes: ['value'] }), doc);

    expect(result).toMatchObject({
      redacted: true,
      items: [
        { attributes: { value: DOM_READ_REDACTED_VALUE } },
        { attributes: { value: DOM_READ_REDACTED_VALUE } },
      ],
    });
  });

  it('masks an attribute whose name looks like a credential', () => {
    const doc = pageWith('<a href="/a" data-auth-token="abc">link</a>');

    const result = performBridgeRead(command({ attributes: ['href', 'data-auth-token'] }), doc);

    expect(result).toMatchObject({
      redacted: true,
      items: [{ attributes: { href: '/a', 'data-auth-token': DOM_READ_REDACTED_VALUE } }],
    });
  });

  it('still returns an ordinary form field value', () => {
    const doc = pageWith('<input type="text" name="q" value="daisy">');

    const result = performBridgeRead(command({ selector: 'input', attributes: ['value'] }), doc);

    expect(result).toMatchObject({ items: [{ attributes: { value: 'daisy' } }] });
    expect(result).not.toHaveProperty('redacted');
  });

  it('strips inline script/style and masks credentials in markup', () => {
    const doc = pageWith(
      '<div id="x"><script>var t = "plainsecret"</script><style>.a{}</style>' +
        '<input type="hidden" name="token" value="abc"><p data-token="t">hi</p></div>',
    );

    const result = performBridgeRead(command({ selector: '#x', include: 'html' }), doc);

    const html = (result as { items: { html: string }[] }).items[0]?.html ?? '';
    expect(html).not.toContain('script');
    expect(html).not.toContain('style');
    expect(html).not.toContain('plainsecret');
    expect(html).not.toContain('abc');
    expect(html).toContain(DOM_READ_REDACTED_VALUE);
    expect(result).toMatchObject({ redacted: true });
  });
});

describe('performBridgeRead - pre-cap allocation', () => {
  function textElement(): Element {
    return {
      tagName: 'A',
      textContent: 'x',
      getAttribute: () => null,
      attributes: [],
      cloneNode: () => textElement(),
      querySelectorAll: () => [],
    } as unknown as Element;
  }

  it('walks the match list only as far as it needs', () => {
    const read: number[] = [];
    const total = 100_000;
    const list = new Proxy<Record<string, unknown>>(
      {},
      {
        get(target, property) {
          if (property === 'length') return total;
          if (typeof property === 'string' && /^\d+$/.test(property)) {
            read.push(Number(property));
            return textElement();
          }
          return Reflect.get(target, property) as unknown;
        },
      },
    );
    const doc = {
      querySelectorAll: () => list,
      location: { href: '' },
      title: '',
    } as unknown as Document;

    const result = performBridgeRead(command({ limit: 3 }), doc);

    expect(read).toEqual([0, 1, 2]);
    expect(result).toMatchObject({ status: 'ok', matched: total, truncated: true });
    expect((result as { items: unknown[] }).items).toHaveLength(3);
  });
});

describe('performBridgeRead - frames', () => {
  it('reads the document of a same-origin iframe instead of the outer one', () => {
    const doc = pageWith('<iframe id="editor"></iframe><a>outer</a>');
    const inner = (doc.querySelector('iframe') as HTMLIFrameElement).contentDocument;
    if (inner === null) throw new Error('the iframe has no document');
    inner.body.innerHTML = '<a href="/inner">inner</a>';

    const result = performBridgeRead(command({ frame: '#editor', attributes: ['href'] }), doc);

    expect(result).toMatchObject({
      status: 'ok',
      matched: 1,
      items: [{ tag: 'a', text: 'inner', attributes: { href: '/inner' } }],
    });
  });
});
