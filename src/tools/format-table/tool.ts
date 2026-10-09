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
    'call it with the `aem_query` result exactly as you received it as `data` - do not extract ' +
    'the rows, reformat, rename, or pre-render anything; the tool finds the rows itself. ' +
    '(An array of row objects is also accepted.) ' +
    'Use `mode: "new"` for the first page and ' +
    '`mode: "append"` to add a later page to the same table. Do not write Markdown tables ' +
    'yourself when this tool is available.',
  createExecutor: (host) => createFormatTableExecutor(host),
};
