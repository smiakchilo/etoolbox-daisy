import { type ModelToolModule, MEMO_TOOL_NAME } from '../../shared';
import { MEMO_TOOL_ALLOWLIST_ENTRY, MEMO_TOOL_DESCRIPTOR, createMemoExecutor } from './memo';

/** The plugin manifest the main-process registry discovers. Delete this folder to remove the tool. */
export const tool: ModelToolModule = {
  name: MEMO_TOOL_NAME,
  descriptor: MEMO_TOOL_DESCRIPTOR,
  allowlistEntry: MEMO_TOOL_ALLOWLIST_ENTRY,
  instructions:
    'Writes down a short lesson (a memo) for later conversations, following the memo guidance ' +
    'when it is given. If memo refuses because self-learning is switched off, say so once and ' +
    'do not retry.',
  createExecutor: (host) => createMemoExecutor(host),
};
