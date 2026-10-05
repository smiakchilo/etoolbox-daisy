import { app, BrowserWindow, screen } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAppIconPath } from './appIcon';
import { buildAppUrl } from './browser/appProtocol';
import { attachClipboardContextMenu } from './contextMenu';
import { attachDevToolsShortcut } from './devTools';
import {
  attachWindowStatePersistence,
  fitWindowStateToWorkArea,
  readWindowState,
} from './windowState';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const APP_PRELOAD_PATH = path.join(currentDir, '../preload/app-preload.js');

/**
 * The app's Application User Model ID. Must match electron-builder.yml's
 * `appId` so that a packaged install's Start Menu shortcut, the process-level
 * ID set in `index.ts`, and each window's `setAppDetails` ID are all one
 * identity.
 */
export const APP_USER_MODEL_ID = 'com.etoolboxdaisy.app';

let cachedAppIconPath: string | undefined;
let appIconPathResolved = false;

/**
 * The app's own icon, resolved once on first use for the windows this process
 * creates. Resolved lazily - not at module scope - because `app.isPackaged`
 * requires a running Electron process, which would make merely importing this
 * module fail anywhere Electron is absent (unit tests importing any module
 * that transitively reaches here).
 *
 * `undefined` when the icon is missing, so `exactOptionalPropertyTypes`
 * requires the `icon` option to be omitted rather than set to `undefined`;
 * hence the conditional spread at each use.
 */
export function getAppIconPath(): string | undefined {
  if (!appIconPathResolved) {
    cachedAppIconPath = resolveAppIconPath({
      platform: process.platform,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      mainDir: currentDir,
      join: (...segments) => path.join(...segments),
      exists: existsSync,
    });
    appIconPathResolved = true;
  }
  return cachedAppIconPath;
}

/**
 * Points a window's taskbar button at the app's own identity (name + icon).
 *
 * Windows resolves the taskbar right-click/context menu header from the
 * AppUserModelID's *relaunch metadata*, not from the window `icon` - and a
 * source/unpackaged build has no Start Menu shortcut registering that
 * metadata, so without this the header reads "Electron" with Electron's icon
 * even though the button's own icon is correct. `setAppDetails` sets those
 * properties directly on the window (no registry key or shortcut needed), so
 * it works in dev and in a packaged build alike.
 *
 * `relaunchCommand` and `relaunchDisplayName` must be supplied together or
 * Windows ignores both; `relaunchCommand` is also what "Pin to taskbar"
 * launches, so in dev it re-runs this same Electron binary against the app
 * directory. No-op off Windows (`setAppDetails` is win32-only).
 */
export function applyTaskbarAppDetails(window: BrowserWindow): void {
  if (process.platform !== 'win32') {
    return;
  }

  const appIconPath = getAppIconPath();

  const relaunchCommand = app.isPackaged
    ? `"${process.execPath}"`
    : `"${process.execPath}" "${app.getAppPath()}"`;

  window.setAppDetails({
    appId: APP_USER_MODEL_ID,
    ...(appIconPath ? { appIconPath, appIconIndex: 0 } : {}),
    relaunchCommand,
    relaunchDisplayName: app.getName(),
  });
}

/**
 * Options for {@link createMainWindow}.
 */
export interface CreateMainWindowOptions {
  /**
   * Absolute path to the window-geometry file, read before the window is
   * created and rewritten as the window is resized/maximized/closed. See
   * `windowState.ts`.
   */
  readonly windowStateFilePath: string;
}

/**
 * Creates the single local app window (browser pane + chat pane shell come in
 * later steps). Security baseline is non-negotiable: context isolation and
 * the sandbox are always on, Node integration is always off, and
 * `webSecurity` is never disabled.
 *
 * The window's size and maximized-ness are restored from
 * `options.windowStateFilePath` (clamped to the primary display's work area so
 * a size remembered on a larger monitor still fits) and re-saved as it
 * changes. Deliberately size + maximized only - the OS places the window, so a
 * stale position can never strand it off-screen.
 *
 * Loads the app's own UI from the `app://` scheme (step 05) rather than
 * `file://` - see `browser/appProtocol.ts`'s doc comment for why - falling
 * back to the electron-vite dev server URL unchanged.
 */
export function createMainWindow(options: CreateMainWindowOptions): BrowserWindow {
  const appIconPath = getAppIconPath();

  const restored = fitWindowStateToWorkArea(
    readWindowState(options.windowStateFilePath),
    screen.getPrimaryDisplay().workAreaSize,
  );

  const window = new BrowserWindow({
    width: restored.width,
    height: restored.height,
    show: false,
    ...(appIconPath ? { icon: appIconPath } : {}),
    webPreferences: {
      preload: APP_PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  if (restored.maximized) {
    window.maximize();
  }

  // Attached before the window can be shown. Saving is best-effort and
  // debounced; `close` flushes synchronously so the final size is never lost.
  attachWindowStatePersistence(window, options.windowStateFilePath);

  applyTaskbarAppDetails(window);

  // The app draws its own toolbar, so the shell's own surfaces (transcript,
  // composer, address bar, banners, Settings) offer the clipboard actions from
  // a right-click menu instead of from a native menu bar - which `index.ts`
  // clears process-wide.
  attachClipboardContextMenu(window.webContents, window);

  // Ctrl+Shift+I, restored without a menu bar: the default menu's "Toggle
  // Developer Tools" accelerator is gone with the menu, so the key is bound to
  // this window's own WebContents instead (`devTools.ts`). Same target the menu
  // role used, so the shortcut still means the shell's DevTools.
  attachDevToolsShortcut(window.webContents, window.webContents);

  window.once('ready-to-show', () => {
    window.show();
  });

  // Deny by default. A future "open in browser" affordance must go through a
  // narrow, reviewed IPC call that validates the target - never through this
  // handler, which also fires for remote AEM content in later steps.
  window.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadURL(buildAppUrl('index.html'));
  }

  return window;
}
