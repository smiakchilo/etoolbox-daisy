import type { ChatJournal } from '../../src/main/chatJournal';

/** One call a controller made on its chat journal. */
export interface JournalCall {
  readonly method: string;
  readonly args: unknown;
}

/** A `ChatJournal` that writes nothing and records every call, in order. */
export function createRecordingJournal(): { journal: ChatJournal; calls: JournalCall[] } {
  const calls: JournalCall[] = [];
  const journal: ChatJournal = {
    openChat: (params) => calls.push({ method: 'openChat', args: params }),
    recordUserPrompt: (params) => calls.push({ method: 'recordUserPrompt', args: params }),
    discardUserPrompt: (chatId, turnId) =>
      calls.push({ method: 'discardUserPrompt', args: { chatId, turnId } }),
    recordEvent: (event) => calls.push({ method: 'recordEvent', args: event }),
    recordInterruption: (params) => calls.push({ method: 'recordInterruption', args: params }),
    closeChat: (chatId) => calls.push({ method: 'closeChat', args: chatId }),
    getHealth: () => ({ writeFailureCount: 0, droppedRecordCount: 0, lastFailureCode: null }),
  };
  return { journal, calls };
}

/** The journal methods called, in order. */
export function methods(calls: readonly JournalCall[]): string[] {
  return calls.map((call) => call.method);
}
