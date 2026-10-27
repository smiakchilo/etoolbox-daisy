import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindowConstructorOptions } from 'electron';
import {
  createPageAudit,
  inspectAuditRequest,
  lighthouseFailures,
  parseTarget,
} from '../../../../src/addons/page-audit/pageAudit';

/**
 * The audit is an add-on: it creates no window of its own and performs no DNS
 * resolution. Both are injected by the application, so these tests drive the
 * window and the address policy directly instead of mocking Electron.
 */

interface FakeWindow {
  readonly options: BrowserWindowConstructorOptions;
  readonly webContents: FakeWebContents;
  destroyed: boolean;
  isDestroyed(): boolean;
  destroy(): void;
  loadURL(url: string): Promise<void>;
}

interface FakeWebContents {
  readonly id: number;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly debugger: Record<string, unknown>;
  setFrameRate: () => void;
  setWindowOpenHandler: () => void;
  setWebRTCIPHandlingPolicy: (policy: string) => void;
  on: (event: string, listener: (...args: never[]) => void) => void;
  getTitle: () => string;
  getURL: () => string;
  loadUrl: (url: string) => Promise<void>;
}

function createWindowFactory(): {
  readonly windows: FakeWindow[];
  setLoadUrl(handler: (url: string) => Promise<void>): void;
  reset(): void;
  create(options: FakeWindow['options']): FakeWindow;
} {
  const windows: FakeWindow[] = [];
  let loadUrl: (url: string) => Promise<void> = () => new Promise<void>(() => undefined);
  let nextId = 7;

  const create = (options: FakeWindow['options']): FakeWindow => {
    const webContents: FakeWebContents = {
      id: nextId,
      stop: vi.fn(),
      debugger: {
        attach: vi.fn(),
        detach: vi.fn(),
        sendCommand: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
      },
      setFrameRate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      setWebRTCIPHandlingPolicy: vi.fn(),
      on: vi.fn(),
      getTitle: () => 'audit',
      getURL: () => 'https://a.example/',
      loadUrl: (url: string) => loadUrl(url),
    };
    nextId += 1;
    const window: FakeWindow = {
      options,
      webContents,
      destroyed: false,
      isDestroyed: () => window.destroyed,
      destroy: () => {
        window.destroyed = true;
      },
      loadURL: (url: string) => webContents.loadUrl(url),
    };
    windows.push(window);
    return window;
  };

  return {
    windows,
    setLoadUrl: (handler) => {
      loadUrl = handler;
    },
    reset: () => {
      windows.length = 0;
      loadUrl = () => new Promise<void>(() => undefined);
    },
    create,
  };
}

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
          { id: 'related', weight: 1 },
          { id: 'meta', weight: 1 },
          { id: 'saving', weight: 0 },
          { id: 'breakdown', weight: 0 },
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
      light: {
        title: 'Light',
        score: 0,
        scoreDisplayMode: 'binary',
        details: {
          type: 'table',
          headings: [{ key: 'node', valueType: 'node', label: 'Failing Elements' }],
          items: [
            {
              node: {
                type: 'node',
                nodeLabel: 'h4',
                selector: 'h4.card__title',
                snippet: '<h4 class="card__title">Our products</h4>',
                explanation: 'Heading level 4 is not sequentially descending',
              },
            },
          ],
        },
      },
      heavy: {
        title: 'Heavy',
        score: 0.2,
        scoreDisplayMode: 'numeric',
        displayValue: '3 s',
        details: {
          type: 'opportunity',
          headings: [
            { key: 'url', valueType: 'url', label: 'URL' },
            { key: 'wastedBytes', valueType: 'bytes', label: 'Wasted' },
          ],
          items: [
            {
              url: { type: 'url', value: 'https://cdn.example/x.css' },
              wastedBytes: 2048,
            },
          ],
        },
      },
      passed: { title: 'Passed', score: 1, scoreDisplayMode: 'binary' },
      info: { title: 'Info', score: 0, scoreDisplayMode: 'binary' },
      manual: { title: 'Manual', score: null, scoreDisplayMode: 'manual' },
      slow: { title: 'Slow', score: 0.4, scoreDisplayMode: 'numeric', displayValue: '' },
      related: {
        title: 'Related elements',
        score: 0,
        scoreDisplayMode: 'binary',
        details: {
          type: 'table',
          headings: [
            {
              key: 'node',
              valueType: 'node',
              label: 'Element',
              subItemsHeading: { key: 'relatedNode', valueType: 'node' },
            },
          ],
          items: [
            {
              node: { type: 'node', selector: 'a.cta' },
              subItems: {
                type: 'subitems',
                items: [{ relatedNode: { type: 'node', selector: '#footer' } }],
              },
            },
          ],
        },
      },
      meta: {
        title: 'No meta description',
        score: 0,
        scoreDisplayMode: 'binary',
        description:
          'The page has no meta description. [Learn more](https://developer.chrome.com/meta).',
      },
      saving: {
        title: 'Render blocking requests',
        score: null,
        scoreDisplayMode: 'informative',
        displayValue: 'Est savings of 300 ms',
        metricSavings: { LCP: 300 },
        details: {
          type: 'table',
          headings: [{ key: 'url', valueType: 'url', label: 'URL' }],
          items: [{ url: { type: 'url', value: 'https://cdn.example/blocking.css' } }],
        },
      },
      breakdown: {
        title: 'LCP breakdown',
        score: null,
        scoreDisplayMode: 'informative',
        details: {
          type: 'table',
          headings: [{ key: 'label', valueType: 'text', label: 'Subpart' }],
          items: [{ label: 'Time to first byte' }],
        },
      },
    },
  };
}

function session() {
  type RequestHandler = (
    details: { url: string; webContentsId?: number },
    callback: (r: object) => void,
  ) => void;
  let requestHandler: RequestHandler | undefined;
  return {
    clearStorageData: vi.fn(() => Promise.resolve()),
    webRequest: {
      onBeforeRequest: vi.fn((handler: RequestHandler | null) => {
        requestHandler = handler ?? undefined;
      }),
    },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    /** Deliver one request to the filter the audit installed. */
    deliver: async (url: string, webContentsId?: number): Promise<{ cancel?: boolean }> => {
      if (requestHandler === undefined) throw new Error('no request filter installed');
      return await new Promise<{ cancel?: boolean }>((resolve) => {
        requestHandler?.(webContentsId === undefined ? { url } : { url, webContentsId }, resolve);
      });
    },
    hasHandler: () => requestHandler !== undefined,
  };
}

/** An address policy that trusts the two public hosts these tests use. */
function addressPolicy(allow: (url: URL) => boolean = (url) => url.hostname === 'a.example') {
  return vi.fn((url: URL) => Promise.resolve({ allowed: allow(url) }));
}

/** The display text of one report cell, for `.toContain` assertions. */
function textOf(cell: unknown): string {
  if (typeof cell !== 'object' || cell === null) return '';
  const c = cell as {
    readonly kind: string;
    readonly value?: string;
    readonly selector?: string;
    readonly snippet?: string;
    readonly label?: string;
    readonly explanation?: string;
    readonly items?: readonly unknown[];
  };
  switch (c.kind) {
    case 'text':
      return c.value ?? '';
    case 'selector':
      return [c.label, c.selector, c.snippet, c.explanation]
        .filter((part) => part !== undefined && part !== '')
        .join(' — ');
    case 'list':
      return (c.items ?? []).map(textOf).join('; ');
    default:
      return '';
  }
}

/** The `value` of a `text` cell, or `undefined` for any other cell kind. */
function cellValue(cell: unknown): string | undefined {
  if (typeof cell !== 'object' || cell === null) return undefined;
  const c = cell as { readonly kind: string; readonly value?: string };
  return c.kind === 'text' ? c.value : undefined;
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
  it('lists every audit that did not pass, heaviest first, each once', () => {
    const failures = lighthouseFailures(lhr(), ['seo', 'performance']);

    expect(failures.map((f) => [f.category, f.id])).toEqual([
      ['seo', 'heavy'],
      ['seo', 'light'],
      ['seo', 'related'],
      ['seo', 'meta'],
      ['seo', 'info'],
      ['seo', 'saving'],
      ['performance', 'slow'],
    ]);
  });

  it('keeps a display value only when there is one', () => {
    const failures = lighthouseFailures(lhr(), ['seo', 'performance']);

    expect(failures[0]?.displayValue).toBe('3 s');
    expect('displayValue' in (failures[4] ?? {})).toBe(false);
  });

  it('includes an insight Lighthouse measured a saving for, not one that only explains a metric', () => {
    const failures = lighthouseFailures(lhr(), ['seo']);
    const saving = failures.find((failure) => failure.id === 'saving');

    expect(failures.map((failure) => failure.id)).toContain('saving');
    expect(failures.map((failure) => failure.id)).not.toContain('breakdown');
    expect(saving).toMatchObject({ score: null, displayValue: 'Est savings of 300 ms' });
    expect(saving?.evidence).toEqual([
      {
        kind: 'table',
        columns: [{ key: 'url', label: 'URL' }],
        rows: [[{ kind: 'text', value: 'https://cdn.example/blocking.css' }]],
      },
    ]);
  });

  it('only looks at the categories asked for', () => {
    const failures = lighthouseFailures(lhr(), ['performance']);

    expect(failures.map((f) => f.id)).toEqual(['heavy', 'slow']);
  });

  it('lists every failure: nothing is dropped or capped', () => {
    const count = 60;
    const ids = Array.from({ length: count }, (_, i) => `a${String(i)}`);
    const big: Lhr = {
      categories: { seo: { score: 0, auditRefs: ids.map((id) => ({ id, weight: 1 })) } },
      audits: Object.fromEntries(
        ids.map((id) => [id, { title: id, score: 0, scoreDisplayMode: 'binary' }]),
      ),
    };

    expect(lighthouseFailures(big, ['seo'])).toHaveLength(count);
  });

  it('carries the table Lighthouse reported, with its own headings', () => {
    const failures = lighthouseFailures(lhr(), ['seo']);

    expect(failures[0]?.evidence).toEqual([
      {
        kind: 'table',
        columns: [
          { key: 'url', label: 'URL' },
          { key: 'wastedBytes', label: 'Wasted' },
        ],
        rows: [
          [
            { kind: 'text', value: 'https://cdn.example/x.css' },
            { kind: 'text', value: '2.0 KB' },
          ],
        ],
      },
    ]);
  });

  it('renders a failing element as its label, selector, snippet and explanation', () => {
    const failures = lighthouseFailures(lhr(), ['seo']);
    const block = failures[1]?.evidence[0];

    expect(block).toMatchObject({
      kind: 'table',
      rows: [
        [
          {
            kind: 'selector',
            selector: 'h4.card__title',
            snippet: '<h4 class="card__title">Our products</h4>',
            label: 'h4',
            explanation: 'Heading level 4 is not sequentially descending',
          },
        ],
      ],
    });
  });

  it('renders nested sub-items in their own column', () => {
    const failures = lighthouseFailures(lhr(), ['seo']);
    const block = failures[2]?.evidence[0];

    expect(
      block?.kind === 'table' ? block.columns.map((column) => column.label) : undefined,
    ).toEqual(['Element', 'Sub items']);
    const subItems = block?.kind === 'table' ? block.rows[0]?.[1] : undefined;
    expect(subItems).toMatchObject({ kind: 'list' });
    expect(textOf(subItems)).toContain('#footer');
  });

  it('keeps a sub-item that only a key-less heading describes', () => {
    const legacy: Lhr = {
      categories: { performance: { score: 0, auditRefs: [{ id: 'legacy', weight: 1 }] } },
      audits: {
        legacy: {
          title: 'Legacy JavaScript',
          score: 0,
          scoreDisplayMode: 'binary',
          details: {
            type: 'table',
            headings: [
              {
                key: 'url',
                valueType: 'url',
                label: 'URL',
                subItemsHeading: { key: 'location', valueType: 'source-location' },
              },
              // The deprecated signal's own column has no key, so it builds no
              // column - but its sub-items still have to appear.
              { key: null, valueType: 'code', label: '', subItemsHeading: { key: 'signal' } },
            ],
            items: [
              {
                url: { type: 'url', value: 'https://a.example/app.js' },
                subItems: {
                  type: 'subitems',
                  items: [
                    {
                      signal: 'URLSearchParams',
                      location: {
                        type: 'source-location',
                        url: 'https://a.example/app.js',
                        line: 41,
                        column: 7,
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    };

    const [failure] = lighthouseFailures(legacy, ['performance']);
    const block = failure?.evidence[0];
    expect(
      block?.kind === 'table' ? block.columns.map((column) => column.label) : undefined,
    ).toEqual(['URL', 'Sub items']);
    const subItems = block?.kind === 'table' ? block.rows[0]?.[1] : undefined;
    const text = textOf(subItems);
    expect(text).toContain('URLSearchParams');
    expect(text).toContain('https://a.example/app.js:42:7');
  });

  it("shows Lighthouse's own explanation for an audit with no items", () => {
    const failures = lighthouseFailures(lhr(), ['seo']);

    expect(failures[3]?.evidence).toEqual([
      {
        kind: 'text',
        value: expect.stringContaining('The page has no meta description') as unknown,
      },
    ]);
    expect(textOf(failures[3]?.evidence[0])).toContain('https://developer.chrome.com/meta');
  });

  it('keeps only the explanation for an itemless audit - not the title or display value', () => {
    const metric: Lhr = {
      categories: { performance: { score: 0.4, auditRefs: [{ id: 'tbt', weight: 1 }] } },
      audits: {
        tbt: {
          title: 'Total Blocking Time',
          description:
            'Sum of all time periods between FCP and Time to Interactive, when task length exceeded 50ms. ' +
            '[Learn more about the Total Blocking Time metric](https://developer.chrome.com/docs/lighthouse/performance/lighthouse-total-blocking-time/).',
          displayValue: '190 ms',
          score: 0.4,
          scoreDisplayMode: 'numeric',
        },
      },
    };

    const [failure] = lighthouseFailures(metric, ['performance']);

    // The heading already names the audit and its value, so the body is only
    // Lighthouse's explanation (the markdown link flattened to text + address).
    expect(failure?.evidence).toEqual([
      {
        kind: 'text',
        value:
          'Sum of all time periods between FCP and Time to Interactive, when task length exceeded 50ms. ' +
          'Learn more about the Total Blocking Time metric (https://developer.chrome.com/docs/lighthouse/performance/lighthouse-total-blocking-time/).',
      },
    ]);
  });

  it('keeps every item but bounds one over-long cell, so a row stays readable', () => {
    const text = 'x'.repeat(9000);
    const verbose: Lhr = {
      categories: { seo: { score: 0, auditRefs: [{ id: 'verbose', weight: 1 }] } },
      audits: {
        verbose: {
          title: 'Verbose',
          score: 0,
          scoreDisplayMode: 'binary',
          details: {
            type: 'table',
            headings: [{ key: 'description', valueType: 'code', label: 'Description' }],
            items: [{ description: text }, { description: 'short' }],
          },
        },
      },
    };

    const [failure] = lighthouseFailures(verbose, ['seo']);
    const block = failure?.evidence[0];
    const rows = block?.kind === 'table' ? block.rows : [];

    expect(rows).toHaveLength(2);
    expect(cellValue(rows[1]?.[0])).toBe('short');
    expect(cellValue(rows[0]?.[0])?.length).toBeLessThan(text.length);
    expect(cellValue(rows[0]?.[0])?.endsWith('…')).toBe(true);
  });
});

describe('inspectAuditRequest', () => {
  const configured = (origin: string) => origin === 'https://author.example:4502';

  it.each(['data:text/html,hi', 'blob:https://a.example/123', 'about:blank'])(
    'allows the local address %s',
    async (url) => {
      const inspectTarget = addressPolicy();
      expect(
        await inspectAuditRequest(url, { isConfiguredOrigin: configured, inspectTarget }),
      ).toEqual({ allowed: true });
      expect(inspectTarget).not.toHaveBeenCalled();
    },
  );

  it("allows a configured host's own origin without resolving it", async () => {
    const inspectTarget = addressPolicy();

    expect(
      await inspectAuditRequest('https://author.example:4502/content/a.html', {
        isConfiguredOrigin: configured,
        inspectTarget,
      }),
    ).toEqual({ allowed: true });
    expect(inspectTarget).not.toHaveBeenCalled();
  });

  it('allows another public address through the shared address policy', async () => {
    const inspectTarget = addressPolicy((url) => url.hostname === 'cdn.example');

    expect(
      await inspectAuditRequest('https://cdn.example/x.js', {
        isConfiguredOrigin: configured,
        inspectTarget,
      }),
    ).toEqual({ allowed: true });
  });

  it.each([
    ['a literal loopback address', 'http://127.0.0.1/x'],
    ['a literal metadata address', 'http://169.254.169.254/latest'],
    ['an internal name', 'http://intranet/x'],
    ['a name resolving to a private address', 'https://rebind.example/x'],
  ])('refuses %s', async (_label, url) => {
    expect(
      await inspectAuditRequest(url, {
        isConfiguredOrigin: configured,
        inspectTarget: () => Promise.resolve({ allowed: false }),
      }),
    ).toEqual({ allowed: false, reason: 'it is a local or internal address' });
  });

  it('refuses an address that does not parse', async () => {
    expect(
      await inspectAuditRequest('not a url', {
        isConfiguredOrigin: configured,
        inspectTarget: () => Promise.resolve({ allowed: true }),
      }),
    ).toEqual({ allowed: false, reason: 'it is not a valid address' });
  });
});

describe('createPageAudit', () => {
  const request = { url: undefined, categories: ['seo'], formFactor: 'mobile' } as const;

  function runner(currentUrl: string | undefined) {
    const windows = createWindowFactory();
    return {
      windows,
      run: createPageAudit({
        paneSession: {} as never,
        anonymousSession: () => {
          throw new Error('no session expected');
        },
        createWindow: (options) => windows.create(options) as never,
        currentUrl: () => currentUrl,
        isConfiguredOrigin: () => false,
        inspectTarget: () => Promise.resolve({ allowed: false }),
      }),
    };
  }

  function auditRunner(
    currentUrl: string | undefined,
    probe = session(),
    isConfiguredOrigin: (origin: string) => boolean = () => false,
    inspectTarget = addressPolicy(),
  ) {
    const windows = createWindowFactory();
    return {
      probe,
      windows,
      inspectTarget,
      run: createPageAudit({
        paneSession: probe as never,
        anonymousSession: () => probe as never,
        createWindow: (options) => windows.create(options) as never,
        currentUrl: () => currentUrl,
        isConfiguredOrigin,
        inspectTarget,
      }),
    };
  }

  it('has nothing to audit when the pane shows no page', async () => {
    expect(await runner(undefined).run(request, undefined)).toEqual({ kind: 'no_page' });
  });

  it('refuses an address that is not a web address', async () => {
    expect(
      await runner('https://a.example/').run({ ...request, url: 'ftp://a.example/' }, undefined),
    ).toEqual({ kind: 'invalid_url' });
  });

  it('refuses a page outside the configured hosts that resolves to a private address', async () => {
    expect(
      await runner('https://a.example/').run(
        { ...request, url: 'https://intranet.example/' },
        undefined,
      ),
    ).toMatchObject({ kind: 'blocked' });
  });

  it('hardens the audit window and closes it when the caller aborts', async () => {
    const { run, probe, windows } = auditRunner(undefined);
    const controller = new AbortController();

    const outcome = run({ ...request, url: 'https://a.example/' }, controller.signal);
    await vi.waitFor(() => expect(windows.windows).toHaveLength(1));
    const window = windows.windows[0];
    controller.abort();

    expect(await outcome).toEqual({ kind: 'cancelled' });
    expect(window?.destroyed).toBe(true);
    expect(window?.webContents.setWindowOpenHandler).toHaveBeenCalled();
    expect(window?.webContents.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith(
      'disable_non_proxied_udp',
    );
    expect(window?.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      sandbox: true,
    });
    expect(probe.setPermissionCheckHandler).toHaveBeenCalled();
    expect(probe.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(null);
  });

  it('reports a refused request when the page load fails because of it', async () => {
    const { run, probe, windows } = auditRunner(undefined);
    windows.setLoadUrl(async () => {
      const verdict = await probe.deliver('http://169.254.169.254/latest');
      expect(verdict).toEqual({ cancel: true });
      throw new Error('net::ERR_BLOCKED_BY_CLIENT');
    });

    const outcome = await run({ ...request, url: 'https://a.example/' }, undefined);

    expect(outcome).toEqual({
      kind: 'failed',
      message:
        'A request to http://169.254.169.254/latest was refused because it is a local or internal address',
    });
  });

  it('calls a document refused by a second, different resolution a blocked audit', async () => {
    // Public for the pre-check, private for the request filter: exactly the
    // rebinding sequence the filter exists to catch.
    const answers = [{ allowed: true }, { allowed: false }];
    const inspectTarget = vi.fn(() =>
      Promise.resolve(
        answers.length > 0 ? (answers.shift() ?? { allowed: false }) : { allowed: false },
      ),
    );
    const { run, probe, windows } = auditRunner(undefined, session(), () => false, inspectTarget);
    windows.setLoadUrl(async () => {
      await probe.deliver('https://a.example/');
      throw new Error('net::ERR_BLOCKED_BY_CLIENT');
    });

    const outcome = await run({ ...request, url: 'https://a.example/' }, undefined);

    expect(outcome).toMatchObject({ kind: 'blocked' });
  });

  it("filters a configured host's audit too, leaving other views alone", async () => {
    const { run, probe, windows } = auditRunner(
      undefined,
      session(),
      (origin) => origin === 'https://author.example',
      addressPolicy((url) => url.hostname === 'author.example'),
    );
    const controller = new AbortController();
    const outcome = run(
      { ...request, url: 'https://author.example/content/a.html' },
      controller.signal,
    );
    await vi.waitFor(() => expect(windows.windows).toHaveLength(1));
    const window = windows.windows[0];
    if (window === undefined) throw new Error('no audit window');

    // The window's own request to a private address is refused...
    await expect(probe.deliver('http://10.0.0.5/x', window.webContents.id)).resolves.toEqual({
      cancel: true,
    });
    // ...the configured host is trusted without resolving...
    await expect(
      probe.deliver('https://author.example/other.png', window.webContents.id),
    ).resolves.toEqual({});
    // ...and another view in the shared pane session is never filtered.
    await expect(probe.deliver('http://10.0.0.5/own', 999)).resolves.toEqual({});

    // Permissions are denied for the audit window only.
    const check = probe.setPermissionCheckHandler.mock.calls[0]?.[0] as
      ((contents: { id: number } | null) => boolean) | undefined;
    expect(check?.({ id: window.webContents.id })).toBe(false);
    expect(check?.({ id: 999 })).toBe(true);

    controller.abort();
    await expect(outcome).resolves.toEqual({ kind: 'cancelled' });
  });

  it('refuses a further audit when the queue is full', async () => {
    const { run, windows } = auditRunner(undefined);
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const accepted = controllers.map((controller) =>
      run({ ...request, url: 'https://a.example/' }, controller.signal),
    );
    await vi.waitFor(() => expect(windows.windows).toHaveLength(1));

    const refused = await run({ ...request, url: 'https://a.example/' }, undefined);
    if (refused.kind !== 'failed') throw new Error('expected the queued audit to be refused');
    expect(refused.message).toContain('queue');

    for (const controller of controllers) controller.abort();
    await Promise.all(accepted);
  });
});
