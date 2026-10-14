import {
  dialog,
  ipcMain,
  shell,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { TABLE_EXPORT_REVEAL_LAST_CHANNEL, TABLE_EXPORT_SAVE_CSV_CHANNEL } from '../../shared';
import {
  tableExportSaveCsvRequestSchema,
  type TableExportErrorCode,
  type TableExportRevealResult,
  type TableExportSaveCsvResult,
} from '../../shared';
import { isAllowedAppNavigation } from '../security';
import type { Logger } from '../logger';

/**
 * Registers the `table-export:*` IPC surface: the `format_table` message
 * gutter's **Export** action (`save-csv`) and the **Open in folder** reveal of
 * the file it wrote (`reveal-last`). The renderer serializes the table (it holds
 * the rendered columns/rows and owns the CSV rules); this handler owns the three
 * privileged steps - the OS save dialog, the file write, and handing the written
 * file to the OS file manager - so no path or file content is ever derived from
 * model output, and the renderer can only suggest a *name*. `reveal-last` takes
 * no payload: the path is the one this module already wrote.
 *
 * The sender-trust check below is deliberately re-declared rather than imported
 * from `ipc/browser.ts`, mirroring that module's own stated reason for not
 * importing it from `ipc/settings.ts` either: this file only owns *new* files
 * under `src/main/ipc/`, and duplicating a ~15-line check is a smaller risk
 * than reaching into a file it does not own to export a helper from it.
 *
 * `dialog.showSaveDialog` is called through the `dialog` namespace at call time
 * (never destructured at module load), so an E2E can substitute it in the main
 * process to exercise the real write path with no native dialog.
 */

export interface TableExportIpcSenderInfo {
  readonly url: string;
  readonly isMainFrame: boolean;
  readonly webContentsId: number;
}

export interface TrustedTableExportSenderExpectation {
  /** The app's chat-pane renderer window - the only trusted source for this channel. */
  readonly mainWebContentsId: number;
  readonly rendererDistDir: string;
}

export function isTrustedTableExportIpcSender(
  sender: TableExportIpcSenderInfo | undefined,
  expectation: TrustedTableExportSenderExpectation,
): boolean {
  if (!sender) return false;
  return (
    sender.webContentsId === expectation.mainWebContentsId &&
    sender.isMainFrame &&
    isAllowedAppNavigation(sender.url, expectation.rendererDistDir)
  );
}

function senderInfoFrom(
  event: IpcMainInvokeEvent | IpcMainEvent,
): TableExportIpcSenderInfo | undefined {
  const frame = event.senderFrame;
  if (!frame) return undefined;
  return { url: frame.url, isMainFrame: frame.top === frame, webContentsId: event.sender.id };
}

export interface TableExportIpcDependencies {
  readonly parentWindow: BrowserWindow;
  readonly logger: Logger;
  readonly rendererDistDir: string;
  readonly mainWebContentsId: number;
}

/** The shared `{ ok: false, error }` shape both channels' results use. */
type TableExportIpcFailure = Extract<TableExportSaveCsvResult, { readonly ok: false }>;

function failure(code: TableExportErrorCode, message: string): TableExportIpcFailure {
  return { ok: false, error: { code, message } };
}

export function registerTableExportIpcHandlers(deps: TableExportIpcDependencies): void {
  const expectation: TrustedTableExportSenderExpectation = {
    mainWebContentsId: deps.mainWebContentsId,
    rendererDistDir: deps.rendererDistDir,
  };

  // The file the last successful export wrote. Kept in main and never sent to
  // the renderer, so the "Open in folder" reveal can only ever point at a file
  // the user chose in the save dialog - the same rule as
  // `agent-chat:reveal-journal`.
  let lastExportedPath: string | undefined;

  ipcMain.handle(
    TABLE_EXPORT_SAVE_CSV_CHANNEL,
    async (event, rawRequest: unknown): Promise<TableExportSaveCsvResult> => {
      if (!isTrustedTableExportIpcSender(senderInfoFrom(event), expectation)) {
        deps.logger.warn('TABLE_EXPORT_IPC_SENDER_REJECTED');
        return failure('untrusted_sender', 'This request must come from the local app window');
      }
      const parsed = tableExportSaveCsvRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return failure('invalid_payload', 'The export request was not valid');
      }

      const chosen = await dialog.showSaveDialog(deps.parentWindow, {
        defaultPath: parsed.data.suggestedFileName,
        filters: [{ name: 'CSV file', extensions: ['csv'] }],
      });
      if (chosen.canceled || chosen.filePath === undefined || chosen.filePath === '') {
        // The user closed the dialog: an ordinary outcome, never an error.
        return { ok: true, saved: false };
      }

      try {
        await writeFile(chosen.filePath, parsed.data.content, 'utf8');
      } catch {
        // No path, and no error message text, is logged or shown - only that a
        // write failed (the logger's own no-free-text rule).
        deps.logger.error('TABLE_EXPORT_FAILED', { outcome: 'failure' });
        dialog.showErrorBox('Export failed', 'The CSV file could not be written.');
        return failure('write_failed', 'The CSV file could not be written');
      }
      lastExportedPath = chosen.filePath;
      return { ok: true, saved: true, fileName: basename(chosen.filePath) };
    },
  );

  ipcMain.handle(TABLE_EXPORT_REVEAL_LAST_CHANNEL, (event): TableExportRevealResult => {
    if (!isTrustedTableExportIpcSender(senderInfoFrom(event), expectation)) {
      deps.logger.warn('TABLE_EXPORT_IPC_SENDER_REJECTED');
      return failure('untrusted_sender', 'This request must come from the local app window');
    }
    if (lastExportedPath === undefined) {
      return failure('nothing_to_reveal', 'No exported file to show yet');
    }
    try {
      shell.showItemInFolder(lastExportedPath);
    } catch {
      deps.logger.error('TABLE_EXPORT_REVEAL_FAILED', { outcome: 'failure' });
      return failure('reveal_failed', 'The exported file could not be shown');
    }
    return { ok: true };
  });
}
