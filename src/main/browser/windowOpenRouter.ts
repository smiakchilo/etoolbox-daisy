import { BrowserWindow } from 'electron';
import type { HandlerDetails, Session, WebContents } from 'electron';
import { attachChromeContextMenu } from '../contextMenu';
import { applyTaskbarAppDetails, getAppIconPath } from '../windows';
import { decideAllowedUrl } from './urlPolicy';
import { decideWindowOpen } from './windowOpenPolicy';

/**
 * Carries the pane's new-window policy across the process boundary
 * (`windowOpenPolicy.ts` decides popup vs tab; this module acts on it).
 *
 * Popups get a real `BrowserWindow` that shares the pane's session - so an SSO
 * popup's `window.opener` back-channel still works - and are tracked here so a
 * server switch can close them. Tabs are loaded in the requesting view itself
 * (see `openUrlInView`). A popup's own chained popups are governed by the same
 * policy, because `registerWindow` attaches this router to the child's
 * `WebContents` too.
 */
export interface WindowOpenRouter {
  /** Wires the popup/tab policy onto one remote-content `WebContents` (the pane view, or a previously opened popup). */
  attachTo(webContents: WebContents): void;
  /** Closes every open popup. Safe to call when none are open. */
  closeAll(): void;
}

export function createWindowOpenRouter(session: Session): WindowOpenRouter {
  const openWindows = new Set<BrowserWindow>();

  function popupWebPreferences(): Electron.WebPreferences {
    return {
      session,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    };
  }

  /**
   * Applies the shared appearance and policy to one popup window, whether it
   * was created by a page's `window.open` or is a chained popup of another
   * popup. Both paths must end up tracked, taskbar-branded, policy-attached
   * (including their own chained popups) and given the Chrome-shaped context
   * menu - so they share this one place rather than each repeating it.
   */
  function registerWindow(childWindow: BrowserWindow): void {
    openWindows.add(childWindow);
    applyTaskbarAppDetails(childWindow);
    attachTo(childWindow.webContents);
    attachChromeContextMenu(childWindow.webContents, childWindow, {
      openLink: (url) => openUrlInView(childWindow.webContents, url),
    });
    childWindow.webContents.on('will-navigate', (navigationEvent, targetUrl) => {
      if (decideAllowedUrl(targetUrl).kind !== 'allow') {
        navigationEvent.preventDefault();
      }
    });
    childWindow.on('closed', () => {
      openWindows.delete(childWindow);
    });
  }

  function attachTo(webContents: WebContents): void {
    webContents.setWindowOpenHandler((details: HandlerDetails) => {
      const decision = decideWindowOpen(details);
      if (decision.kind === 'popup') {
        const appIconPath = getAppIconPath();
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            // Same window icon as the main window (see `windows.ts`),
            // otherwise Electron's default is used and an SSO popup shows the
            // Electron icon in the taskbar.
            ...(appIconPath ? { icon: appIconPath } : {}),
            webPreferences: popupWebPreferences(),
          },
        };
      }
      if (decision.kind === 'navigate-in-place') {
        openUrlInView(webContents, details.url);
      }
      return { action: 'deny' };
    });

    webContents.on('did-create-window', (childWindow) => {
      registerWindow(childWindow);
    });
  }

  function closeAll(): void {
    for (const window of openWindows) {
      if (!window.isDestroyed()) {
        window.close();
      }
    }
    openWindows.clear();
  }

  return { attachTo, closeAll };
}

/** Loads `url` in `webContents` if the URL policy allows it; a rejected navigation is left to the normal `did-fail-load` state push. */
export function openUrlInView(webContents: WebContents, url: string): void {
  if (decideAllowedUrl(url).kind !== 'allow') return;
  // A failed load reaches the user through `did-fail-load` ->
  // `onNavigationStateChange`, the same as any other navigation; the
  // rejection itself is expected here and consumed so it never surfaces as an
  // unhandled promise rejection.
  void webContents.loadURL(url).catch(() => undefined);
}
