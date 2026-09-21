import { BrowserWindow } from 'electron';
import type { HandlerDetails, Session, WebContents, WindowOpenHandlerResponse } from 'electron';
import { attachChromeContextMenu } from '../contextMenu';
import { APP_ICON_PATH, applyTaskbarAppDetails } from '../windows';
import { decideAuxiliaryWindowOpen } from './auxiliaryWindowPolicy';

/**
 * Manages HTTP(S) auxiliary windows opened by the AEM view (login popups,
 * SSO redirect windows) - implementation-plan.md step 05;
 * requirements-decisions.md section 3.
 * `decideAuxiliaryWindowOpen` is applied both to the initial `window.open`
 * call and, recursively, to every window an auxiliary window itself opens -
 * some SSO flows chain through more than one popup - so the same http(s)-only
 * policy governs the whole chain, not just its first hop.
 */
export interface AuxiliaryWindowManager {
  /** Wires the allow/deny policy onto one AEM-affiliated `WebContents` (the AEM view itself, or a previously created auxiliary window). */
  attachTo(webContents: WebContents): void;
  /** Opens `url` in a new managed window, after the same policy check a `window.open` from the page would face. */
  openWindow(url: string): void;
  /** Closes every currently open auxiliary window. Safe to call when none are open. */
  closeAll(): void;
}

export function createAuxiliaryWindowManager(aemSession: Session): AuxiliaryWindowManager {
  const openWindows = new Set<BrowserWindow>();

  /**
   * Applies the shared auxiliary-window policy and appearance to one child
   * window, whether it was created by a page's `window.open` or requested by
   * the context menu's "Open link in new window". Both paths must end up
   * tracked, taskbar-branded, policy-attached (including their own chained
   * popups) and given the Chrome-shaped context menu - so they share this one
   * place rather than each repeating it.
   */
  function registerWindow(childWindow: BrowserWindow): void {
    openWindows.add(childWindow);
    applyTaskbarAppDetails(childWindow);
    // Deny by default was already the app-wide baseline before this
    // manager existed (`security.ts`); re-applying the same narrow policy
    // here (rather than leaving the child window's own handler unset,
    // which Electron defaults to allow-with-a-warning) is what actually
    // enforces "reject unexpected file:/custom schemes" for a *chained*
    // popup, not just the first one.
    attachTo(childWindow.webContents);
    attachChromeContextMenu(childWindow.webContents, childWindow, {
      openLinkInNewWindow: (url) => openWindow(url),
    });
    childWindow.webContents.on('will-navigate', (navigationEvent, targetUrl) => {
      if (decideAuxiliaryWindowOpen(targetUrl).kind !== 'allow') {
        navigationEvent.preventDefault();
      }
    });
    childWindow.on('closed', () => {
      openWindows.delete(childWindow);
    });
  }

  function attachTo(webContents: WebContents): void {
    webContents.setWindowOpenHandler((details: HandlerDetails): WindowOpenHandlerResponse => {
      const decision = decideAuxiliaryWindowOpen(details.url);
      if (decision.kind !== 'allow') {
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          // Same window icon as the main window (see `windows.ts`), otherwise
          // Electron's default is used and a login/SSO popup shows the
          // Electron icon in the taskbar.
          ...(APP_ICON_PATH ? { icon: APP_ICON_PATH } : {}),
          webPreferences: {
            session: aemSession,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webSecurity: true,
          },
        },
      };
    });

    webContents.on('did-create-window', (childWindow) => {
      registerWindow(childWindow);
    });
  }

  /**
   * Opens a link from the AEM pane's context menu. The URL is validated with
   * `decideAuxiliaryWindowOpen` exactly as a page-initiated `window.open`
   * would be, so the menu can never widen what the AEM content is allowed to
   * open; a rejected URL is silently ignored.
   */
  function openWindow(url: string): void {
    if (decideAuxiliaryWindowOpen(url).kind !== 'allow') {
      return;
    }
    const childWindow = new BrowserWindow({
      ...(APP_ICON_PATH ? { icon: APP_ICON_PATH } : {}),
      webPreferences: {
        session: aemSession,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    registerWindow(childWindow);
    void childWindow.loadURL(url);
  }

  function closeAll(): void {
    for (const window of openWindows) {
      if (!window.isDestroyed()) {
        window.close();
      }
    }
    openWindows.clear();
  }

  return { attachTo, openWindow, closeAll };
}
