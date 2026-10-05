import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import {
  AGENT_CHAT_ABORT_CHANNEL,
  AGENT_CHAT_CLOSE_CONVERSATION_CHANNEL,
  AGENT_CHAT_EVENT_CHANNEL,
  AGENT_CHAT_GET_STATUS_CHANNEL,
  AGENT_CHAT_LIST_SKILLS_CHANNEL,
  AGENT_CHAT_OPEN_CONVERSATION_CHANNEL,
  AGENT_CHAT_READ_JOURNAL_CHANNEL,
  AGENT_CHAT_SEND_MESSAGE_CHANNEL,
  AGENT_CHAT_STATUS_CHANGED_CHANNEL,
} from '../../shared';
import {
  agentChatByIdRequestSchema,
  agentChatOpenConversationRequestSchema,
  agentChatReadJournalRequestSchema,
  agentChatSendMessageRequestSchema,
  type AgentChatOpenResult,
  type AgentChatReadJournalRequest,
  type AgentChatReadJournalResult,
  type AgentChatSendResult,
  type AgentChatSkillsResult,
  type AgentChatVoidResult,
} from '../../shared';
import { isAllowedAppNavigation } from '../security';
import type { Logger } from '../logger';
import { createAgentChatEventForwarder, type AgentChatController } from '../agentChatController';

/**
 * Registers the `agent-chat:*` IPC surface (implementation-plan.md step 07).
 * Thin by design: every ownership/forwarding rule lives in
 * `agentChatController.ts`, which is unit-tested directly with no Electron
 * runtime. This module only translates `ipcMain`/`sender.send` into calls on
 * that controller - `parseX` at the boundary, sender-trust check first,
 * `sender.isDestroyed()`-guarded push forwarding (`ipc/agent.ts`'s house
 * style).
 *
 * The sender-trust check below is deliberately re-declared rather than
 * imported from `ipc/browser.ts`, mirroring that module's own stated reason
 * for not importing it from `ipc/settings.ts` either: this file only owns
 * *new* files under `src/main/ipc/`, and duplicating a ~15-line check is a
 * smaller risk than reaching into a file it does not own to export a helper
 * from it.
 *
 * `src/main/ipc/agent.ts`'s comment claiming to be "the only place in
 * `src/main` allowed to import `../../agent`" is now false: this module
 * imports `../agentChatController`, which imports `AgentService`/
 * `CurrentAemToolContext` types from `../../agent`. That comment has been
 * corrected there. No ESLint rule enforced the old claim (only
 * `@github/copilot-sdk`/`@github/copilot` imports are restricted, and only
 * to `src/agent/**` - see `eslint.config.mjs`), so nothing but the comment
 * needed to change.
 */

export interface AgentChatIpcSenderInfo {
  readonly url: string;
  readonly isMainFrame: boolean;
  readonly webContentsId: number;
}

export interface TrustedAgentChatSenderExpectation {
  /** The app's chat-pane renderer window - the only trusted source for these channels. */
  readonly mainWebContentsId: number;
  readonly rendererDistDir: string;
}

export function isTrustedAgentChatIpcSender(
  sender: AgentChatIpcSenderInfo | undefined,
  expectation: TrustedAgentChatSenderExpectation,
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
): AgentChatIpcSenderInfo | undefined {
  const frame = event.senderFrame;
  if (!frame) return undefined;
  return { url: frame.url, isMainFrame: frame.top === frame, webContentsId: event.sender.id };
}

const UNTRUSTED_SENDER_ERROR = {
  code: 'ACCESS_DENIED',
  message: 'This request must come from the local app window',
} as const;

function untrustedVoidResult(): AgentChatVoidResult {
  return { ok: false, error: UNTRUSTED_SENDER_ERROR };
}

function untrustedOpenResult(): AgentChatOpenResult {
  return { ok: false, error: UNTRUSTED_SENDER_ERROR };
}

function untrustedSendResult(): AgentChatSendResult {
  return { ok: false, error: UNTRUSTED_SENDER_ERROR };
}

function untrustedReadJournalResult(): AgentChatReadJournalResult {
  return { ok: false, error: UNTRUSTED_SENDER_ERROR };
}

function untrustedSkillsResult(): AgentChatSkillsResult {
  return { ok: false, error: UNTRUSTED_SENDER_ERROR };
}

function invalidPayloadReadJournalResult(message: string): AgentChatReadJournalResult {
  return { ok: false, error: { code: 'INVALID_ARGUMENT', message } };
}

function invalidPayloadVoidResult(message: string): AgentChatVoidResult {
  return { ok: false, error: { code: 'INVALID_ARGUMENT', message } };
}

function invalidPayloadOpenResult(message: string): AgentChatOpenResult {
  return { ok: false, error: { code: 'INVALID_ARGUMENT', message } };
}

function invalidPayloadSendResult(message: string): AgentChatSendResult {
  return { ok: false, error: { code: 'INVALID_ARGUMENT', message } };
}

export interface AgentChatIpcDependencies {
  readonly controller: AgentChatController;
  readonly logger: Logger;
  readonly rendererDistDir: string;
  readonly mainWebContentsId: number;
  /** The chat-pane renderer's own `WebContents` - the sink `agent-chat:event` is pushed to. */
  readonly rendererWebContents: WebContents;
  /**
   * Reads one chat's journal and returns the wire result. Built in the
   * composition root (`index.ts`) so this handler stays free of filesystem and
   * path concerns; a missing/unreadable journal is an `ok: false` result, never
   * a throw.
   */
  readonly readJournal: (request: AgentChatReadJournalRequest) => AgentChatReadJournalResult;
  /**
   * Reads the bundled skill catalogue for the composer's `/` autocomplete.
   * Built in the composition root so this handler stays free of filesystem and
   * path concerns; a missing catalogue is an `ok: false` result, never a throw.
   */
  readonly listSkills: () => Promise<AgentChatSkillsResult>;
}

/**
 * Registers every `agent-chat:*` handler and starts forwarding
 * `AgentEvent`s (and status changes) to `deps.rendererWebContents`. Returns an
 * unsubscribe function that stops both subscriptions (the `ipcMain.handle`
 * registrations themselves live for the app's lifetime, matching
 * `ipc/browser.ts` and `ipc/settings.ts`, neither of which unregisters its
 * handlers either).
 */
export function registerAgentChatIpcHandlers(deps: AgentChatIpcDependencies): () => void {
  const expectation: TrustedAgentChatSenderExpectation = {
    mainWebContentsId: deps.mainWebContentsId,
    rendererDistDir: deps.rendererDistDir,
  };

  function checkSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
    const trusted = isTrustedAgentChatIpcSender(senderInfoFrom(event), expectation);
    if (!trusted) deps.logger.warn('AGENT_CHAT_IPC_SENDER_REJECTED');
    return trusted;
  }

  ipcMain.handle(AGENT_CHAT_GET_STATUS_CHANNEL, (event) => {
    if (!checkSender(event)) {
      throw new Error('This request must come from the local app window');
    }
    return deps.controller.getStatus();
  });

  ipcMain.handle(
    AGENT_CHAT_OPEN_CONVERSATION_CHANNEL,
    async (event, rawRequest: unknown): Promise<AgentChatOpenResult> => {
      if (!checkSender(event)) return untrustedOpenResult();
      const parsed = agentChatOpenConversationRequestSchema.safeParse(rawRequest);
      if (!parsed.success) return invalidPayloadOpenResult(parsed.error.message);
      return deps.controller.openConversation(parsed.data);
    },
  );

  ipcMain.handle(
    AGENT_CHAT_SEND_MESSAGE_CHANNEL,
    async (event, rawRequest: unknown): Promise<AgentChatSendResult> => {
      if (!checkSender(event)) return untrustedSendResult();
      const parsed = agentChatSendMessageRequestSchema.safeParse(rawRequest);
      if (!parsed.success) return invalidPayloadSendResult(parsed.error.message);
      return deps.controller.sendMessage(parsed.data);
    },
  );

  ipcMain.handle(
    AGENT_CHAT_ABORT_CHANNEL,
    async (event, rawRequest: unknown): Promise<AgentChatVoidResult> => {
      if (!checkSender(event)) return untrustedVoidResult();
      const parsed = agentChatByIdRequestSchema.safeParse(rawRequest);
      if (!parsed.success) return invalidPayloadVoidResult(parsed.error.message);
      return deps.controller.abort(parsed.data);
    },
  );

  ipcMain.handle(
    AGENT_CHAT_CLOSE_CONVERSATION_CHANNEL,
    async (event, rawRequest: unknown): Promise<AgentChatVoidResult> => {
      if (!checkSender(event)) return untrustedVoidResult();
      const parsed = agentChatByIdRequestSchema.safeParse(rawRequest);
      if (!parsed.success) return invalidPayloadVoidResult(parsed.error.message);
      return deps.controller.closeConversation(parsed.data);
    },
  );

  ipcMain.handle(
    AGENT_CHAT_READ_JOURNAL_CHANNEL,
    (event, rawRequest: unknown): AgentChatReadJournalResult => {
      if (!checkSender(event)) return untrustedReadJournalResult();
      const parsed = agentChatReadJournalRequestSchema.safeParse(rawRequest);
      if (!parsed.success) return invalidPayloadReadJournalResult(parsed.error.message);
      return deps.readJournal(parsed.data);
    },
  );

  ipcMain.handle(AGENT_CHAT_LIST_SKILLS_CHANNEL, (event): Promise<AgentChatSkillsResult> => {
    if (!checkSender(event)) return Promise.resolve(untrustedSkillsResult());
    return deps.listSkills();
  });

  const unsubscribeEvents = deps.controller.onEvent(
    createAgentChatEventForwarder(deps.rendererWebContents, AGENT_CHAT_EVENT_CHANNEL),
  );
  // A status change is not an `AgentEvent`, so it needs its own push. The
  // renderer's composer gate and its open-conversation bookkeeping both depend
  // on the current status (`auth`, `activeChatId`), and the periodic poll alone
  // leaves them stale for up to its whole interval after a runtime recycle -
  // long enough to send into a conversation main has already torn down.
  const unsubscribeStatus = deps.controller.onStatusChanged(() => {
    if (deps.rendererWebContents.isDestroyed()) return;
    deps.rendererWebContents.send(AGENT_CHAT_STATUS_CHANGED_CHANNEL, deps.controller.getStatus());
  });
  return () => {
    unsubscribeEvents();
    unsubscribeStatus();
  };
}
