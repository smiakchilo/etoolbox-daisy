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
    "The 'browser_navigate' tool opens a page in the browser pane on a configured host. Name " +
    'the host with its label (learn the labels with environment_facts) or omit it to use the ' +
    "host the pane is on; pass the verbatim browser path, beginning with '/'. Use it once you " +
    'have resolved the page a user asked for - by name, title or path - and never to reach AEM ' +
    'by any route other than a normal page load.',
  createExecutor: (host) => createBrowserNavigateExecutor(host),
};
