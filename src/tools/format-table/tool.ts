import { type ModelToolModule } from '../../shared';
import {
  FORMAT_TABLE_ALLOWLIST_ENTRY,
  FORMAT_TABLE_TOOL_DESCRIPTOR,
  FORMAT_TABLE_TOOL_NAME,
  createFormatTableExecutor,
} from './formatTable';

/**
 * The plugin manifest the main-process registry discovers. Delete this folder to
 * remove the table.
 *
 * The model can call it - a skill shows its own findings as a table - and the
 * search composites (`aem_query_format_ask`, `aem_semantic_search`) call it
 * through the tool-to-tool bridge. Either way its calls render as the chat's
 * table, never as a billet.
 */
export const tool: ModelToolModule = {
  name: FORMAT_TABLE_TOOL_NAME,
  descriptor: FORMAT_TABLE_TOOL_DESCRIPTOR,
  allowlistEntry: FORMAT_TABLE_ALLOWLIST_ENTRY,
  instructions:
    "The 'format_table' tool shows rows to the user as a table in the chat, with named, " +
    'optionally status-coloured columns. Use it to present your own findings or any list of ' +
    'records with several fields; do not write such data as a markdown table. The search ' +
    'tools already present their own results, so do not repeat those.',
  createExecutor: (host) => createFormatTableExecutor(host),
};
