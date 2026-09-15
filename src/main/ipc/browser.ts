import { ipcMain, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron';
import {
  BROWSER_APPROVE_CERTIFICATE_EXCEPTION_CHANNEL,
  BROWSER_GO_BACK_CHANNEL,
  BROWSER_GO_FORWARD_CHANNEL,
  BROWSER_NAVIGATE_CHANNEL,
  BROWSER_RELOAD_CHANNEL,
  BROWSER_REVOKE_CERTIFICATE_EXCEPTION_CHANNEL,
  BROWSER_SET_VIEW_BOUNDS_CHANNEL,
  BROWSER_SWITCH_SERVER_CHANNEL,
} from '../../shared/ipc-channels';
import {
  approveCertificateExceptionRequestSchema,
  navigateRequestSchema,
  revokeCertificateExceptionRequestSchema,
  switchServerRequestSchema,
  viewBoundsSchema,
  type BrowserIpcVoidResult,
} from '../../shared/browser-ipc';
import { isAllowedAppNavigation } from '../security';
import type { Logger } from '../logger';
import type { BrowserController } from '../browser/browserController';

/**
 * Registers the `browser:*` IPC surface (implementation-plan.md step 05).
 * Mirrors `src/main/ipc/settings.ts`'s sender-trust pattern deliberately
 * re-declared here rather than imported: this module only owns *new* files
 * under `src/main/ipc/`, and duplicating ~15 lines of a trust check is a far
 * smaller risk than reaching into a file it does not own to export a helper
 * from it.
 */

export interface BrowserIpcSenderInfo {
  readonly url: string;
  readonly isMainFrame: boolean;
  readonly webContentsId: number;
}

export interface TrustedBrowserSenderExpectation {
  /** The app's chat-pane renderer window - the only trusted source for these channels. */
  readonly mainWebContentsId: number;
  readonly rendererDistDir: string;
}

export function isTrustedBrowserIpcSender(
  sender: BrowserIpcSenderInfo | undefined,
  expectation: TrustedBrowserSenderExpectation,
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
): BrowserIpcSenderInfo | undefined {
  const frame = event.senderFrame;
  if (!frame) return undefined;
  return { url: frame.url, isMainFrame: frame.top === frame, webContentsId: event.sender.id };
}

const UNTRUSTED_SENDER_RESULT: BrowserIpcVoidResult = {
  ok: false,
  error: { code: 'untrusted_sender', message: 'This request must come from the local app window.' },
};

function invalidPayloadResult(message: string): BrowserIpcVoidResult {
  return { ok: false, error: { code: 'invalid_payload', message } };
}

export interface BrowserIpcDependencies {
  readonly controller: BrowserController;
  readonly logger: Logger;
  readonly rendererDistDir: string;
  readonly mainWebContentsId: number;
}

/**
 * Registers every `browser:*` handler. `browser:set-view-bounds` is
 * deliberately `ipcMain.on` (fire-and-forget), not `.handle`: it fires on
 * every renderer resize via a `ResizeObserver` (`browserViewHost.ts`), and a
 * round-trip reply the renderer never reads would be pure overhead. Every
 * other channel is a `.handle` request/response, matching `ipc/settings.ts`.
 */
export function registerBrowserIpcHandlers(deps: BrowserIpcDependencies): void {
  const expectation: TrustedBrowserSenderExpectation = {
    mainWebContentsId: deps.mainWebContentsId,
    rendererDistDir: deps.rendererDistDir,
  };

  function checkSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
    const trusted = isTrustedBrowserIpcSender(senderInfoFrom(event), expectation);
    if (!trusted) {
      deps.logger.warn('BROWSER_IPC_SENDER_REJECTED');
    }
    return trusted;
  }

  ipcMain.handle(BROWSER_GO_BACK_CHANNEL, (event): BrowserIpcVoidResult => {
    if (!checkSender(event)) return UNTRUSTED_SENDER_RESULT;
    return deps.controller.goBack();
  });

  ipcMain.handle(BROWSER_GO_FORWARD_CHANNEL, (event): BrowserIpcVoidResult => {
    if (!checkSender(event)) return UNTRUSTED_SENDER_RESULT;
    return deps.controller.goForward();
  });

  ipcMain.handle(BROWSER_RELOAD_CHANNEL, (event): BrowserIpcVoidResult => {
    if (!checkSender(event)) return UNTRUSTED_SENDER_RESULT;
    return deps.controller.reload();
  });

  ipcMain.handle(
    BROWSER_NAVIGATE_CHANNEL,
    async (event, rawRequest: unknown): Promise<BrowserIpcVoidResult> => {
      if (!checkSender(event)) return UNTRUSTED_SENDER_RESULT;
      const parsed = navigateRequestSchema.safeParse(rawRequest);
      if (!parsed.success) return invalidPayloadResult(parsed.error.message);
      return deps.controller.navigate(parsed.data.value);
    },
  );

  ipcMain.handle(
    BROWSER_SWITCH_SERVER_CHANNEL,
    async (event, rawRequest: unknown): Promise<BrowserIpcVoidResult> => {
      if (!checkSender(event)) return UNTRUSTED_SENDER_RESULT;
      const parsed = switchServerRequestSchema.safeParse(rawRequest);
      if (!parsed.success) return invalidPayloadResult(parsed.error.message);
      return deps.controller.switchServer(parsed.data.serverId);
    },
  );

  ipcMain.handle(
    BROWSER_APPROVE_CERTIFICATE_EXCEPTION_CHANNEL,
    async (event, rawRequest: unknown): Promise<BrowserIpcVoidResult> => {
      if (!checkSender(event)) return UNTRUSTED_SENDER_RESULT;
      const parsed = approveCertificateExceptionRequestSchema.safeParse(rawRequest);
      if (!parsed.success) return invalidPayloadResult(parsed.error.message);
      return deps.controller.approveCertificateException(parsed.data);
    },
  );

  ipcMain.handle(
    BROWSER_REVOKE_CERTIFICATE_EXCEPTION_CHANNEL,
    async (event, rawRequest: unknown): Promise<BrowserIpcVoidResult> => {
      if (!checkSender(event)) return UNTRUSTED_SENDER_RESULT;
      const parsed = revokeCertificateExceptionRequestSchema.safeParse(rawRequest);
      if (!parsed.success) return invalidPayloadResult(parsed.error.message);
      return deps.controller.revokeCertificateException(parsed.data);
    },
  );

  ipcMain.on(BROWSER_SET_VIEW_BOUNDS_CHANNEL, (event, rawRequest: unknown) => {
    if (!checkSender(event)) return;
    const parsed = viewBoundsSchema.safeParse(rawRequest);
    if (!parsed.success) return;
    deps.controller.setViewBounds(parsed.data);
  });
}
