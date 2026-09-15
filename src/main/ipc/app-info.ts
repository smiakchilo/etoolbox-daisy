import { app, ipcMain } from 'electron';
import { APP_INFO_CHANNEL, type AppInfo } from '../../shared';

/**
 * Registers the single IPC handler step 01 needs: a read-only app-info query
 * used to prove the preload bridge works end to end. Later steps add their
 * own narrow handlers next to this one instead of a generic "call anything"
 * bridge.
 */
export function registerAppInfoHandler(): void {
  ipcMain.handle(APP_INFO_CHANNEL, (): AppInfo => {
    return {
      name: app.getName(),
      version: app.getVersion(),
      apiVersion: 1,
    };
  });
}
