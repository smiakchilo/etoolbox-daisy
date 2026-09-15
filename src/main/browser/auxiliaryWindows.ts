import { BrowserWindow } from 'electron';
import type { HandlerDetails, Session, WebContents, WindowOpenHandlerResponse } from 'electron';
import { decideAuxiliaryWindowOpen } from './auxiliaryWindowPolicy';

/**
 * Manages HTTP(S) auxiliary windows opened by the AEM view (login popups,
 * SSO redirect windows) - implementation-plan.md step 05;
 * requirements-decisions.md section 3.
 *
 * Every window this manager creates:
 *  - shares the AEM session (`aemSession`), never a separate/default one, so
 *    it sees the same cookies/proxy/certificate exceptions as the main AEM
 *    view;
 *  - gets no `preload` at all - not even the AEM preload - because an
 *    auxiliary sign-in window is IdP-hosted content the app does not control,
 *    and the AEM preload's small bridge surface has no reason to be exposed
 *    to a third-party login page;
 *  - is tracked in {@link openWindows} so {@link closeAll} (called by
 *    `serverSwitch.ts` before the proxy switch) can close every one of them
 *    on a server switch, so no auxiliary window survives into the new
 *    server's proxy/session context.
 *
 * `decideAuxiliaryWindowOpen` is applied both to the initial `window.open`
 * call and, recursively, to every window an auxiliary window itself opens -
 * some SSO flows chain through more than one popup - so the same http(s)-only
 * policy governs the whole chain, not just its first hop.
 */
export interface AuxiliaryWindowManager {
  /** Wires the allow/deny policy onto one AEM-affiliated `WebContents` (the AEM view itself, or a previously created auxiliary window). */
  attachTo(webContents: WebContents): void;
  /** Closes every currently open auxiliary window. Safe to call when none are open. */
  closeAll(): void;
}

export function createAuxiliaryWindowManager(aemSession: Session): AuxiliaryWindowManager {
  const openWindows = new Set<BrowserWindow>();

  function attachTo(webContents: WebContents): void {
    webContents.setWindowOpenHandler((details: HandlerDetails): WindowOpenHandlerResponse => {
      const decision = decideAuxiliaryWindowOpen(details.url);
      if (decision.kind !== 'allow') {
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
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
      openWindows.add(childWindow);
      // Deny by default was already the app-wide baseline before this
      // manager existed (`security.ts`); re-applying the same narrow policy
      // here (rather than leaving the child window's own handler unset,
      // which Electron defaults to allow-with-a-warning) is what actually
      // enforces "reject unexpected file:/custom schemes" for a *chained*
      // popup, not just the first one.
      attachTo(childWindow.webContents);
      childWindow.webContents.on('will-navigate', (navigationEvent, targetUrl) => {
        if (decideAuxiliaryWindowOpen(targetUrl).kind !== 'allow') {
          navigationEvent.preventDefault();
        }
      });
      childWindow.on('closed', () => {
        openWindows.delete(childWindow);
      });
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
