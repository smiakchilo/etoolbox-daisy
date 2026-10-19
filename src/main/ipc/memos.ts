import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { mkdir } from 'node:fs/promises';
import {
  MEMOS_OPEN_FOLDER_CHANNEL,
  MEMOS_REVEAL_CHANNEL,
  MEMOS_UNDO_CHANNEL,
  memoFileRequestSchema,
  type MemosIpcResult,
} from '../../shared';
import type { Logger } from '../logger';
import type { MemoStore } from '../memos/memoStore';
import { isTrustedSkillsIpcSender, type SkillsIpcSenderInfo } from './skills';

/**
 * The memo IPC surface: the Settings **Memos folder** link (`memos:open-folder`,
 * no payload) and a memo billet's **Reveal in folder** / **Undo** actions
 * (`memos:reveal` / `memos:undo`, naming a memo by its store-relative id). The
 * renderer never sends a path: main resolves the id inside the memos folder.
 * Same sender guard as the skills and rules links.
 */

export interface MemosIpcOperations {
  /** The memos folder; created on demand. */
  readonly directory: string;
  readonly store: Pick<MemoStore, 'locate' | 'remove'>;
  readonly logger: Logger;
  /** `shell.openPath`: resolves to an error message, or `''` on success. */
  readonly openPath: (path: string) => Promise<string>;
  /** `shell.showItemInFolder`. */
  readonly showItemInFolder: (path: string) => void;
}

const NOT_FOUND: MemosIpcResult = {
  ok: false,
  error: { code: 'not_found', message: 'The memo is no longer in the memos folder' },
};

const INVALID_PAYLOAD: MemosIpcResult = {
  ok: false,
  error: { code: 'invalid_payload', message: 'The memo request is not valid' },
};

/** Creates the folder if needed and hands it to the OS file manager. */
export async function openMemosFolder(ops: MemosIpcOperations): Promise<MemosIpcResult> {
  const failed = await mkdir(ops.directory, { recursive: true })
    .then(async () => (await ops.openPath(ops.directory)) !== '')
    .catch(() => true);
  if (failed) {
    // The reason is not logged: it can carry the profile path (the logger's no-free-text rule).
    ops.logger.error('MEMOS_FOLDER_OPEN_FAILED', { outcome: 'failure' });
    return {
      ok: false,
      error: { code: 'open_failed', message: 'The memos folder could not be opened' },
    };
  }
  return { ok: true };
}

export async function revealMemo(
  ops: MemosIpcOperations,
  payload: unknown,
): Promise<MemosIpcResult> {
  const request = memoFileRequestSchema.safeParse(payload);
  if (!request.success) return INVALID_PAYLOAD;
  const absolute = await ops.store.locate(request.data.id);
  if (absolute === undefined) return NOT_FOUND;
  ops.showItemInFolder(absolute);
  return { ok: true };
}

export async function undoMemo(ops: MemosIpcOperations, payload: unknown): Promise<MemosIpcResult> {
  const request = memoFileRequestSchema.safeParse(payload);
  if (!request.success) return INVALID_PAYLOAD;
  return (await ops.store.remove(request.data.id)) ? { ok: true } : NOT_FOUND;
}

export interface MemosIpcDependencies {
  readonly directory: string;
  readonly store: Pick<MemoStore, 'locate' | 'remove'>;
  readonly logger: Logger;
  readonly rendererDistDir: string;
  readonly mainWebContentsId: number;
}

function senderInfoFrom(event: IpcMainInvokeEvent): SkillsIpcSenderInfo | undefined {
  const frame = event.senderFrame;
  if (!frame) return undefined;
  return { url: frame.url, isMainFrame: frame.top === frame, webContentsId: event.sender.id };
}

export function registerMemosIpcHandlers(deps: MemosIpcDependencies): void {
  const ops: MemosIpcOperations = {
    directory: deps.directory,
    store: deps.store,
    logger: deps.logger,
    openPath: (path) => shell.openPath(path),
    showItemInFolder: (path) => shell.showItemInFolder(path),
  };

  function guarded(
    event: IpcMainInvokeEvent,
    run: () => Promise<MemosIpcResult>,
  ): Promise<MemosIpcResult> {
    if (!isTrustedSkillsIpcSender(senderInfoFrom(event), deps)) {
      deps.logger.warn('MEMOS_IPC_SENDER_REJECTED');
      return Promise.resolve({
        ok: false,
        error: {
          code: 'untrusted_sender',
          message: 'This request must come from the local app window',
        },
      });
    }
    return run();
  }

  ipcMain.handle(MEMOS_OPEN_FOLDER_CHANNEL, (event) => guarded(event, () => openMemosFolder(ops)));
  ipcMain.handle(MEMOS_REVEAL_CHANNEL, (event, payload: unknown) =>
    guarded(event, () => revealMemo(ops, payload)),
  );
  ipcMain.handle(MEMOS_UNDO_CHANNEL, (event, payload: unknown) =>
    guarded(event, () => undoMemo(ops, payload)),
  );
}
