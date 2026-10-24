import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { mkdir } from 'node:fs/promises';
import {
  RULES_OPEN_FOLDER_CHANNEL,
  RULES_RELOAD_CHANNEL,
  type RulesOpenFolderResult,
  type RulesReloadResult,
} from '../../shared';
import type { Logger } from '../logger';
import { isTrustedSkillsIpcSender, type SkillsIpcSenderInfo } from './skills';

/**
 * The `rules:open-folder` IPC: the Settings "Skills" tab's **Custom rules
 * folder** link. The request carries no payload - main opens the one fixed
 * user-rules folder (creating it when missing), so the renderer can never steer
 * the OS file manager at an arbitrary path. Same shape, and the same sender
 * guard, as the skills link.
 */

export interface RulesFolderOpener {
  /** The user-rules folder; created on demand. */
  readonly directory: string;
  readonly logger: Logger;
  /** `shell.openPath`: resolves to an error message, or `''` on success. */
  readonly openPath: (path: string) => Promise<string>;
}

/** Creates the folder if needed and hands it to the OS file manager. */
export async function openRulesFolder(opener: RulesFolderOpener): Promise<RulesOpenFolderResult> {
  const failed = await mkdir(opener.directory, { recursive: true })
    .then(async () => (await opener.openPath(opener.directory)) !== '')
    .catch(() => true);
  if (failed) {
    // The reason is not logged: it can carry the profile path (the logger's no-free-text rule).
    opener.logger.error('RULES_FOLDER_OPEN_FAILED', { outcome: 'failure' });
    return {
      ok: false,
      error: { code: 'open_failed', message: 'The rules folder could not be opened' },
    };
  }
  return { ok: true };
}

export interface RulesIpcDependencies {
  readonly directory: string;
  readonly logger: Logger;
  readonly rendererDistDir: string;
  readonly mainWebContentsId: number;
  /** Re-reads the rules and resolves to the number of rules now loaded. */
  readonly reload: () => Promise<number>;
}

/** Runs the reload; a failure is reported, never thrown into the renderer. */
export async function reloadRules(
  reload: () => Promise<number>,
  logger: Logger,
): Promise<RulesReloadResult> {
  try {
    return { ok: true, count: await reload() };
  } catch {
    logger.error('RULES_RELOAD_FAILED', { outcome: 'failure' });
    return {
      ok: false,
      error: { code: 'reload_failed', message: 'The rules could not be reloaded' },
    };
  }
}

function senderInfoFrom(event: IpcMainInvokeEvent): SkillsIpcSenderInfo | undefined {
  const frame = event.senderFrame;
  if (!frame) return undefined;
  return { url: frame.url, isMainFrame: frame.top === frame, webContentsId: event.sender.id };
}

export function registerRulesIpcHandlers(deps: RulesIpcDependencies): void {
  ipcMain.handle(RULES_OPEN_FOLDER_CHANNEL, (event): Promise<RulesOpenFolderResult> => {
    if (!isTrustedSkillsIpcSender(senderInfoFrom(event), deps)) {
      deps.logger.warn('RULES_IPC_SENDER_REJECTED');
      return Promise.resolve({
        ok: false,
        error: {
          code: 'untrusted_sender',
          message: 'This request must come from the local app window',
        },
      });
    }
    return openRulesFolder({
      directory: deps.directory,
      logger: deps.logger,
      openPath: (path) => shell.openPath(path),
    });
  });

  ipcMain.handle(RULES_RELOAD_CHANNEL, (event): Promise<RulesReloadResult> => {
    if (!isTrustedSkillsIpcSender(senderInfoFrom(event), deps)) {
      deps.logger.warn('RULES_IPC_SENDER_REJECTED');
      return Promise.resolve({
        ok: false,
        error: {
          code: 'untrusted_sender',
          message: 'This request must come from the local app window',
        },
      });
    }
    return reloadRules(deps.reload, deps.logger);
  });
}
