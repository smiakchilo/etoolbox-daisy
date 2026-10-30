import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  ADDONS_CONTRIBUTIONS_CHANNEL,
  type AddonContributionsEntry,
  type AddonContributionsResult,
} from '../../shared';
import type { Logger } from '../logger';
import { isTrustedSkillsIpcSender, type SkillsIpcSenderInfo } from './skills';

/**
 * The `addons:contributions` IPC: what the add-ons built into this install
 * contribute. No payload - main reads the descriptors once at startup, and the
 * renderer only gets the contributions, never a path.
 */
export interface AddonsIpcDependencies {
  readonly contributions: readonly AddonContributionsEntry[];
  readonly logger: Logger;
  readonly rendererDistDir: string;
  readonly mainWebContentsId: number;
}

function senderInfoFrom(event: IpcMainInvokeEvent): SkillsIpcSenderInfo | undefined {
  const frame = event.senderFrame;
  if (!frame) return undefined;
  return { url: frame.url, isMainFrame: frame.top === frame, webContentsId: event.sender.id };
}

export function registerAddonsIpcHandlers(deps: AddonsIpcDependencies): void {
  ipcMain.handle(ADDONS_CONTRIBUTIONS_CHANNEL, (event): Promise<AddonContributionsResult> => {
    if (!isTrustedSkillsIpcSender(senderInfoFrom(event), deps)) {
      deps.logger.warn('ADDONS_IPC_SENDER_REJECTED');
      return Promise.resolve({
        ok: false,
        error: {
          code: 'untrusted_sender',
          message: 'This request must come from the local app window',
        },
      });
    }
    return Promise.resolve({ ok: true, addons: [...deps.contributions] });
  });
}
