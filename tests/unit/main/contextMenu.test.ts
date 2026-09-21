import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BrowserWindow,
  ContextMenuParams,
  EditFlags,
  MenuItemConstructorOptions,
  WebContents,
} from 'electron';

/**
 * `contextMenu.ts` is the only place the app builds a native `Menu`, so it is
 * the only place these builders can be exercised without a running Electron
 * process. The whole `Menu`/`clipboard` surface is mocked; the assertions then
 * read the templates the production code produced and invoke the click
 * handlers it wired, rather than trusting that "a menu appeared".
 *
 * Every action is bound to the `WebContents` the menu was built for (no menu
 * roles), so the tests check the bound `webContents` methods are what actually
 * run - the point of that binding being that the AEM pane is a separate
 * `WebContentsView` inside the same window.
 */
const electronMock = vi.hoisted(() => {
  const popup = vi.fn();
  const buildFromTemplate = vi.fn((template: unknown) => ({ template, popup }));
  const writeText = vi.fn();
  return { popup, buildFromTemplate, writeText };
});

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: electronMock.buildFromTemplate },
  clipboard: { writeText: electronMock.writeText },
}));

const {
  buildClipboardTemplate,
  buildChromeTemplate,
  attachClipboardContextMenu,
  attachChromeContextMenu,
} = await import('../../../src/main/contextMenu');

function makeEditFlags(overrides: Partial<EditFlags> = {}): EditFlags {
  return {
    canUndo: false,
    canRedo: false,
    canCut: false,
    canCopy: false,
    canPaste: false,
    canDelete: false,
    canSelectAll: false,
    canEditRichly: false,
    ...overrides,
  };
}

function makeParams(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return {
    x: 10,
    y: 20,
    frame: null,
    linkURL: '',
    linkText: '',
    pageURL: 'https://author.example/editor.html',
    frameURL: '',
    srcURL: '',
    mediaType: 'none',
    hasImageContents: false,
    isEditable: false,
    selectionText: '',
    titleText: '',
    altText: '',
    suggestedFilename: '',
    selectionRect: { x: 0, y: 0, width: 0, height: 0 },
    selectionStartOffset: 0,
    referrerPolicy: { policy: 'default', url: '' },
    misspelledWord: '',
    dictionarySuggestions: [],
    frameCharset: 'UTF-8',
    formControlType: 'none',
    spellcheckEnabled: false,
    menuSourceType: 'mouse',
    mediaFlags: {
      inError: false,
      isPaused: false,
      isMuted: false,
      hasAudio: false,
      isLooping: false,
      isControlsVisible: false,
      canToggleControls: false,
      canPrint: false,
      canSave: false,
      canShowPictureInPicture: false,
      isShowingPictureInPicture: false,
      canRotate: false,
      canLoop: false,
    },
    editFlags: makeEditFlags(),
    ...overrides,
  };
}

interface FakeWebContents {
  readonly webContents: WebContents;
  readonly emit: (event: string, ...args: unknown[]) => void;
  readonly undo: ReturnType<typeof vi.fn>;
  readonly redo: ReturnType<typeof vi.fn>;
  readonly cut: ReturnType<typeof vi.fn>;
  readonly copy: ReturnType<typeof vi.fn>;
  readonly paste: ReturnType<typeof vi.fn>;
  readonly selectAll: ReturnType<typeof vi.fn>;
  readonly navigationHistory: {
    readonly canGoBack: ReturnType<typeof vi.fn>;
    readonly canGoForward: ReturnType<typeof vi.fn>;
    readonly goBack: ReturnType<typeof vi.fn>;
    readonly goForward: ReturnType<typeof vi.fn>;
  };
  readonly copyImageAt: ReturnType<typeof vi.fn>;
  readonly downloadURL: ReturnType<typeof vi.fn>;
  readonly reload: ReturnType<typeof vi.fn>;
  readonly inspectElement: ReturnType<typeof vi.fn>;
  readonly openDevTools: ReturnType<typeof vi.fn>;
  readonly isDevToolsOpened: ReturnType<typeof vi.fn>;
}

function makeFakeWebContents(
  options: { canGoBack?: boolean; canGoForward?: boolean; devToolsOpened?: boolean } = {},
): FakeWebContents {
  const listeners = new Map<string, (...args: never[]) => void>();
  const editing = {
    undo: vi.fn(),
    redo: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
  };
  const navigationHistory = {
    canGoBack: vi.fn(() => options.canGoBack ?? false),
    canGoForward: vi.fn(() => options.canGoForward ?? false),
    goBack: vi.fn(),
    goForward: vi.fn(),
  };
  const copyImageAt = vi.fn();
  const downloadURL = vi.fn();
  const reload = vi.fn();
  const inspectElement = vi.fn();
  const openDevTools = vi.fn();
  const isDevToolsOpened = vi.fn(() => options.devToolsOpened ?? false);
  const webContents = {
    on: (event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, listener);
      return webContents;
    },
    ...editing,
    navigationHistory,
    copyImageAt,
    downloadURL,
    reload,
    inspectElement,
    openDevTools,
    isDevToolsOpened,
  } as unknown as WebContents;
  return {
    webContents,
    emit: (event, ...args) => listeners.get(event)?.(...(args as never[])),
    ...editing,
    navigationHistory,
    copyImageAt,
    downloadURL,
    reload,
    inspectElement,
    openDevTools,
    isDevToolsOpened,
  };
}

function makeFakeWindow(destroyed = false): BrowserWindow {
  return { isDestroyed: () => destroyed } as BrowserWindow;
}

/** Compact, readable view of a built template: labels, separators as `---`. */
function surface(template: MenuItemConstructorOptions[]): string[] {
  return template.map((item) => (item.type === 'separator' ? '---' : (item.label ?? '?')));
}

function itemNamed(
  template: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions {
  const item = template.find((candidate) => candidate.label === label);
  if (item === undefined) {
    throw new Error(`no menu item labelled "${label}"`);
  }
  return item;
}

/** Menu-item click handlers are the only executable part of a template; drive one. */
function click(item: MenuItemConstructorOptions): void {
  if (item.click === undefined) {
    throw new Error('menu item has no click handler');
  }
  item.click(undefined as never, undefined, undefined as never);
}

describe('buildClipboardTemplate', () => {
  it('offers cut/copy/paste/select-all for an editable field, enabled per the edit flags', () => {
    const { webContents } = makeFakeWebContents();
    const template = buildClipboardTemplate(
      makeParams({
        isEditable: true,
        editFlags: makeEditFlags({
          canCut: true,
          canCopy: true,
          canPaste: false,
          canSelectAll: true,
        }),
      }),
      webContents,
    );

    expect(surface(template)).toEqual(['Cut', 'Copy', 'Paste', '---', 'Select all']);
    expect(template.map((item) => item.enabled)).toEqual([true, true, false, undefined, true]);
  });

  it('always offers copy/select-all on a non-editable surface, so the menu exists throughout the chat', () => {
    const { webContents } = makeFakeWebContents();
    const noSelection = buildClipboardTemplate(makeParams(), webContents);
    expect(surface(noSelection)).toEqual(['Copy', '---', 'Select all']);
    // Copy is present but disabled until something is selected.
    expect(noSelection[0]?.enabled).toBe(false);
    // Select all stays available with no explicit enable override.
    expect(noSelection[2]?.enabled).toBeUndefined();

    const withSelection = buildClipboardTemplate(
      makeParams({
        selectionText: 'hello',
        editFlags: makeEditFlags({ canCopy: true, canSelectAll: true }),
      }),
      webContents,
    );
    expect(surface(withSelection)).toEqual(['Copy', '---', 'Select all']);
    expect(withSelection[0]?.enabled).toBe(true);
  });

  it('does not expose editing actions (undo/redo/cut/paste) on non-editable text', () => {
    const { webContents } = makeFakeWebContents();
    const template = buildClipboardTemplate(makeParams({ selectionText: 'hello' }), webContents);
    expect(surface(template)).not.toContain('Cut');
    expect(surface(template)).not.toContain('Paste');
    expect(surface(template)).not.toContain('Undo');
  });

  it('runs each editing command against the webContents the menu was built for', () => {
    const { webContents, cut, copy, paste, selectAll } = makeFakeWebContents();
    const editable = buildClipboardTemplate(
      makeParams({ isEditable: true, editFlags: makeEditFlags({ canSelectAll: true }) }),
      webContents,
    );

    click(itemNamed(editable, 'Cut'));
    click(itemNamed(editable, 'Copy'));
    click(itemNamed(editable, 'Paste'));
    click(itemNamed(editable, 'Select all'));

    expect(cut).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(paste).toHaveBeenCalledTimes(1);
    expect(selectAll).toHaveBeenCalledTimes(1);
  });
});

describe('buildChromeTemplate', () => {
  it('offers the full editing set for an editable field', () => {
    const { webContents } = makeFakeWebContents();
    const template = buildChromeTemplate(
      makeParams({
        isEditable: true,
        editFlags: makeEditFlags({
          canUndo: true,
          canRedo: true,
          canCut: true,
          canCopy: true,
          canPaste: true,
          canSelectAll: true,
        }),
      }),
      webContents,
      { openLinkInNewWindow: vi.fn() },
    );

    expect(surface(template)).toEqual([
      'Undo',
      'Redo',
      '---',
      'Cut',
      'Copy',
      'Paste',
      '---',
      'Select all',
      '---',
      'Inspect',
    ]);
    expect(template.map((item) => item.enabled)).toEqual([
      true,
      true,
      undefined,
      true,
      true,
      true,
      undefined,
      true,
      undefined,
      undefined,
    ]);
  });

  it('offers link actions before page navigation, and routes "open in new window" through the target', () => {
    const { webContents } = makeFakeWebContents({ canGoBack: true });
    const target = { openLinkInNewWindow: vi.fn() };
    const template = buildChromeTemplate(
      makeParams({ linkURL: 'https://author.example/content.html' }),
      webContents,
      target,
    );

    expect(surface(template)).toEqual([
      'Open link in new window',
      'Copy link address',
      '---',
      'Back',
      'Forward',
      'Reload',
      '---',
      'Inspect',
    ]);
    expect(template[3]?.enabled).toBe(true);
    expect(template[4]?.enabled).toBe(false);

    click(itemNamed(template, 'Open link in new window'));
    expect(target.openLinkInNewWindow).toHaveBeenCalledWith('https://author.example/content.html');

    click(itemNamed(template, 'Copy link address'));
    expect(electronMock.writeText).toHaveBeenCalledWith('https://author.example/content.html');
  });

  it('offers image actions that copy, save, and expose the image address', () => {
    const { webContents, copyImageAt, downloadURL } = makeFakeWebContents();
    const template = buildChromeTemplate(
      makeParams({ mediaType: 'image', srcURL: 'https://author.example/asset.png', x: 7, y: 9 }),
      webContents,
      { openLinkInNewWindow: vi.fn() },
    );

    expect(surface(template)).toEqual([
      'Copy image',
      'Copy image address',
      'Save image as…',
      '---',
      'Back',
      'Forward',
      'Reload',
      '---',
      'Inspect',
    ]);

    click(itemNamed(template, 'Copy image'));
    expect(copyImageAt).toHaveBeenCalledWith(7, 9);

    click(itemNamed(template, 'Copy image address'));
    expect(electronMock.writeText).toHaveBeenCalledWith('https://author.example/asset.png');

    click(itemNamed(template, 'Save image as…'));
    expect(downloadURL).toHaveBeenCalledWith('https://author.example/asset.png');
  });

  it('offers copy for a plain text selection, then page navigation', () => {
    const { webContents, copy } = makeFakeWebContents();
    const template = buildChromeTemplate(
      makeParams({ selectionText: 'selected words' }),
      webContents,
      {
        openLinkInNewWindow: vi.fn(),
      },
    );

    expect(surface(template)).toEqual([
      'Copy',
      '---',
      'Back',
      'Forward',
      'Reload',
      '---',
      'Inspect',
    ]);

    click(itemNamed(template, 'Copy'));
    expect(copy).toHaveBeenCalledTimes(1);
  });

  it('opens the page DevTools detached and selects the element under the cursor', () => {
    const { webContents, inspectElement, openDevTools } = makeFakeWebContents();
    const template = buildChromeTemplate(makeParams({ x: 42, y: 17 }), webContents, {
      openLinkInNewWindow: vi.fn(),
    });

    click(itemNamed(template, 'Inspect'));

    expect(openDevTools).toHaveBeenCalledTimes(1);
    expect(openDevTools).toHaveBeenCalledWith({ mode: 'detach' });
    expect(inspectElement).toHaveBeenCalledWith(42, 17);
  });

  it('does not reopen already-open DevTools when Inspect is chosen', () => {
    const { webContents, inspectElement, openDevTools } = makeFakeWebContents({
      devToolsOpened: true,
    });
    const template = buildChromeTemplate(makeParams(), webContents, {
      openLinkInNewWindow: vi.fn(),
    });

    click(itemNamed(template, 'Inspect'));

    expect(openDevTools).not.toHaveBeenCalled();
    expect(inspectElement).toHaveBeenCalledTimes(1);
  });

  it('drives back/forward/reload through the bound webContents', () => {
    const { webContents, navigationHistory, reload } = makeFakeWebContents();
    const template = buildChromeTemplate(makeParams(), webContents, {
      openLinkInNewWindow: vi.fn(),
    });

    click(itemNamed(template, 'Back'));
    click(itemNamed(template, 'Forward'));
    click(itemNamed(template, 'Reload'));

    expect(navigationHistory.goBack).toHaveBeenCalledTimes(1);
    expect(navigationHistory.goForward).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('attachContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('pops the clipboard menu for the app window on a context-menu event', () => {
    const { webContents, emit } = makeFakeWebContents();
    const window = makeFakeWindow();
    attachClipboardContextMenu(webContents, window);

    emit('context-menu', {}, makeParams({ selectionText: 'hi' }));

    expect(electronMock.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(electronMock.popup).toHaveBeenCalledWith({ window });
  });

  it('does not pop a menu when the owning window is already destroyed', () => {
    const { webContents, emit } = makeFakeWebContents();
    attachClipboardContextMenu(webContents, makeFakeWindow(true));

    emit('context-menu', {}, makeParams({ selectionText: 'hi' }));

    expect(electronMock.buildFromTemplate).not.toHaveBeenCalled();
    expect(electronMock.popup).not.toHaveBeenCalled();
  });

  it('pops a Chrome menu bound to the remote surface it was attached to', () => {
    const { webContents, emit } = makeFakeWebContents();
    const window = makeFakeWindow();
    attachChromeContextMenu(webContents, window, { openLinkInNewWindow: vi.fn() });

    emit('context-menu', {}, makeParams({ linkURL: 'https://author.example/a.html' }));

    const built = electronMock.buildFromTemplate.mock.calls[0]?.[0] as
      MenuItemConstructorOptions[] | undefined;
    expect(surface(built ?? [])).toContain('Open link in new window');
    expect(electronMock.popup).toHaveBeenCalledWith({ window });
  });
});
