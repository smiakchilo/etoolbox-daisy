import { type ToolModule } from '../../shared';
import {
  FORMAT_TABLE_ALLOWLIST_ENTRY,
  FORMAT_TABLE_TOOL_DESCRIPTOR,
  FORMAT_TABLE_TOOL_NAME,
  createFormatTableExecutor,
} from './formatTable';

/** The plugin manifest the main-process registry discovers. Delete this folder to remove the tool. */
export const tool: ToolModule = {
  name: FORMAT_TABLE_TOOL_NAME,
  descriptor: FORMAT_TABLE_TOOL_DESCRIPTOR,
  allowlistEntry: FORMAT_TABLE_ALLOWLIST_ENTRY,
  instructions:
    "The 'format_table' tool presents results as the chat's own table. It renders an assistant " +
    'message, not a call line, so nothing it is given is shown as raw JSON. After a search, ' +
    'call it with the JSON you already have as `data` (an array of rows, or the whole ' +
    '`aem_query` result which carries a `rows` array) and pass that JSON verbatim - do not ' +
    'reformat, rename, or pre-render anything. Use `mode: "new"` for the first page and ' +
    '`mode: "append"` to add a later page to the same table. Do not write Markdown tables ' +
    'yourself when this tool is available.',
  createExecutor: (host) => createFormatTableExecutor(host),
};
