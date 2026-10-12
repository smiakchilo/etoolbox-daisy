import { type ToolModule } from '../../shared';
import {
  BROWSER_NAVIGATE_ALLOWLIST_ENTRY,
  BROWSER_NAVIGATE_TOOL_DESCRIPTOR,
  BROWSER_NAVIGATE_TOOL_NAME,
  createBrowserNavigateExecutor,
} from './browserNavigate';

/** The plugin manifest the main-process registry discovers. Delete this folder to remove the tool. */
export const tool: ToolModule = {
  name: BROWSER_NAVIGATE_TOOL_NAME,
  descriptor: BROWSER_NAVIGATE_TOOL_DESCRIPTOR,
  allowlistEntry: BROWSER_NAVIGATE_ALLOWLIST_ENTRY,
  instructions:
    'Opens a page in the browser pane. A page the user names MUST be resolved first: call ' +
    'aem_query and open only the jcr:path it returns - never construct a path from a name ' +
    "('the home page' is not '/content/<site>/us/en'). Name the host with its label (learn the " +
    'labels with environment_facts) or omit it to use the host the pane is on; pass the ' +
    "verbatim browser path, beginning with '/'. A path is acceptable only when the user " +
    'literally wrote it, or when it is the jcr:path of a row aem_query returned in this same ' +
    'turn. Never reach AEM by any route other than a normal page load.',
  createExecutor: (host) => createBrowserNavigateExecutor(host),
};
