import { describe, expect, it, vi } from 'vitest';
import { PAGE_AUDIT_MAX_FAILURES } from '../../../src/shared';

interface FakeWindow {
  readonly options: { readonly webPreferences?: Record<string, unknown> };
  readonly webContents: FakeWebContents;
  destroyed: boolean;
}

interface FakeWebContents {
  readonly id: number;
  readonly listeners: Map<string, Set<(...args: never[]) => void>>;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly debugger: Record<string, unknown>;
  setFrameRate: () => void;
  setWindowOpenHandler: () => void;
  setWebRTCIPHandlingPolicy: (policy: string) => void;
  on: (event: string, listener: (...args: never[]) => void) => void;
  removeListener: () => void;
  getTitle: () => string;
  getURL: () => string;
  loadUrl: (url: string) => Promise<void>;
}

const electronMock = vi.hoisted(() => {
  const windows: FakeWindow[] = [];
  let loadUrl: (url: string) => Promise<void> = () => new Promise<void>(() => undefined);
  let nextId = 7;

  class FakeBrowserWindow implements FakeWindow {
    readonly webContents: FakeWebContents;
    destroyed = false;
    readonly options: FakeWindow['options'];

    constructor(options: FakeWindow['options'] = {}) {
      this.options = options;
      const listeners = new Map<string, Set<(...args: never[]) => void>>();
      this.webContents = {
        id: nextId,
        listeners,
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
        on: (event: string, listener: (...args: never[]) => void) => {
          const set = listeners.get(event) ?? new Set();
          set.add(listener);
          listeners.set(event, set);
        },
        removeListener: vi.fn(),
        getTitle: () => 'audit',
        getURL: () => 'https://a.example/',
        loadUrl: (url: string) => loadUrl(url),
      };
      nextId += 1;
      windows.push(this);
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    loadURL(url: string): Promise<void> {
      return this.webContents.loadUrl(url);
    }

    destroy(): void {
      this.destroyed = true;
    }
  }

  return {
    windows,
    setLoadUrl: (handler: (url: string) => Promise<void>) => {
      loadUrl = handler;
    },
    reset: () => {
      windows.length = 0;
      loadUrl = () => new Promise<void>(() => undefined);
    },
    BrowserWindow: FakeBrowserWindow,
  };
});

vi.mock('electron', () => ({ BrowserWindow: electronMock.BrowserWindow }));

const { createPageAudit, inspectAuditRequest, lighthouseFailures, parseTarget } =
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

describe('inspectAuditRequest', () => {
  const configured = (origin: string) => origin === 'https://author.example:4502';

  it.each(['data:text/html,hi', 'blob:https://a.example/123', 'about:blank'])(
    'allows the local address %s',
    async (url) => {
      expect(
        await inspectAuditRequest(url, {
          isConfiguredOrigin: configured,
          resolveAddresses: () => Promise.resolve(['10.0.0.5']),
        }),
      ).toEqual({ allowed: true });
    },
  );

  it("allows a configured host's own origin without resolving it", async () => {
    const resolveAddresses = vi.fn(() => Promise.resolve(['10.0.0.5']));

    expect(
      await inspectAuditRequest('https://author.example:4502/content/a.html', {
        isConfiguredOrigin: configured,
        resolveAddresses,
      }),
    ).toEqual({ allowed: true });
    expect(resolveAddresses).not.toHaveBeenCalled();
  });

  it('allows another public address through the shared address policy', async () => {
    expect(
      await inspectAuditRequest('https://cdn.example/x.js', {
        isConfiguredOrigin: configured,
        resolveAddresses: () => Promise.resolve(['93.184.216.34']),
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
        resolveAddresses: () => Promise.resolve(['10.0.0.5']),
      }),
    ).toEqual({ allowed: false, reason: 'it is a local or internal address' });
  });

  it('refuses an address that does not parse', async () => {
    expect(
      await inspectAuditRequest('not a url', {
        isConfiguredOrigin: configured,
        resolveAddresses: () => Promise.resolve(['93.184.216.34']),
      }),
    ).toEqual({ allowed: false, reason: 'it is not a valid address' });
  });
});

describe('createPageAudit', () => {
  const request = { url: undefined, categories: ['seo'], formFactor: 'mobile' } as const;

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

  function auditRunner(
    currentUrl: string | undefined,
    probe = session(),
    isConfiguredOrigin: (origin: string) => boolean = () => false,
  ) {
    electronMock.reset();
    const resolveAddresses = vi.fn(() => Promise.resolve(['93.184.216.34']));
    return {
      probe,
      resolveAddresses,
      run: createPageAudit({
        paneSession: probe as never,
        anonymousSession: () => probe as never,
        currentUrl: () => currentUrl,
        isConfiguredOrigin,
        resolveAddresses,
      }),
    };
  }

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

  it('hardens the audit window and closes it when the caller aborts', async () => {
    const { run, probe } = auditRunner(undefined);
    const controller = new AbortController();

    const outcome = run({ ...request, url: 'https://a.example/' }, controller.signal);
    await vi.waitFor(() => expect(electronMock.windows).toHaveLength(1));
    const window = electronMock.windows[0];
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
    const { run, probe } = auditRunner(undefined);
    electronMock.setLoadUrl(async () => {
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
    const { run, probe, resolveAddresses } = auditRunner(undefined);
    // Public for the pre-check, private for the request filter: exactly the
    // rebinding sequence the filter exists to catch.
    resolveAddresses.mockResolvedValueOnce(['93.184.216.34']);
    resolveAddresses.mockResolvedValue(['10.0.0.5']);
    electronMock.setLoadUrl(async () => {
      await probe.deliver('https://a.example/');
      throw new Error('net::ERR_BLOCKED_BY_CLIENT');
    });

    const outcome = await run({ ...request, url: 'https://a.example/' }, undefined);

    expect(outcome).toMatchObject({ kind: 'blocked' });
  });

  it("filters a configured host's audit too, leaving other views alone", async () => {
    const { run, probe } = auditRunner(
      undefined,
      session(),
      (origin) => origin === 'https://author.example',
    );
    const controller = new AbortController();
    const outcome = run(
      { ...request, url: 'https://author.example/content/a.html' },
      controller.signal,
    );
    await vi.waitFor(() => expect(electronMock.windows).toHaveLength(1));
    const window = electronMock.windows[0];
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
    const { run } = auditRunner(undefined);
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const accepted = controllers.map((controller) =>
      run({ ...request, url: 'https://a.example/' }, controller.signal),
    );
    await vi.waitFor(() => expect(electronMock.windows).toHaveLength(1));

    const refused = await run({ ...request, url: 'https://a.example/' }, undefined);
    if (refused.kind !== 'failed') throw new Error('expected the queued audit to be refused');
    expect(refused.message).toContain('queue');

    for (const controller of controllers) controller.abort();
    await Promise.all(accepted);
  });
});
