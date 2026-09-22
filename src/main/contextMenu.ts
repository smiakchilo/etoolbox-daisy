import { Menu, clipboard } from 'electron';
import type {
  BrowserWindow,
  ContextMenuParams,
  MenuItemConstructorOptions,
  WebContents,
} from 'electron';
import { openDetachedDevTools } from './devTools';

/**
 * Context menus for the app's two very different surfaces.
 *
 * The app shows no native menu bar (`index.ts` clears the application menu), so
 * every menu action a user needs lives in a right-click menu instead. Two
 * builders cover that:
 *
 *  - {@link buildClipboardTemplate} - the app's *own* UI (chat transcript,
 *    composer, address bar, banners, Settings). This is app content, not a web
 *    page, so a full Chrome menu would be meaningless; it offers exactly the
 *    clipboard set - cut/copy/paste where the target is editable, copy where it
 *    is a selection. Undo/Redo are deliberately left off: they stay on their
 *    keyboard accelerators, and a disabled editing menu over a transcript is
 *    noise.
 *  - {@link buildChromeTemplate} - remote AEM content in the pane's
 *    `WebContentsView`. This is a genuine web page, so it mirrors Chrome's menu
 *    for the element under the cursor (editable field, link, image, selection)
 *    plus page navigation.
 *
 * Electron has no built-in "Chrome context menu", so the Chrome-shaped menu is
 * assembled here from the `WebContents` APIs that correspond to Chrome's
 * actions. Actions with no Electron equivalent (Cast, Translate, Create QR
 * code, View page source) are intentionally absent rather than faked. If this
 * still proves too broad, the clipboard template is the intended fallback for
 * the AEM view too - the two builders share their editable/selection handling
 * for that reason.
 *
 * "Inspect" is the one entry with no keyboard partner: the app has no menu
 * bar, so DevTools for *remote* content is reachable only from here. It opens
 * the page's DevTools detached (see `devTools.ts`) and selects the element
 * under the cursor, matching Chrome's own Inspect.
 *
 * Every action is bound to the `WebContents` the menu was built for, rather
 * than using menu roles. The AEM pane is a `WebContentsView` in the same window
 * as the shell, so a role-based item would act on whichever `WebContents` is
 * focused - which is not necessarily the one that was right-clicked.
 */

export interface ChromeContextMenuTarget {
  /** Loads an http(s) URL in the AEM pane's own view (never a second window - see `browser/windowOpenRouter.ts`). */
  openLink(url: string): void;
}

/**
 * The clipboard-only menu, for the app's own renderer surfaces.
 *
 * Always produces a menu - on a non-editable surface with no selection, Copy
 * is disabled and Select all stays available - so the menu is reachable
 * anywhere in the chat panel and its banners, not only once text has already
 * been selected.
 */
export function buildClipboardTemplate(
  params: ContextMenuParams,
  webContents: WebContents,
): MenuItemConstructorOptions[] {
  const { editFlags } = params;

  if (params.isEditable) {
    return [
      { label: 'Cut', enabled: editFlags.canCut, click: () => webContents.cut() },
      { label: 'Copy', enabled: editFlags.canCopy, click: () => webContents.copy() },
      { label: 'Paste', enabled: editFlags.canPaste, click: () => webContents.paste() },
      { type: 'separator' },
      {
        label: 'Select all',
        enabled: editFlags.canSelectAll,
        click: () => webContents.selectAll(),
      },
    ];
  }

  return [
    { label: 'Copy', enabled: editFlags.canCopy, click: () => webContents.copy() },
    { type: 'separator' },
    { label: 'Select all', click: () => webContents.selectAll() },
  ];
}

/**
 * The Chrome "Inspect" item: open this page's DevTools (detached, so the
 * app's own layout is untouched) and select the element the menu was invoked
 * on. Present in both the editable and non-editable menus - inspecting a form
 * field is exactly as useful as inspecting body content - and always last, as
 * it is in Chrome.
 */
function inspectItem(
  params: ContextMenuParams,
  webContents: WebContents,
): MenuItemConstructorOptions {
  const { x, y } = params;
  return {
    label: 'Inspect',
    click: () => {
      openDetachedDevTools(webContents);
      webContents.inspectElement(x, y);
    },
  };
}

/**
 * The Chrome-shaped menu, for remote content in the AEM pane and its auxiliary
 * windows. Ordering follows Chrome: element-specific actions first (editable
 * field, link, image), then the selection, then page navigation - which is
 * always present so the menu is never empty over a bare page - and Inspect
 * last.
 */
export function buildChromeTemplate(
  params: ContextMenuParams,
  webContents: WebContents,
  target: ChromeContextMenuTarget,
): MenuItemConstructorOptions[] {
  const { editFlags } = params;

  if (params.isEditable) {
    return [
      { label: 'Undo', enabled: editFlags.canUndo, click: () => webContents.undo() },
      { label: 'Redo', enabled: editFlags.canRedo, click: () => webContents.redo() },
      { type: 'separator' },
      { label: 'Cut', enabled: editFlags.canCut, click: () => webContents.cut() },
      { label: 'Copy', enabled: editFlags.canCopy, click: () => webContents.copy() },
      { label: 'Paste', enabled: editFlags.canPaste, click: () => webContents.paste() },
      { type: 'separator' },
      {
        label: 'Select all',
        enabled: editFlags.canSelectAll,
        click: () => webContents.selectAll(),
      },
      { type: 'separator' },
      inspectItem(params, webContents),
    ];
  }

  const template: MenuItemConstructorOptions[] = [];

  if (params.linkURL.length > 0) {
    const linkUrl = params.linkURL;
    template.push(
      { label: 'Open link', click: () => target.openLink(linkUrl) },
      {
        label: 'Copy link address',
        click: () => {
          void clipboard.writeText(linkUrl);
        },
      },
      { type: 'separator' },
    );
  }

  if (params.mediaType === 'image' && params.srcURL.length > 0) {
    const { x, y, srcURL } = params;
    template.push(
      { label: 'Copy image', click: () => webContents.copyImageAt(x, y) },
      {
        label: 'Copy image address',
        click: () => {
          void clipboard.writeText(srcURL);
        },
      },
      { label: 'Save image as…', click: () => webContents.downloadURL(srcURL) },
      { type: 'separator' },
    );
  }

  if (params.selectionText.length > 0) {
    template.push(
      { label: 'Copy', enabled: editFlags.canCopy, click: () => webContents.copy() },
      { type: 'separator' },
    );
  }

  const history = webContents.navigationHistory;
  template.push(
    { label: 'Back', enabled: history.canGoBack(), click: () => history.goBack() },
    { label: 'Forward', enabled: history.canGoForward(), click: () => history.goForward() },
    { label: 'Reload', click: () => webContents.reload() },
    { type: 'separator' },
    inspectItem(params, webContents),
  );

  return template;
}

/**
 * Pops `template` on `window`. The owner window is passed explicitly rather
 * than looked up from `webContents`: the AEM pane's `WebContentsView` is not a
 * window's own webContents, and `Menu.popup` needs a window to anchor to.
 */
function popup(window: BrowserWindow, template: MenuItemConstructorOptions[]): void {
  if (template.length === 0 || window.isDestroyed()) {
    return;
  }
  Menu.buildFromTemplate(template).popup({ window });
}

/** Attaches the clipboard menu to one of the app's own renderer surfaces. */
export function attachClipboardContextMenu(webContents: WebContents, window: BrowserWindow): void {
  webContents.on('context-menu', (_event, params) => {
    popup(window, buildClipboardTemplate(params, webContents));
  });
}

/** Attaches the Chrome-shaped menu to a remote-content surface (the AEM pane). */
export function attachChromeContextMenu(
  webContents: WebContents,
  window: BrowserWindow,
  target: ChromeContextMenuTarget,
): void {
  webContents.on('context-menu', (_event, params) => {
    popup(window, buildChromeTemplate(params, webContents, target));
  });
}
