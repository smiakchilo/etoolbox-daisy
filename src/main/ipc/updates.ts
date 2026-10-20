import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import {
  UPDATES_APPLY_CHANNEL,
  UPDATES_CHECK_CHANNEL,
  UPDATES_GET_STATUS_CHANNEL,
  type UpdatesIpcResult,
} from '../../shared';
import type { Logger } from '../logger';
import type { Updater } from '../updates/updater';
import { isTrustedSkillsIpcSender, type SkillsIpcSenderInfo } from './skills';

/**
 * The updates IPC surface: read the status, check now, apply the pending
 * update. Every call answers with the resulting status; the renderer never
 * names a URL or a file, so main alone decides what is fetched and swapped.
 * Same sender guard as the skills, rules and memos links.
 */
export interface UpdatesIpcDependencies {
  readonly updater: Updater;
  readonly logger: Logger;
  readonly rendererDistDir: string;
  readonly mainWebContentsId: number;
}

function senderInfoFrom(event: IpcMainInvokeEvent): SkillsIpcSenderInfo | undefined {
  const frame = event.senderFrame;
  if (!frame) return undefined;
  return { url: frame.url, isMainFrame: frame.top === frame, webContentsId: event.sender.id };
}

export function registerUpdatesIpcHandlers(deps: UpdatesIpcDependencies): void {
  async function guarded(
    event: IpcMainInvokeEvent,
    run: () => Promise<UpdatesIpcResult> | UpdatesIpcResult,
  ): Promise<UpdatesIpcResult> {
    if (!isTrustedSkillsIpcSender(senderInfoFrom(event), deps)) {
      deps.logger.warn('UPDATES_IPC_SENDER_REJECTED');
      return {
        ok: false,
        error: {
          code: 'untrusted_sender',
          message: 'This request must come from the local app window',
        },
      };
    }
    return run();
  }

  ipcMain.handle(UPDATES_GET_STATUS_CHANNEL, (event) =>
    guarded(event, () => ({ ok: true, status: deps.updater.getStatus() })),
  );
  ipcMain.handle(UPDATES_CHECK_CHANNEL, (event) =>
    guarded(event, async () => ({ ok: true, status: await deps.updater.check() })),
  );
  ipcMain.handle(UPDATES_APPLY_CHANNEL, (event) =>
    guarded(event, async () => ({ ok: true, status: await deps.updater.apply() })),
  );
}
