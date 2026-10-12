import { type ModelToolModule } from '../../shared';
import {
  ASK_USER_ALLOWLIST_ENTRY,
  ASK_USER_TOOL_DESCRIPTOR,
  ASK_USER_TOOL_NAME,
  createAskUserExecutor,
} from './askUser';

/** The plugin manifest the main-process registry discovers. Delete this folder to remove the tool. */
export const tool: ModelToolModule = {
  name: ASK_USER_TOOL_NAME,
  descriptor: ASK_USER_TOOL_DESCRIPTOR,
  allowlistEntry: ASK_USER_ALLOWLIST_ENTRY,
  instructions:
    "The 'ask_user' tool puts a multiple-choice or free-text question to the user and waits " +
    'for their answer. Use it when the user must choose an option to continue (which page, ' +
    'which variant, yes/no) rather than guessing or listing every possibility. Provide ' +
    '`options` for a choice, `multiple: true` to allow several, and/or `freeInput: true` to ' +
    'also accept a typed answer. To offer one-click buttons instead of a text field, pass ' +
    "`actions` (e.g. ['Load more']); one click answers immediately. The user\u2019s answer " +
    'returns as the tool result.',
  createExecutor: (host) => createAskUserExecutor(host),
};
