import type { Page } from '@playwright/test';
import type {
  AgentChatByIdRequest,
  AgentChatStatus,
  BrowserIpcVoidResult,
  DaisyAppApi,
} from '../../../src/shared';

// The specs' tsconfig has no DOM lib, so `window.daisy` is reached through
// `globalThis`; the callbacks below run in the renderer, not in Node.
interface DaisyGlobal {
  readonly daisy: DaisyAppApi;
}

/** The chat service's live status, as the renderer sees it. */
export function readChatStatus(shell: Page): Promise<AgentChatStatus> {
  return shell.evaluate(() => (globalThis as unknown as DaisyGlobal).daisy.agentChat.getStatus());
}

/** The supported programmatic host switch (the same call the hosts picker makes). */
export function switchServer(shell: Page, serverId: string): Promise<BrowserIpcVoidResult> {
  return shell.evaluate(
    (id) => (globalThis as unknown as DaisyGlobal).daisy.browser.switchServer(id),
    serverId,
  );
}

/** The app's own single-chat delete: stops the chat, removes its SDK sessions and its journal. */
export async function deleteConversation(shell: Page, chatId: string): Promise<boolean> {
  const result = await shell.evaluate(
    (id) =>
      (globalThis as unknown as DaisyGlobal).daisy.agentChat.deleteConversation({
        chatId: id,
      } as AgentChatByIdRequest),
    chatId,
  );
  return result.ok;
}
