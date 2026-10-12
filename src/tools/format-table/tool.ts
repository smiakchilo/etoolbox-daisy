import { type ToolModule } from '../../shared';
import {
  FORMAT_TABLE_ALLOWLIST_ENTRY,
  FORMAT_TABLE_TOOL_DESCRIPTOR,
  FORMAT_TABLE_TOOL_NAME,
  createFormatTableExecutor,
} from './formatTable';

/**
 * The plugin manifest the main-process registry discovers. Delete this folder to remove the tool.
 *
 * `internal`: the model never sees this tool. The search composites
 * (`aem_query_format_ask`, `aem_semantic_search`) call it through the
 * tool-to-tool bridge, and its calls still render as the chat's table.
 */
export const tool: ToolModule = {
  name: FORMAT_TABLE_TOOL_NAME,
  descriptor: FORMAT_TABLE_TOOL_DESCRIPTOR,
  allowlistEntry: FORMAT_TABLE_ALLOWLIST_ENTRY,
  internal: true,
  // Never composed into the session prompt (the tool is internal); kept for the contract.
  instructions: "The internal 'format_table' tool paints the search composites' result table.",
  createExecutor: (host) => createFormatTableExecutor(host),
};
