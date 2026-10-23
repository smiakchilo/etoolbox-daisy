import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { CREDENTIALS_ERASE_CHANNEL, type CredentialsIpcResult } from '../../shared';
import type { Logger } from '../logger';
import type { CredentialVault } from '../credentials/credentialVault';
import { isTrustedSkillsIpcSender, type SkillsIpcSenderInfo } from './skills';

/**
 * The saved-sign-ins IPC: the Settings "Browser" tab's one action.
 *
 * There is exactly one call and it takes no payload: there is no "delete this
 * one" (the owner chose all-or-nothing) and no read (a password never reaches
 * the renderer, and a username list would be the picker the backlog records as
 * deferred). The sender guard is the app-renderer one (`isTrustedSkillsIpcSender`),
 * shared with the skills, rules and memos links.
 */
export interface CredentialsIpcDependencies {
  readonly vault: Pick<CredentialVault, 'eraseAll' | 'ready'>;
  readonly logger: Logger;
  readonly rendererDistDir: string;
  readonly mainWebContentsId: number;
}

const UNTRUSTED: CredentialsIpcResult = {
  ok: false,
  error: {
    code: 'untrusted_sender',
    message: 'This request must come from the local app window',
  },
};

const STORAGE_FAILED: CredentialsIpcResult = {
  ok: false,
  error: {
    code: 'storage_error',
    message: 'The saved sign-ins could not be erased',
  },
};

function senderInfoFrom(event: IpcMainInvokeEvent): SkillsIpcSenderInfo | undefined {
  const frame = event.senderFrame;
  if (!frame) return undefined;
  return { url: frame.url, isMainFrame: frame.top === frame, webContentsId: event.sender.id };
}

export function registerCredentialsIpcHandlers(deps: CredentialsIpcDependencies): void {
  ipcMain.handle(CREDENTIALS_ERASE_CHANNEL, async (event): Promise<CredentialsIpcResult> => {
    if (!isTrustedSkillsIpcSender(senderInfoFrom(event), deps)) {
      deps.logger.warn('CREDENTIALS_IPC_SENDER_REJECTED');
      return UNTRUSTED;
    }
    await deps.vault.ready;
    try {
      const removed = await deps.vault.eraseAll();
      deps.logger.info('CREDENTIALS_ERASED', { count: removed });
      return { ok: true };
    } catch {
      // A failed secret deletion or index removal: the status line is the only
      // place the user learns the forget did not happen.
      deps.logger.error('CREDENTIALS_ERASE_FAILED', { count: 1 });
      return STORAGE_FAILED;
    }
  });
}
