import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, WebContents } from 'electron';

/**
 * `openWindow` is new with the context menu's "Open link in new window" action.
 * It creates a window directly from the main process, so it must apply the
 * same `decideAuxiliaryWindowOpen` policy a page-initiated `window.open` would
 * - and it must feed the new window through the same registration path, or the
 * window would escape `closeAll()` on the next server switch.
 */
const electronMock = vi.hoisted(() => {
  class FakeWebContents {
    readonly setWindowOpenHandler = vi.fn();
    readonly on = vi.fn();
  }
  class FakeBrowserWindow {
    static readonly instances: FakeBrowserWindow[] = [];
    readonly webContents: FakeWebContents;
    readonly loadURL = vi.fn(() => Promise.resolve());
    readonly isDestroyed = vi.fn(() => false);
    readonly close = vi.fn();
    readonly setAppDetails = vi.fn();
    readonly on = vi.fn();
    constructor() {
      this.webContents = new FakeWebContents();
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

const { createAuxiliaryWindowManager } =
  await import('../../../../src/main/browser/auxiliaryWindows');

function lastWindow() {
  const window = electronMock.FakeBrowserWindow.instances.at(-1);
  if (window === undefined) {
    throw new Error('expected a window to have been created');
  }
  return window;
}

describe('createAuxiliaryWindowManager.openWindow', () => {
  beforeEach(() => {
    electronMock.FakeBrowserWindow.reset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens and loads an http(s) URL in a new window', () => {
    const manager = createAuxiliaryWindowManager({} as Session);

    manager.openWindow('https://ims.example/oauth');

    expect(electronMock.FakeBrowserWindow.instances).toHaveLength(1);
    expect(lastWindow().loadURL).toHaveBeenCalledWith('https://ims.example/oauth');
    // Branded like every other window (taskbar identity), not left as Electron.
    expect(lastWindow().setAppDetails).toHaveBeenCalled();
  });

  it.each(['file:///C:/secret.txt', 'javascript:alert(1)', 'not a url'])(
    'refuses to open %s, creating no window at all',
    (url) => {
      const manager = createAuxiliaryWindowManager({} as Session);

      manager.openWindow(url);

      expect(electronMock.FakeBrowserWindow.instances).toHaveLength(0);
    },
  );

  it('closes context-menu-opened windows through closeAll, like page-opened ones', () => {
    const manager = createAuxiliaryWindowManager({} as Session);
    manager.openWindow('https://ims.example/oauth');
    manager.openWindow('https://ims.example/other');

    manager.closeAll();

    expect(electronMock.FakeBrowserWindow.instances).toHaveLength(2);
    for (const window of electronMock.FakeBrowserWindow.instances) {
      expect(window.close).toHaveBeenCalledTimes(1);
    }
  });

  it('attaches the window-open policy to the new window, so it cannot open a file: popup', () => {
    const manager = createAuxiliaryWindowManager({} as Session);
    manager.openWindow('https://ims.example/oauth');

    expect(lastWindow().webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1);
  });

  it('still allows a page-initiated http(s) window.open (the existing path is unaffected)', () => {
    const manager = createAuxiliaryWindowManager({} as Session);
    const parentContents = new electronMock.FakeWebContents();

    manager.attachTo(parentContents as unknown as WebContents);

    const handler = parentContents.setWindowOpenHandler.mock.calls[0]?.[0] as
      ((details: { url: string }) => { action: string }) | undefined;
    expect(handler?.({ url: 'https://ims.example/login' })).toMatchObject({ action: 'allow' });
    expect(handler?.({ url: 'file:///C:/secret.txt' })).toEqual({ action: 'deny' });
  });
});
