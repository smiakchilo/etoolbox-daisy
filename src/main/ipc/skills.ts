import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { mkdir } from 'node:fs/promises';
import { SKILLS_OPEN_FOLDER_CHANNEL, type SkillsOpenFolderResult } from '../../shared';
import type { Logger } from '../logger';
import { isAllowedAppNavigation } from '../security';

/**
 * The `skills:open-folder` IPC: the Settings "Skills" tab's **Custom skills
 * folder** link. The request carries no payload - main opens the one fixed
 * user-skills folder (creating it when missing), so the renderer can never
 * steer the OS file manager at an arbitrary path.
 */

export interface SkillsFolderOpener {
  /** The user-skills folder; created on demand. */
  readonly directory: string;
  readonly logger: Logger;
  /** `shell.openPath`: resolves to an error message, or `''` on success. */
  readonly openPath: (path: string) => Promise<string>;
}

/** Creates the folder if needed and hands it to the OS file manager. */
export async function openSkillsFolder(
  opener: SkillsFolderOpener,
): Promise<SkillsOpenFolderResult> {
  const failed = await mkdir(opener.directory, { recursive: true })
    .then(async () => (await opener.openPath(opener.directory)) !== '')
    .catch(() => true);
  if (failed) {
    // The reason is not logged: it can carry the profile path (the logger's no-free-text rule).
    opener.logger.error('SKILLS_FOLDER_OPEN_FAILED', { outcome: 'failure' });
    return {
      ok: false,
      error: { code: 'open_failed', message: 'The skills folder could not be opened' },
    };
  }
  return { ok: true };
}

export interface SkillsIpcDependencies {
  readonly directory: string;
  readonly logger: Logger;
  readonly rendererDistDir: string;
  readonly mainWebContentsId: number;
}

export interface SkillsIpcSenderInfo {
  readonly url: string;
  readonly isMainFrame: boolean;
  readonly webContentsId: number;
}

/** Only the app's own main-frame renderer may ask. */
export function isTrustedSkillsIpcSender(
  sender: SkillsIpcSenderInfo | undefined,
  expectation: { readonly mainWebContentsId: number; readonly rendererDistDir: string },
): boolean {
  if (!sender) return false;
  return (
    sender.webContentsId === expectation.mainWebContentsId &&
    sender.isMainFrame &&
    isAllowedAppNavigation(sender.url, expectation.rendererDistDir)
  );
}

function senderInfoFrom(event: IpcMainInvokeEvent): SkillsIpcSenderInfo | undefined {
  const frame = event.senderFrame;
  if (!frame) return undefined;
  return { url: frame.url, isMainFrame: frame.top === frame, webContentsId: event.sender.id };
}

export function registerSkillsIpcHandlers(deps: SkillsIpcDependencies): void {
  ipcMain.handle(SKILLS_OPEN_FOLDER_CHANNEL, (event): Promise<SkillsOpenFolderResult> => {
    if (!isTrustedSkillsIpcSender(senderInfoFrom(event), deps)) {
      deps.logger.warn('SKILLS_IPC_SENDER_REJECTED');
      return Promise.resolve({
        ok: false,
        error: {
          code: 'untrusted_sender',
          message: 'This request must come from the local app window',
        },
      });
    }
    return openSkillsFolder({
      directory: deps.directory,
      logger: deps.logger,
      openPath: (path) => shell.openPath(path),
    });
  });
}
