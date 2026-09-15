import { BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAppUrl } from './browser/appProtocol';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const APP_PRELOAD_PATH = path.join(currentDir, '../preload/app-preload.js');
const APP_ICON_PATH = path.join(currentDir, '../../build/icon.ico');

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
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: APP_PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

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

/**
 * Opens the Settings child window (requirements-decisions.md section 8): a
 * separate local window, not a pane or a modal over the main window, using
 * the same privileged app preload (it needs `window.daisy.settings.*`, not
 * `window.daisyAem`). `parent` keeps it associated with the main window
 * (closes with it, stays above it) without making it modal - the main
 * window/AEM view must stay usable while Settings is open.
 */
export function createSettingsWindow(parent: BrowserWindow): BrowserWindow {
  const window = new BrowserWindow({
    width: 720,
    height: 640,
    show: false,
    parent,
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: APP_PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl) {
    void window.loadURL(`${devServerUrl}/settings.html`);
  } else {
    void window.loadURL(buildAppUrl('settings.html'));
  }

  return window;
}
