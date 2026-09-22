import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, WebContents } from 'electron';

/**
 * The Electron wiring behind the popup/tab policy: a popup request must be
 * allowed as a real `BrowserWindow` sharing the pane's session (so SSO's
 * `window.opener` back-channel survives), a tab request must be denied as a
 * window and loaded in the requesting view instead, and every popup must be
 * tracked so a server switch can close it. The pure popup/tab decision itself
 * is covered separately in `windowOpenPolicy.test.ts`; this file proves the
 * router acts on it.
 */
const electronMock = vi.hoisted(() => {
  class FakeWebContents {
    readonly setWindowOpenHandler = vi.fn();
    readonly loadURL = vi.fn(() => Promise.resolve());
    private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    readonly on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const existing = this.listeners.get(event) ?? [];
      existing.push(listener);
      this.listeners.set(event, existing);
      return this;
    });
    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    }
  }
  class FakeBrowserWindow {
    static readonly instances: FakeBrowserWindow[] = [];
    readonly webContents = new FakeWebContents();
    readonly isDestroyed = vi.fn(() => false);
    readonly close = vi.fn();
    readonly setAppDetails = vi.fn();
    readonly on = vi.fn();
    constructor() {
      FakeBrowserWindow.instances.push(this);
    }
    static reset(): void {
      FakeBrowserWindow.instances.length = 0;
    }
  }
  return { FakeBrowserWindow, FakeWebContents };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getName: () => 'EToolbox Daisy',
    getAppPath: () => 'C:/app',
  },
  BrowserWindow: electronMock.FakeBrowserWindow,
  Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
  clipboard: { writeText: vi.fn() },
  screen: { on: vi.fn(), removeListener: vi.fn() },
  WebContentsView: class {},
}));

const { createWindowOpenRouter, openUrlInView } =
  await import('../../../../src/main/browser/windowOpenRouter');

type OpenHandler = (details: {
  url: string;
  features: string;
  disposition: string;
}) => { action: string } & Record<string, unknown>;

function openHandlerOf(contents: InstanceType<typeof electronMock.FakeWebContents>): OpenHandler {
  const handler = contents.setWindowOpenHandler.mock.calls[0]?.[0] as OpenHandler | undefined;
  if (handler === undefined) throw new Error('no window-open handler was attached');
  return handler;
}

describe('createWindowOpenRouter', () => {
  beforeEach(() => {
    electronMock.FakeBrowserWindow.reset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('allows a popup (window features present) and keeps the pane on its page', () => {
    const session = { marker: 'aem-session' } as unknown as Session;
    const router = createWindowOpenRouter(session);
    const parent = new electronMock.FakeWebContents();
    router.attachTo(parent as unknown as WebContents);

    const result = openHandlerOf(parent)({
      url: 'https://idp.example/authorize',
      features: 'width=480,height=640',
      disposition: 'new-window',
    });

    expect(result).toMatchObject({ action: 'allow' });
    expect(
      (result['overrideBrowserWindowOptions'] as { webPreferences: { session: Session } })
        .webPreferences.session,
    ).toBe(session);
    expect(parent.loadURL).not.toHaveBeenCalled();
  });

  it('denies a tab request and loads it in the same view, so Back can rewind it', () => {
    const router = createWindowOpenRouter({} as Session);
    const parent = new electronMock.FakeWebContents();
    router.attachTo(parent as unknown as WebContents);

    const result = openHandlerOf(parent)({
      url: 'https://author.example/content/next.html',
      features: '',
      disposition: 'foreground-tab',
    });

    expect(result).toEqual({ action: 'deny' });
    expect(parent.loadURL).toHaveBeenCalledWith('https://author.example/content/next.html');
  });

  it("acts on disposition, not features: a 'noopener' token is still a tab", () => {
    const router = createWindowOpenRouter({} as Session);
    const parent = new electronMock.FakeWebContents();
    router.attachTo(parent as unknown as WebContents);

    const result = openHandlerOf(parent)({
      url: 'https://author.example/bin/wcmcommand?cmd=open&path=/content/site',
      features: 'noopener',
      disposition: 'foreground-tab',
    });

    expect(result).toEqual({ action: 'deny' });
    expect(parent.loadURL).toHaveBeenCalledWith(
      'https://author.example/bin/wcmcommand?cmd=open&path=/content/site',
    );
  });

  it.each(['file:///C:/secret.txt', 'javascript:alert(1)', 'not a url'])(
    'denies %s and neither opens a window nor navigates',
    (url) => {
      const router = createWindowOpenRouter({} as Session);
      const parent = new electronMock.FakeWebContents();
      router.attachTo(parent as unknown as WebContents);

      const result = openHandlerOf(parent)({ url, features: '', disposition: 'foreground-tab' });

      expect(result).toEqual({ action: 'deny' });
      expect(parent.loadURL).not.toHaveBeenCalled();
    },
  );

  it('registers a created popup, governs its chained popups, and closes it through closeAll', () => {
    const router = createWindowOpenRouter({} as Session);
    const parent = new electronMock.FakeWebContents();
    router.attachTo(parent as unknown as WebContents);

    const child = new electronMock.FakeBrowserWindow();
    parent.emit('did-create-window', child);

    // The child carries the same policy, so an SSO chain of popups is allowed.
    expect(child.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    const chained = openHandlerOf(child.webContents)({
      url: 'https://idp.example/step2',
      features: 'width=480,height=640',
      disposition: 'new-window',
    });
    expect(chained).toMatchObject({ action: 'allow' });
    // ...and its own tab requests load in the child, not a third window.
    const tabInChild = openHandlerOf(child.webContents)({
      url: 'https://idp.example/help',
      features: '',
      disposition: 'foreground-tab',
    });
    expect(tabInChild).toEqual({ action: 'deny' });
    expect(child.webContents.loadURL).toHaveBeenCalledWith('https://idp.example/help');

    router.closeAll();
    expect(child.close).toHaveBeenCalledTimes(1);
  });

  it('closeAll is safe when no popup is open', () => {
    const router = createWindowOpenRouter({} as Session);
    expect(() => router.closeAll()).not.toThrow();
  });
});

describe('openUrlInView', () => {
  it('loads an allowed http(s) URL in the view', () => {
    const contents = new electronMock.FakeWebContents();
    openUrlInView(contents as unknown as WebContents, 'https://author.example/path');
    expect(contents.loadURL).toHaveBeenCalledWith('https://author.example/path');
  });

  it.each(['file:///C:/secret.txt', 'app://daisy/index.html', 'nonsense'])(
    'does not load the disallowed URL %s',
    (url) => {
      const contents = new electronMock.FakeWebContents();
      openUrlInView(contents as unknown as WebContents, url);
      expect(contents.loadURL).not.toHaveBeenCalled();
    },
  );

  it('consumes a rejected load instead of leaking an unhandled rejection', async () => {
    const contents = new electronMock.FakeWebContents();
    contents.loadURL.mockImplementation(() =>
      Promise.reject(new Error("ERR_CONNECTION_REFUSED (-102) loading 'https://down.example'")),
    );

    expect(() =>
      openUrlInView(contents as unknown as WebContents, 'https://down.example'),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});
