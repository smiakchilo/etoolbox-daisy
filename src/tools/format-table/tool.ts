import { type InternalToolModule } from '../../shared';
import { FORMAT_TABLE_TOOL_NAME, createFormatTableExecutor } from './formatTable';

/**
 * The plugin manifest the main-process registry discovers. Delete this folder to
 * remove the table.
 *
 * `internal`: the model never sees this tool. The search composites
 * (`aem_query_format_ask`, `aem_semantic_search`) call it through the
 * tool-to-tool bridge, and its calls still render as the chat's table. Because
 * the model never sees it, it declares no descriptor, allowlist entry or
 * instructions - only the name and its executor.
 */
export const tool: InternalToolModule = {
  name: FORMAT_TABLE_TOOL_NAME,
  internal: true,
  createExecutor: (host) => createFormatTableExecutor(host),
};
