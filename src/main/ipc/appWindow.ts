import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { BrowserWindow } from 'electron';
import { APP_OPEN_SETTINGS_WINDOW_CHANNEL } from '../../shared/ipc-channels';
import { isAllowedAppNavigation } from '../security';
import type { Logger } from '../logger';
import { createSettingsWindow } from '../windows';
import type { TrustedWindowRegistry } from './trustedWindows';

/**
 * Registers `app:open-settings-window` (requirements-decisions.md section
 * 8). Kept as its own tiny file rather than folded into `ipc/browser.ts`:
 * this is not part of the browser-shell surface (no `BrowserController`
 * involved), it is a plain "open this local child window" action.
 */
export interface AppWindowIpcDependencies {
  readonly mainWindow: BrowserWindow;
  readonly rendererDistDir: string;
  readonly mainWebContentsId: number;
  readonly logger: Logger;
  /**
   * The Settings window is created here, so trust for it is granted and
   * revoked here too - the settings IPC guard cannot know an id for a window
   * that does not exist yet when handlers are registered.
   */
  readonly trustedWindows: TrustedWindowRegistry;
}

export function registerAppWindowIpcHandlers(deps: AppWindowIpcDependencies): void {
  let settingsWindow: BrowserWindow | undefined;

  function checkSender(event: IpcMainInvokeEvent): boolean {
    const frame = event.senderFrame;
    const trusted =
      frame !== null &&
      event.sender.id === deps.mainWebContentsId &&
      frame.top === frame &&
      isAllowedAppNavigation(frame.url, deps.rendererDistDir);
    if (!trusted) {
      deps.logger.warn('BROWSER_IPC_SENDER_REJECTED');
    }
    return trusted;
  }

  ipcMain.handle(APP_OPEN_SETTINGS_WINDOW_CHANNEL, (event): void => {
    if (!checkSender(event)) return;
    // Focus the existing window instead of opening a second one - the
    // Settings window is a singleton per requirements-decisions.md section 8.
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.focus();
      return;
    }
    settingsWindow = createSettingsWindow(deps.mainWindow);
    const settingsWebContentsId = settingsWindow.webContents.id;
    deps.trustedWindows.add(settingsWebContentsId);
    deps.logger.info('SETTINGS_WINDOW_CREATED');
    settingsWindow.on('closed', () => {
      deps.trustedWindows.remove(settingsWebContentsId);
      settingsWindow = undefined;
    });
  });
}
