import { describe, expect, it, vi } from 'vitest';
import { PAGE_AUDIT_MAX_FAILURES } from '../../../src/shared';

vi.mock('electron', () => ({ BrowserWindow: class {} }));

const { createPageAudit, lighthouseFailures, parseTarget } =
  await import('../../../src/main/pageAudit');

type Lhr = Parameters<typeof lighthouseFailures>[0];

function lhr(): Lhr {
  return {
    categories: {
      seo: {
        score: 0.5,
        auditRefs: [
          { id: 'light', weight: 1 },
          { id: 'heavy', weight: 5 },
          { id: 'passed', weight: 3 },
          { id: 'info', weight: 0 },
          { id: 'manual', weight: 2 },
        ],
      },
      performance: {
        score: 0.5,
        auditRefs: [
          { id: 'heavy', weight: 5 },
          { id: 'slow', weight: 2 },
        ],
      },
    },
    audits: {
      light: { title: 'Light', score: 0, scoreDisplayMode: 'binary' },
      heavy: { title: 'Heavy', score: 0.2, scoreDisplayMode: 'numeric', displayValue: '3 s' },
      passed: { title: 'Passed', score: 1, scoreDisplayMode: 'binary' },
      info: { title: 'Info', score: 0, scoreDisplayMode: 'binary' },
      manual: { title: 'Manual', score: null, scoreDisplayMode: 'manual' },
      slow: { title: 'Slow', score: 0.4, scoreDisplayMode: 'numeric', displayValue: '' },
    },
  };
}

describe('parseTarget', () => {
  const current = 'https://author.example:4502/editor.html/content/a.html#frag';

  it('uses the page on screen when no address is given', () => {
    expect(parseTarget(undefined, current)?.toString()).toBe(
      'https://author.example:4502/editor.html/content/a.html',
    );
  });

  it('has nothing to audit with neither an address nor a page', () => {
    expect(parseTarget(' ', undefined)).toBe('no_page');
    expect(parseTarget('/content/a.html', undefined)).toBe('no_page');
  });

  it('resolves a rooted path against the origin of the page on screen', () => {
    expect(parseTarget('/content/b.html?x=1', current)?.toString()).toBe(
      'https://author.example:4502/content/b.html?x=1',
    );
  });

  it.each([
    ['another scheme', 'file:///etc/passwd'],
    ['credentials in the address', 'https://user:pw@example.com/'],
    ['a bare word', 'example'],
    ['a protocol-relative address', '//evil.example/'],
  ])('refuses %s', (_label, value) => {
    expect(parseTarget(value, current)).toBeUndefined();
  });

  it('drops the fragment of an absolute address', () => {
    expect(String(parseTarget('https://example.com/p#top', undefined))).toBe(
      'https://example.com/p',
    );
  });
});

describe('lighthouseFailures', () => {
  it('lists only weighted, scored, failing audits, heaviest first, each once', () => {
    const { failures, total } = lighthouseFailures(lhr(), ['seo', 'performance']);

    expect(failures.map((f) => [f.category, f.id])).toEqual([
      ['seo', 'heavy'],
      ['seo', 'light'],
      ['performance', 'slow'],
    ]);
    expect(total).toBe(3);
  });

  it('keeps a display value only when there is one', () => {
    const { failures } = lighthouseFailures(lhr(), ['seo', 'performance']);

    expect(failures[0]?.displayValue).toBe('3 s');
    expect('displayValue' in (failures[2] ?? {})).toBe(false);
  });

  it('only looks at the categories asked for', () => {
    const { failures } = lighthouseFailures(lhr(), ['performance']);

    expect(failures.map((f) => f.id)).toEqual(['heavy', 'slow']);
  });

  it('caps the list but still counts every failure', () => {
    const count = PAGE_AUDIT_MAX_FAILURES + 7;
    const ids = Array.from({ length: count }, (_, i) => `a${String(i)}`);
    const big: Lhr = {
      categories: { seo: { score: 0, auditRefs: ids.map((id) => ({ id, weight: 1 })) } },
      audits: Object.fromEntries(
        ids.map((id) => [id, { title: id, score: 0, scoreDisplayMode: 'binary' }]),
      ),
    };

    const { failures, total } = lighthouseFailures(big, ['seo']);

    expect(failures).toHaveLength(PAGE_AUDIT_MAX_FAILURES);
    expect(total).toBe(count);
  });
});

describe('createPageAudit', () => {
  function runner(currentUrl: string | undefined) {
    return createPageAudit({
      paneSession: {} as never,
      anonymousSession: () => {
        throw new Error('no session expected');
      },
      currentUrl: () => currentUrl,
      isConfiguredOrigin: () => false,
      resolveAddresses: () => Promise.resolve(['10.0.0.5']),
    });
  }
  const request = { url: undefined, categories: ['seo'], formFactor: 'mobile' } as const;

  it('has nothing to audit when the pane shows no page', async () => {
    expect(await runner(undefined)(request, undefined)).toEqual({ kind: 'no_page' });
  });

  it('refuses an address that is not a web address', async () => {
    expect(
      await runner('https://a.example/')({ ...request, url: 'ftp://a.example/' }, undefined),
    ).toEqual({ kind: 'invalid_url' });
  });

  it('refuses a page outside the configured hosts that resolves to a private address', async () => {
    expect(
      await runner('https://a.example/')(
        { ...request, url: 'https://intranet.example/' },
        undefined,
      ),
    ).toMatchObject({ kind: 'blocked' });
  });
});
