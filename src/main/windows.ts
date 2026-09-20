import { app, BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAppIconPath } from './appIcon';
import { buildAppUrl } from './browser/appProtocol';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const APP_PRELOAD_PATH = path.join(currentDir, '../preload/app-preload.js');

/**
 * The app's Application User Model ID. Must match electron-builder.yml's
 * `appId` so that a packaged install's Start Menu shortcut, the process-level
 * ID set in `index.ts`, and each window's `setAppDetails` ID are all one
 * identity.
 */
export const APP_USER_MODEL_ID = 'com.etoolboxdaisy.app';

/**
 * The app's own icon, resolved once for every window this process creates -
 * the main window here and the AEM pane's auxiliary (popup) windows in
 * `browser/auxiliaryWindows.ts`. `undefined` when the icon is missing, so
 * `exactOptionalPropertyTypes` requires the `icon` option to be omitted
 * rather than set to `undefined`; hence the conditional spread at each use.
 */
export const APP_ICON_PATH = resolveAppIconPath({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  mainDir: currentDir,
  join: (...segments) => path.join(...segments),
  exists: existsSync,
});

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

  const relaunchCommand = app.isPackaged
    ? `"${process.execPath}"`
    : `"${process.execPath}" "${app.getAppPath()}"`;

  window.setAppDetails({
    appId: APP_USER_MODEL_ID,
    ...(APP_ICON_PATH ? { appIconPath: APP_ICON_PATH, appIconIndex: 0 } : {}),
    relaunchCommand,
    relaunchDisplayName: app.getName(),
  });
}

/**
 * Creates the single local app window (browser pane + chat pane shell come in
 * later steps). Security baseline is non-negotiable: context isolation and
 * the sandbox are always on, Node integration is always off, and
 * `webSecurity` is never disabled.
 *
 * Loads the app's own UI from the `app://` scheme (step 05) rather than
 * `file://` - see `browser/appProtocol.ts`'s doc comment for why - falling
 * back to the electron-vite dev server URL unchanged.
 */
export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    ...(APP_ICON_PATH ? { icon: APP_ICON_PATH } : {}),
    webPreferences: {
      preload: APP_PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  applyTaskbarAppDetails(window);

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
